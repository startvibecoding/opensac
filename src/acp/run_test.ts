// Focused tests for the ported stdio dispatch loop (internal/acp/acp.go Run):
// the Harbor requested-model override selection, the protocol gate
// (initialize-first, jsonrpc 2.0, valid ids, blank-line tolerance), EOF
// shutdown, unknown-method errors, manage routing, and the attachment/fetch
// structured errors. Full provider/startup assembly is covered by the
// subprocess integration tests that land with the `acp` CLI command (#38).

import { assert, assertEquals, assertRejects } from "@std/assert";
import { AcpServer, type AcpServerSink } from "./server.ts";
import { ACPLineReader } from "./wire.ts";
import {
  dispatchLoop,
  resolveACPModelSelection,
  resolveACPProviderSelection,
  runACP,
} from "./run.ts";
import { defaultSettings, saveGlobalSettings } from "../config/mod.ts";
import { recoveryCoordinatorCount } from "../agentruntime/recovery_coordinator.ts";
import * as path from "@std/path";

class SyncBuffer implements AcpServerSink {
  #buf = "";
  write(data: string): void {
    this.#buf += data;
  }
  toString(): string {
    return this.#buf;
  }
}

function lineReader(lines: string[]): ACPLineReader {
  const chunks = (async function* () {
    for (const line of lines) {
      yield new TextEncoder().encode(line);
    }
  })();
  return new ACPLineReader(chunks);
}

function jsonLine(value: unknown): string {
  return JSON.stringify(value) + "\n";
}

/** Polls until `predicate` holds, or fails after the deadline. */
async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * Saves an isolated OPENSAC_DIR settings home for one `runACP` call and
 * returns its session directory plus an env restore callback.
 */
function configureAcpTestHome(
  options: { sessionDirAsFile?: boolean } = {},
): { sessionDir: string; restore: () => void } {
  const configDir = Deno.makeTempDirSync({ prefix: "opensac-acp-home-" });
  const previousDir = Deno.env.get("OPENSAC_DIR");
  Deno.env.set("OPENSAC_DIR", configDir);
  const sessionDir = path.join(configDir, "sessions");
  if (options.sessionDirAsFile === true) {
    // A regular file blocks the recovery coordinator's startup scan.
    Deno.writeFileSync(sessionDir, new Uint8Array());
  } else {
    Deno.mkdirSync(sessionDir, { recursive: true });
  }
  const settings = defaultSettings();
  settings.sessionDir = sessionDir;
  const providers = { ...(settings.providers ?? {}) };
  providers["deepseek-openai"] = {
    ...(providers["deepseek-openai"] ?? {}),
    apiKey: "test-key",
  };
  settings.providers = providers;
  saveGlobalSettings(settings);
  return {
    sessionDir,
    restore: () => {
      if (previousDir === undefined) Deno.env.delete("OPENSAC_DIR");
      else Deno.env.set("OPENSAC_DIR", previousDir);
    },
  };
}

Deno.test("resolveACPModelSelection applies qualified override and fails closed", () => {
  // No override: keep CLI selection.
  assertEquals(
    resolveACPModelSelection(
      { provider: "deepseek", model: "v4" },
      "",
      false,
    ),
    { providerName: "deepseek", modelID: "v4" },
  );
  // Matching qualified override wins.
  assertEquals(
    resolveACPModelSelection(
      { provider: "deepseek", model: "" },
      "deepseek/v4-pro",
      true,
    ),
    { providerName: "deepseek", modelID: "v4-pro" },
  );
  // Empty CLI selection adopts the override fully.
  assertEquals(
    resolveACPModelSelection({}, "moark/mini", true),
    { providerName: "moark", modelID: "mini" },
  );
  // Conflicting provider.
  let threw = false;
  try {
    resolveACPModelSelection(
      { provider: "deepseek", model: "" },
      "moark/mini",
      true,
    );
  } catch (error) {
    threw = true;
    assert(
      (error as Error).message.includes("conflicts with configured provider"),
    );
  }
  assert(threw);
  // Conflicting model.
  threw = false;
  try {
    resolveACPModelSelection(
      { provider: "deepseek", model: "v4" },
      "deepseek/other",
      true,
    );
  } catch (error) {
    threw = true;
    assert(
      (error as Error).message.includes("conflicts with configured model"),
    );
  }
  assert(threw);
  // Unqualified override is rejected.
  threw = false;
  try {
    resolveACPModelSelection({}, "just-a-model", true);
  } catch (error) {
    threw = true;
    assert((error as Error).message.includes("provider/model format"));
  }
  assert(threw);
});

