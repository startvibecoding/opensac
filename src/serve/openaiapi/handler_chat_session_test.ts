// Translated from internal/serve/openaiapi/server_test.go — the
// getOrCreateSession / AllocateSessionID / capability-patch cluster whose
// Server-bound half lives in handler_chat_session.ts and session_patch.ts. The
// restored-session and creation branches are exercised against real temp
// session roots, matching Go's TestServerGetOrCreateSession* families; the
// agent-construction-heavy branches stay with the run-executor slice tests
// because the test-hygiene guard bars low-level agent construction in adapter
// tests.
import { assert, assertEquals, assertRejects } from "@std/assert";
import { closeAll } from "../../db/mod.ts";
import { createSession } from "../../agentruntime/session_lifecycle.ts";
import type { Model } from "../../provider/types.ts";
import type { Provider } from "../../provider/provider.ts";
import { Server } from "./server.ts";
import { APISession, SessionPool } from "./session_mgr.ts";
import {
  allocateSessionID,
  applyBoolOption,
  claimAllocatedSessionID,
  getOrCreateSession,
} from "./handler_chat_session.ts";
import {
  buildAgentOptionsForSession,
  deleteActiveSession,
  patchSessionCapabilities,
  patchSessionRuntime,
} from "./session_patch.ts";
import { loadStoredCapabilities } from "./session_capabilities.ts";
import type { Config } from "./config.ts";

function tempDir(prefix: string): string {
  return Deno.makeTempDirSync({ prefix });
}

function newTestServer(opts: {
  sessionDir: string;
  workDir: string;
  cfg?: Partial<Config>;
}) {
  const server = new Server({
    settings: { sessionDir: opts.sessionDir } as never,
    cfg: { defaultWorkDir: opts.workDir, ...opts.cfg } as Config,
  });
  server.pool = new SessionPool(0, 0);
  return server;
}

Deno.test("applyBoolOptionCopiesOnlyChangedFlags", () => {
  const sess = new APISession();
  sess.browser = false;
  assertEquals(applyBoolOption(sess, "browser", undefined), false);
  assertEquals(applyBoolOption(sess, "browser", false), false);
  assertEquals(applyBoolOption(sess, "browser", true), true);
  assertEquals(sess.browser, true);
});

Deno.test("allocateSessionIDReservesUniqueIDs", async () => {
  const sessionDir = tempDir("openaiapi-alloc-");
  const server = newTestServer({
    sessionDir,
    workDir: tempDir("openaiapi-alloc-work-"),
  });
  try {
    const first = await allocateSessionID(server);
    const second = await allocateSessionID(server);
    assert(first !== "" && second !== "" && first !== second);
    // A claimed ID can only be consumed once.
    assertEquals(server.allocatedSessionIDs.has(first), true);
    assertEquals(claimAllocatedSessionID(server, first), true);
    assertEquals(claimAllocatedSessionID(server, first), false);
  } finally {
    closeAll();
  }
});

Deno.test("getOrCreateSessionCreatesAndReusesDefaultSession", async () => {
  const sessionDir = tempDir("openaiapi-create-");
  const workDir = tempDir("openaiapi-create-work-");
  const server = newTestServer({ sessionDir, workDir });
  try {
    const sess = await getOrCreateSession(server, "", workDir);
    assert(sess.runtime);
    assert(sess.registry);
    assert(sess.manager);
    assertEquals(sess.workDir, workDir);
    assertEquals(server.defaultSessionIDs.get(workDir), sess.id);
    assertEquals(server.pool?.get(sess.id), sess);

    // A second request for the same workdir reuses the default session.
    const again = await getOrCreateSession(server, "", workDir);
    assertEquals(again, sess);

    // An explicit lookup by ID returns the pooled session.
    const byID = await getOrCreateSession(server, sess.id, workDir);
    assertEquals(byID, sess);
  } finally {
    closeAll();
  }
});

Deno.test("getOrCreateSessionRejectsWorkDirMismatch", async () => {
  const sessionDir = tempDir("openaiapi-mismatch-");
  const workDir = tempDir("openaiapi-mismatch-work-");
  const otherWorkDir = tempDir("openaiapi-mismatch-other-");
  const server = newTestServer({ sessionDir, workDir });
  try {
    const sess = await getOrCreateSession(server, "", workDir);
    const err = await assertRejects(() =>
      getOrCreateSession(server, sess.id, otherWorkDir)
    ) as Error;
    assert(err.message.includes("belongs to a different working directory"));
  } finally {
    closeAll();
  }
});

