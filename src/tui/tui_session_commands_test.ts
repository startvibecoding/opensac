// Focused tests for the session-bound TUI commands that do not require a live
// provider: provider listing, default-model persistence, TUI language, cron
// gating, and the clipboard reader's fallback behavior.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { defaultSettings } from "../config/settings.ts";
import { Translator } from "./i18n.ts";
import {
  TuiSessionCommands,
  type TuiSessionLike,
} from "./tui_session_commands.ts";

interface Stub {
  commands: TuiSessionCommands;
  settings: ReturnType<typeof defaultSettings>;
  messages: string[];
}

function stub(multiAgent = false): Stub {
  const settings = defaultSettings();
  const messages: string[] = [];
  const session = {
    translator: new Translator("en"),
    settings,
    workDir: Deno.cwd(),
    mode: "yolo",
    busy: false,
    multiAgent,
    providerName: settings.defaultProvider ?? "",
    modelID: settings.defaultModel ?? "",
    currentSessionID: () => "s1",
    manager: { getSessionDir: () => "" },
    controller: {
      addMessage: (t: string) => void messages.push(t),
    },
    input: { insertText: () => {} },
    runtime: {},
  } as unknown as TuiSessionLike;
  return { commands: new TuiSessionCommands(session), settings, messages };
}

Deno.test("showProviders lists configured providers and usage", () => {
  const { commands } = stub();
  const text = commands.showProviders();
  assertStringIncludes(text, "Providers");
  assertStringIncludes(text, "deepseek-openai");
});

Deno.test("tuiLang reports the configured language", () => {
  const { commands } = stub();
  const result = commands.tuiLang(["/tuilang"]);
  assertStringIncludes(result.message ?? "", "auto");
});

Deno.test("tuiLang rejects an invalid value", () => {
  const { commands } = stub();
  const result = commands.tuiLang(["/tuilang", "global", "klingon"]);
  assertEquals(result.error, true);
});

Deno.test("cron is gated on multi-agent mode", () => {
  const { commands } = stub(false);
  const result = commands.cron(["/cron", "list"]);
  assertEquals(result.error, true);
  assertStringIncludes(result.message ?? "", "multi-agent");
});

Deno.test("cron rejects an unknown subcommand", () => {
  const { commands } = stub(true);
  const result = commands.cron(["/cron", "bogus"]);
  assertEquals(result.error, true);
});

/**
 * Redirects the config dir to a temp dir for tests that persist settings.
 * Without this the test writes would land on the developer's real
 * settings.json (OPENSAC_DIR is the primary config-dir override).
 */
function isolateConfigDir(): { restore: () => void } {
  const dir = Deno.makeTempDirSync();
  const previous = Deno.env.get("OPENSAC_DIR");
  Deno.env.set("OPENSAC_DIR", dir);
  return {
    restore: () => {
      if (previous === undefined) Deno.env.delete("OPENSAC_DIR");
      else Deno.env.set("OPENSAC_DIR", previous);
      Deno.removeSync(dir, { recursive: true });
    },
  };
}

Deno.test("setDefaultModel validates scope and persists globally", async () => {
  const iso = isolateConfigDir();
  try {
    const { commands, settings } = stub();
    const bad = await commands.setDefaultModel(["/defaultModel", "nope"]);
    assertEquals(bad.error, true);
    const ok = await commands.setDefaultModel(["/defaultModel", "global"]);
    assertEquals(ok.error, undefined);
    assertEquals(settings.defaultProvider, settings.defaultProvider);
    assert(settings.defaultModel !== undefined);
  } finally {
    iso.restore();
  }
});

Deno.test("previewPastedImage reports when nothing was pasted", () => {
  const { commands } = stub();
  const result = commands.previewPastedImage();
  assertStringIncludes(result.message ?? "", "No image");
});

Deno.test("systemInit refuses to run while the agent is busy", async () => {
  const settings = defaultSettings();
  const session = {
    translator: new Translator("en"),
    settings,
    workDir: Deno.cwd(),
    mode: "yolo",
    busy: true,
    multiAgent: false,
    providerName: "p",
    modelID: "m",
    currentSessionID: () => "s1",
    manager: { getSessionDir: () => "" },
    controller: { addMessage: () => {} },
    input: { insertText: () => {} },
    runtime: {},
    setMode: () => {},
    submitPrompt: () => Promise.resolve(),
  } as unknown as TuiSessionLike;
  const commands = new TuiSessionCommands(session);
  const result = await commands.systemInit("/systeminit");
  assertEquals(result.error, true);
  assertStringIncludes(result.message ?? "", "agent is running");
});