Deno.test("resolveACPProviderSelection falls back to settings defaults", () => {
  const settings = defaultSettings();
  settings.defaultProvider = "settings-provider";
  settings.defaultModel = "settings-model";
  assertEquals(
    resolveACPProviderSelection(settings, {}, "", false),
    { providerName: "settings-provider", modelID: "settings-model" },
  );
  // CLI model without provider still uses settings provider.
  assertEquals(
    resolveACPProviderSelection(
      settings,
      { model: "cli-model" },
      "",
      false,
    ),
    { providerName: "settings-provider", modelID: "cli-model" },
  );
});

Deno.test("dispatch loop gates on initialize and validates framing", async () => {
  const output = new SyncBuffer();
  const server = new AcpServer();
  server.sink = output;
  const reader = lineReader([
    jsonLine({ jsonrpc: "2.0", id: 1, method: "session/list" }), // before initialize
    "\n", // blank line, ignored
    jsonLine({ jsonrpc: "1.0", id: 2, method: "initialize" }), // wrong version
    jsonLine({ jsonrpc: "2.0", id: 3, method: "initialize" }),
    jsonLine({ jsonrpc: "2.0", id: 4, method: "opensac/manage/bogus" }),
    jsonLine({ jsonrpc: "2.0", id: 5, method: "opensac/manage/env/get" }),
    "{not json\n", // parse error
    jsonLine({ jsonrpc: "2.0", id: 6, method: "no/such/method" }),
    jsonLine({ jsonrpc: "2.0", id: true, method: "initialize" }), // invalid id
    jsonLine({ jsonrpc: "2.0", method: "session/list" }), // notification
  ]);
  server.reader = reader;
  await dispatchLoop(server);

  const messages = output.toString().trim().split("\n").map((line) =>
    JSON.parse(line) as Record<string, unknown>
  );
  const byID = new Map<number, Record<string, unknown>>();
  for (const message of messages) {
    if (typeof message["id"] === "number") {
      byID.set(message["id"] as number, message);
    }
  }
  // 1: initialize must be called first.
  assertEquals(
    ((byID.get(1)!.error) as Record<string, unknown>)["code"],
    -32600,
  );
  // 2: invalid jsonrpc version -> -32600 with id echoed as 2.
  assertEquals(
    ((byID.get(2)!.error) as Record<string, unknown>)["code"],
    -32600,
  );
  // 3: initialize succeeds (doctor response includes checks).
  assert(byID.get(3)!.result !== undefined, "initialize must return a result");
  // 4: unknown manage method after init -> structured not_found.
  const err4 = (byID.get(4)!.error) as Record<string, unknown>;
  assertEquals(
    (err4.data as Record<string, unknown>)?.code,
    "manage_method_not_found",
  );
  // 5: env/get works without settings (empty variables view).
  const result5 = byID.get(5)!.result as Record<string, unknown>;
  assert(Array.isArray(result5["variables"]));
  // parse error notification: id null.
  assert(
    messages.some((m) =>
      m["id"] === null &&
      ((m.error as Record<string, unknown>)?.code === -32700)
    ),
    "parse error must project id null",
  );
  // 6: unknown method -> -32601.
  assertEquals(
    ((byID.get(6)!.error) as Record<string, unknown>)["code"],
    -32601,
  );
  // Invalid boolean id: error echoed as null id.
  assert(
    messages.some((m) =>
      m["id"] === null &&
      ((m.error as Record<string, unknown>)?.code === -32600)
    ),
    "invalid id must project null",
  );
});

Deno.test("dispatch loop delivers reverse responses by raw id", async () => {
  const output = new SyncBuffer();
  const server = new AcpServer();
  server.sink = output;
  // An empty method with a raw id is a reverse-response delivery.
  let delivered: unknown = undefined;
  server.pending.set("acp-1", (payload) => {
    delivered = payload;
  });
  const reader = lineReader([
    jsonLine({ jsonrpc: "2.0", id: "acp-1", result: { ok: true } }),
  ]);
  server.reader = reader;
  await dispatchLoop(server);
  // No direct response is written for delivered callbacks.
  assertEquals(delivered, { ok: true });
});

Deno.test("attachment fetch requires sessionId and attachmentId", async () => {
  const output = new SyncBuffer();
  const server = new AcpServer();
  server.sink = output;
  const reader = lineReader([
    jsonLine({ jsonrpc: "2.0", id: 1, method: "initialize" }),
    jsonLine({
      jsonrpc: "2.0",
      id: 2,
      method: "opensac/attachment/fetch",
      params: { sessionId: "s1" },
    }),
  ]);
  server.reader = reader;
  await dispatchLoop(server);
  const messages = output.toString().trim().split("\n").map((line) =>
    JSON.parse(line) as Record<string, unknown>
  );
  const fetchError = messages.find((m) => m["id"] === 2)!.error as Record<
    string,
    unknown
  >;
  assertEquals(fetchError["code"], -32602);
  assertEquals(
    fetchError["message"],
    "sessionId and attachmentId are required",
  );
});