Deno.test("getOrCreateSessionRestoresPersistedSession", async () => {
  const sessionDir = tempDir("openaiapi-restore-");
  const workDir = tempDir("openaiapi-restore-work-");
  const server = newTestServer({ sessionDir, workDir });
  try {
    const created = createSession({ workDir, sessionDir, id: "" });
    const id = created.getHeader()!.id;
    // The pool starts empty; getOrCreateSession must reassemble the session
    // from the persisted manager.
    const sess = await getOrCreateSession(server, id, workDir);
    assertEquals(sess.id, id);
    assert(sess.runtime);
    assert(sess.registry);
    assert(sess.manager);
    assertEquals(sess.manager!.getHeader()!.id, id);
  } finally {
    closeAll();
  }
});

Deno.test("patchSessionCapabilitiesPersistsAndSyncs", async () => {
  const sessionDir = tempDir("openaiapi-patch-");
  const workDir = tempDir("openaiapi-patch-work-");
  const server = newTestServer({ sessionDir, workDir });
  try {
    const sess = await getOrCreateSession(server, "", workDir);
    assertEquals(sess.browser, false);

    const caps = await patchSessionCapabilities(server, sess.id, {
      browser: true,
      displayMode: "code",
    });
    assertEquals(caps.browser, true);
    assertEquals(caps.displayMode, "code");
    assertEquals(caps.runtimeOnly, false);
    assertEquals(caps.persistenceNote, "");
    assertEquals(sess.browser, true);
    assertEquals(sess.displayMode, "code");

    const { ok } = loadStoredCapabilities(server, sess.id);
    assertEquals(ok, true);

    // The structured runtime patch projects onto a snapshot.
    const snapshot = await patchSessionRuntime(server, sess.id, {
      capabilities: { browser: false },
    });
    assertEquals(snapshot.displayMode, "code");
    assertEquals(snapshot.capabilities["browser"].enabled, false);
    assertEquals(sess.browser, false);
  } finally {
    closeAll();
  }
});

Deno.test("deleteActiveSessionRemovesPoolEntryAndDefaultBinding", async () => {
  const sessionDir = tempDir("openaiapi-delete-");
  const workDir = tempDir("openaiapi-delete-work-");
  const server = newTestServer({ sessionDir, workDir });
  try {
    const sess = await getOrCreateSession(server, "", workDir);
    assertEquals(server.defaultSessionIDs.get(workDir), sess.id);

    assertEquals(await deleteActiveSession(server, sess.id), true);
    assertEquals(server.pool?.get(sess.id), undefined);
    assertEquals(server.defaultSessionIDs.has(workDir), false);

    // Deleting an unknown ID reports not-found rather than throwing.
    assertEquals(await deleteActiveSession(server, "missing-id"), false);
  } finally {
    closeAll();
  }
});

Deno.test("buildAgentOptionsForSessionCarriesSessionState", () => {
  const workDir = tempDir("openaiapi-buildopts-");
  const server = new Server({
    cfg: {
      defaultWorkDir: workDir,
      defaultThinkingLevel: "high",
      enableDelegate: true,
    },
    provider: {} as Provider,
    providerName: "test-provider",
    model: { id: "m1" } as Model,
    extraContext: "server context",
    allow: { commands: [], tools: {} } as never,
  });
  const sess = new APISession();
  sess.id = "s1";
  sess.workDir = workDir;
  sess.multiAgent = true;
  sess.ruleContent = "session rules";

  const opts = buildAgentOptionsForSession(server, sess, server.model!, "yolo");
  assertEquals(opts.model?.id, "m1");
  assertEquals(opts.providerName, "test-provider");
  assertEquals(opts.mode, "yolo");
  assertEquals(opts.multiAgent, true);
  assertEquals(opts.delegateMode, false);
  assertEquals(opts.ruleContent, "session rules");
  assertEquals(opts.extraContext, "server context");
  assertEquals(opts.maxTokensSet, true);
  assertEquals(opts.thinkingLevel, "high");
  assert(typeof opts.getSteeringMessages === "function");
  // No ESM objective persisted for this session: no steering messages.
  assertEquals(opts.getSteeringMessages!().length, 0);
  // The session's own context wins over the server default.
  sess.extraContext = "session context";
  const opts2 = buildAgentOptionsForSession(server, sess, server.model!, "");
  assertEquals(opts2.extraContext, "session context");
});