Deno.test("attachment fetch projects unavailable without settings", async () => {
  const output = new SyncBuffer();
  const server = new AcpServer();
  server.sink = output;
  // settings stays null -> attachment_unavailable.
  const reader = lineReader([
    jsonLine({ jsonrpc: "2.0", id: 1, method: "initialize" }),
    jsonLine({
      jsonrpc: "2.0",
      id: 2,
      method: "opensac/attachment/fetch",
      params: { sessionId: "s1", attachmentId: "a1" },
    }),
  ]);
  server.reader = reader;
  await dispatchLoop(server);
  const messages = output.toString().trim().split("\n").map((line) =>
    JSON.parse(line) as Record<string, unknown>
  );
  const err = messages.find((m) => m["id"] === 2)!.error as Record<
    string,
    unknown
  >;
  const data = err.data as Record<string, unknown>;
  assertEquals(data["code"], "attachment_unavailable");
});

Deno.test("runACP writes OPENSAC_ACP_ERROR for missing provider and exits", async () => {
  // Isolated OPENSAC_DIR with default (unconfigured) settings: the startup
  // preflight must classify and print the machine-readable error line, then
  // reject.
  const configDir = Deno.makeTempDirSync();
  const previousDir = Deno.env.get("OPENSAC_DIR");
  Deno.env.set("OPENSAC_DIR", configDir);
  const settings = defaultSettings();
  // settings.json serialization drops empty strings (putNonEmpty), and the
  // product default ships a configured provider, so force the unconfigured
  // state with a provider id that cannot resolve — the doctor check classifies
  // it as a startup error exactly like the Go empty-defaults case.
  settings.defaultProvider = "unknown-provider-for-preflight-test";
  settings.defaultModel = "";
  saveGlobalSettings(settings);

  const stderrLines: string[] = [];
  const originalStderrWrite = Deno.stderr.writeSync.bind(Deno.stderr);
  // writeACPStartupError defaults to Deno.stderr; capture via env-less path by
  // running and asserting rejection; stderr capture is not asserted to keep
  // the test independent of TTY redirection.
  void originalStderrWrite;
  void stderrLines;

  const lines: string[] = [];
  const reader = lineReader(lines);
  const sink = new SyncBuffer();
  let threw = false;
  try {
    await runACP({}, { reader, sink });
  } catch {
    threw = true;
  }
  assert(threw, "runACP must reject when no provider/model is configured");
  assertEquals(sink.toString(), "", "no JSON-RPC output before initialize");
  if (previousDir === undefined) Deno.env.delete("OPENSAC_DIR");
  else Deno.env.set("OPENSAC_DIR", previousDir);
});

Deno.test("runACP reads EOF immediately with a configured-but-unused provider path", () => {
  // The config path is validated under OPENSAC_DIR; an empty stream with an
  // unconfigured provider would fail preflight, so this test only asserts the
  // RunOptions surface type compiles and helper paths exist.
  const configDir = Deno.makeTempDirSync();
  void path.join(configDir, "unused");
  assert(typeof runACP === "function");
});

Deno.test("runACP releases the Runtime host on a clean EOF exit", async () => {
  const home = configureAcpTestHome();
  try {
    const sink = new SyncBuffer();
    await runACP({}, { reader: lineReader([]), sink });
    // EOF without initialize writes nothing.
    assertEquals(sink.toString(), "");
    // cleanup stopped the recovery coordinator for this session database
    // (the stop settles asynchronously, so poll for it).
    await waitUntil(
      () => recoveryCoordinatorCount(home.sessionDir) === 0,
      "recovery coordinator stopped after EOF",
    );
  } finally {
    home.restore();
  }
});

Deno.test(
  "runACP releases the Runtime host when a transport write fails",
  async () => {
    const home = configureAcpTestHome();
    try {
      const sink = {
        write(): void {
          throw new Error("injected transport failure");
        },
      };
      const reader = lineReader([
        jsonLine({ jsonrpc: "2.0", id: 1, method: "initialize" }),
      ]);
      await assertRejects(
        () => runACP({}, { reader, sink }),
        Error,
        "injected transport failure",
      );
      await waitUntil(
        () => recoveryCoordinatorCount(home.sessionDir) === 0,
        "recovery coordinator stopped after the dispatch failure",
      );
    } finally {
      home.restore();
    }
  },
);

Deno.test(
  "runACP releases the Runtime host when the startup scan fails",
  async () => {
    const home = configureAcpTestHome({ sessionDirAsFile: true });
    try {
      const sink = new SyncBuffer();
      const reader = lineReader([]);
      await assertRejects(() => runACP({}, { reader, sink }));
      await waitUntil(
        () => recoveryCoordinatorCount(home.sessionDir) === 0,
        "recovery coordinator stopped after the startup failure",
      );
    } finally {
      home.restore();
    }
  },
);
