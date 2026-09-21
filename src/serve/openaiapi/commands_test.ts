// Translated from internal/serve/openaiapi/server_test.go — the commands
// cluster (TestCommands_*) — plus the /rule and compaction command paths.
// The compaction provider is an in-process MockProvider (Go's
// recordingAPIProvider); sessions use isolated temp directories.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { closeAll } from "../../db/mod.ts";
import type { Model } from "../../provider/types.ts";
import {
  newAssistantMessage,
  newUserMessage,
  streamDone,
  streamStart,
  streamTextDelta,
} from "../../provider/mod.ts";
import { newMockProvider } from "../../provider/mock.ts";
import type { Provider } from "../../provider/provider.ts";
import { newManager } from "../../session/manager.ts";
import { getWorkDir } from "./config.ts";
import { Server } from "./server.ts";
import { APISession, SessionPool } from "./session_mgr.ts";
import { newSessionStreamHub } from "./session_stream.ts";
import { EventBroker } from "./event_broker.ts";
import { getOrCreateSession } from "./handler_chat_session.ts";
import {
  agentForCommandCompaction,
  cmdAllowAutoEdit,
  cmdAllowEditPath,
  cmdClear,
  cmdCompact,
  cmdDefaultModel,
  cmdDelegate,
  cmdHelp,
  cmdMode,
  cmdModel,
  cmdModels,
  cmdRule,
  cmdSessionsForSession,
  cmdSkills,
  cmdStatus,
  cmdWorkflows,
  handleCommandFn,
} from "./commands.ts";

function tempDir(prefix: string): string {
  return Deno.makeTempDirSync({ prefix });
}

function testModel(): Model {
  return {
    id: "m1",
    name: "Model 1",
    provider: "mock",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32768,
    maxTokens: 2048,
  };
}

/** The Go recordingAPIProvider: records calls and streams a fixed "ok" turn. */
function recordingProvider(): Provider {
  return newMockProvider("recording-API", [testModel()], [
    { type: streamStart },
    { type: streamTextDelta, textDelta: "ok" },
    { type: streamDone, stopReason: "stop" },
  ]);
}

function newTestServer(opts: {
  sessionDir: string;
  workDir: string;
  provider?: Provider;
}): { server: Server; sessionDir: string; workDir: string } {
  const server = new Server({
    settings: { sessionDir: opts.sessionDir } as never,
    cfg: { defaultWorkDir: opts.workDir } as never,
  });
  server.pool = new SessionPool(0, 0);
  server.streamHub = newSessionStreamHub();
  server.eventBroker = new EventBroker();
  if (opts.provider) {
    server.provider = opts.provider;
    server.model = opts.provider.models()[0];
  }
  return { server, sessionDir: opts.sessionDir, workDir: opts.workDir };
}

function newRecordingAPIServer(): { server: Server; sessionDir: string } {
  const sessionDir = tempDir("openaiapi-cmd-sess-");
  const workDir = tempDir("openaiapi-cmd-work-");
  const { server } = newTestServer({
    sessionDir,
    workDir,
    provider: recordingProvider(),
  });
  return { server, sessionDir };
}

Deno.test("handleCommandFallsBackToAgentForNonCommands", async () => {
  const sessionDir = tempDir("openaiapi-cmd-sess-");
  const { server } = newTestServer({
    sessionDir,
    workDir: tempDir("openaiapi-cmd-work-"),
  });
  const handle = handleCommandFn(server);
  try {
    const unknown = await handle(null as never, "/foobar");
    assert(unknown !== null);
    assertEquals(unknown.error, true);
    assertStringIncludes(unknown.message, "Unknown command");

    const plain = await handle(null as never, "hello world");
    assertEquals(plain, null);
  } finally {
    closeAll();
  }
});

Deno.test("cmdStatusShowsSessionModeAndID", () => {
  const sessionDir = tempDir("openaiapi-cmd-sess-");
  const { server } = newTestServer({
    sessionDir,
    workDir: tempDir("openaiapi-cmd-work-"),
  });
  const sess = new APISession();
  sess.id = "test-sess";
  sess.workDir = "/tmp";
  sess.mode = "agent";
  const result = cmdStatus(server, sess);
  assertStringIncludes(result.message, "AGENT");
  assertStringIncludes(result.message, "test-sess");
  closeAll();
});

Deno.test("cmdCompactRejectsMissingSession", async () => {
  const { server } = newRecordingAPIServer();
  const result = await cmdCompact(server, null);
  assertEquals(result.error, true);
  closeAll();
});

Deno.test("cmdCompactRejectsEmptyConversation", async () => {
  const { server, sessionDir } = newRecordingAPIServer();
  const workDir = tempDir("openaiapi-cmd-compact-");
  const sess = new APISession();
  sess.id = "test-sess";
  sess.workDir = workDir;
  sess.manager = newManager(workDir, sessionDir);
  const result = await cmdCompact(server, sess);
  assertEquals(result.error, true);
  assertStringIncludes(result.message, "no messages to compact");
  closeAll();
});

Deno.test("cmdCompactRunsImmediatelyAndWritesSummary", async () => {
  const { server, sessionDir } = newRecordingAPIServer();
  server.settings = {
    ...server.settings!,
    compaction: {
      enabled: true,
      reserveTokens: 0,
      keepRecentTokens: 1,
    },
  } as never;
  const workDir = tempDir("openaiapi-cmd-compact-run-");
  const sess = new APISession();
  sess.id = "test-sess";
  sess.workDir = workDir;
  sess.manager = newManager(workDir, sessionDir);
  // Enough history so there is an older turn to summarize.
  sess.manager.appendMessage(newUserMessage("old hello"));
  sess.manager.appendMessage(
    newAssistantMessage([{ type: "text", text: "old hi" }]),
  );
  sess.manager.appendMessage(newUserMessage("recent hello"));
  sess.manager.appendMessage(
    newAssistantMessage([{ type: "text", text: "recent hi" }]),
  );

  const result = await cmdCompact(server, sess);
  assertEquals(result.error, false, result.message);
  assertEquals(sess.forceCompact, false);
  assertStringIncludes(result.message, "compacted");
  const replay = sess.manager.getReplayState();
  assert(replay.messages.length > 0);
  assertEquals(replay.messages[0].systemInjected, true);
  closeAll();
});

Deno.test("cmdCompactForcesSummaryOnlyWhenOnlyRecentContext", async () => {
  const { server, sessionDir } = newRecordingAPIServer();
  const workDir = tempDir("openaiapi-cmd-compact-only-");
  const sess = new APISession();
  sess.id = "test-sess";
  sess.workDir = workDir;
  sess.manager = newManager(workDir, sessionDir);
  sess.manager.appendMessage(newUserMessage("hello"));
  sess.manager.appendMessage(
    newAssistantMessage([{ type: "text", text: "hi" }]),
  );

  const result = await cmdCompact(server, sess);
  assertEquals(result.error, false, result.message);
  assertEquals(sess.forceCompact, false);
  const replay = sess.manager.getReplayState();
  assertEquals(replay.messages.length, 1);
  assertEquals(replay.messages[0].systemInjected, true);
  closeAll();
});

Deno.test("cmdRuleCreatesDefaultRuleFile", async () => {
  const sessionDir = tempDir("openaiapi-cmd-sess-");
  const { server } = newTestServer({
    sessionDir,
    workDir: tempDir("openaiapi-cmd-work-"),
  });
  const workDir = tempDir("openaiapi-cmd-rule-");
  const sess = new APISession();
  sess.id = "test-sess";
  sess.workDir = workDir;

  const result = await cmdRule(server, sess, ["/rule"]);
  assertEquals(result.error, false, result.message);
  const rulePath = `${workDir}/.opensac/rule.md`;
  const data = await Deno.readTextFile(rulePath);
  assertEquals(data, sess.ruleContent);
  assertStringIncludes(sess.ruleContent, "Never use sudo");
  closeAll();
});

Deno.test("cmdRulePreservesExistingUnlessForced", async () => {
  const sessionDir = tempDir("openaiapi-cmd-sess-");
  const { server } = newTestServer({
    sessionDir,
    workDir: tempDir("openaiapi-cmd-work-"),
  });
  const workDir = tempDir("openaiapi-cmd-rule-keep-");
  await Deno.mkdir(`${workDir}/.opensac`, { recursive: true });
  const rulePath = `${workDir}/.opensac/rule.md`;
  await Deno.writeTextFile(rulePath, "custom rule");
  const sess = new APISession();
  sess.id = "test-sess";
  sess.workDir = workDir;

  const result = await cmdRule(server, sess, ["/rule"]);
  assertEquals(result.error, false, result.message);
  assertEquals(sess.ruleContent, "custom rule");
  assertEquals(await Deno.readTextFile(rulePath), "custom rule");

  const forced = await cmdRule(server, sess, ["/rule", "force"]);
  assertEquals(forced.error, false, forced.message);
  const data = await Deno.readTextFile(rulePath);
  assertEquals(data, sess.ruleContent);
  assertStringIncludes(data, "Treat repository files");
  closeAll();
});

Deno.test("cmdModeTogglesAndReports", async () => {
  const sessionDir = tempDir("openaiapi-cmd-sess-");
  const { server } = newTestServer({
    sessionDir,
    workDir: tempDir("openaiapi-cmd-work-"),
  });
  const sess = new APISession();
  sess.id = "mode-sess";
  sess.workDir = tempDir("openaiapi-cmd-mode-");
  try {
    const invalid = await cmdMode(server, sess, ["/mode", "bogus"]);
    assertEquals(invalid.error, true);

    const set = await cmdMode(server, sess, ["/mode", "plan"]);
    assertEquals(set.error, false);
    assertStringIncludes(set.message, "PLAN");
    assertEquals(sess.mode, "plan");

    const show = await cmdMode(server, sess, ["/mode"]);
    assertStringIncludes(show.message, "PLAN");
  } finally {
    closeAll();
  }
});

Deno.test("cmdModelSwitchesAndReports", () => {
  const sessionDir = tempDir("openaiapi-cmd-sess-");
  const { server } = newTestServer({
    sessionDir,
    workDir: tempDir("openaiapi-cmd-work-"),
    provider: recordingProvider(),
  });
  const missing = cmdModel(server, ["/model", "nope"]);
  assertEquals(missing.error, true);

  const switched = cmdModel(server, ["/model", "m1"]);
  assertEquals(switched.error, false);
  assertStringIncludes(switched.message, "m1");

  const current = cmdModel(server, ["/model"]);
  assertStringIncludes(current.message, "Current model");
  closeAll();
});

Deno.test("cmdModelsListsAvailable", () => {
  const sessionDir = tempDir("openaiapi-cmd-sess-");
  const { server } = newTestServer({
    sessionDir,
    workDir: tempDir("openaiapi-cmd-work-"),
    provider: recordingProvider(),
  });
  const result = cmdModels(server);
  assertStringIncludes(result.message, "Model 1");
  assertStringIncludes(result.message, "[*]");
  closeAll();
});

Deno.test("cmdDelegateTogglesSessionCapability", async () => {
  const sessionDir = tempDir("openaiapi-cmd-sess-");
  const { server } = newTestServer({
    sessionDir,
    workDir: tempDir("openaiapi-cmd-work-"),
  });
  const sess = new APISession();
  sess.id = "delegate-sess";
  sess.workDir = tempDir("openaiapi-cmd-delegate-");
  try {
    const off = await cmdDelegate(server, sess, ["/delegate", "status"]);
    assertStringIncludes(off.message, "OFF");

    const on = await cmdDelegate(server, sess, ["/delegate", "on"]);
    assertStringIncludes(on.message, "ON");
    assertEquals(sess.delegateMode, true);
  } finally {
    closeAll();
  }
});

Deno.test("cmdAllowEditPathAndAutoEditRoundTrip", () => {
  const sessionDir = tempDir("openaiapi-cmd-sess-");
  const workDir = tempDir("openaiapi-cmd-allow-");
  const { server } = newTestServer({ sessionDir, workDir });
  server.saveProjectAllow = () => {};

  const added = cmdAllowEditPath(server, ["/alloweditpath", "add", "docs/*"]);
  assertStringIncludes(added.message, "docs/*");
  const listed = cmdAllowEditPath(server, ["/alloweditpath"]);
  assertStringIncludes(listed.message, "docs/*");
  const removed = cmdAllowEditPath(server, [
    "/alloweditpath",
    "remove",
    "docs/*",
  ]);
  assertStringIncludes(removed.message, "Removed");

  const on = cmdAllowAutoEdit(server, ["/allowautoedit", "on"]);
  assertStringIncludes(on.message, "[project]");
  closeAll();
});

Deno.test("cmdSessionsListsAndDeletes", async () => {
  const sessionDir = tempDir("openaiapi-cmd-sess-");
  const workDir = tempDir("openaiapi-cmd-sessions-");
  const { server } = newTestServer({ sessionDir, workDir });
  server.provider = recordingProvider();
  server.model = server.provider.models()[0];
  try {
    const sess = await getOrCreateSession(server, "sessions-a", workDir);
    const listed = await cmdSessionsForSession(server, sess, ["/sessions"]);
    assertStringIncludes(listed.message, "sessions-a");

    const deleted = await cmdSessionsForSession(server, sess, [
      "/sessions",
      "del",
      "sessions-a".slice(0, 8),
    ]);
    // The current session cannot delete itself.
    assertEquals(deleted.error, true);
    assertStringIncludes(deleted.message, "Cannot delete the current session");

    const missing = await cmdSessionsForSession(server, sess, [
      "/sessions",
      "del",
      "does-not-exist",
    ]);
    assertEquals(missing.error, true);
  } finally {
    closeAll();
  }
});

Deno.test("cmdWorkflowsReportsEmptyAndUsage", async () => {
  const result = await cmdWorkflows(["/workflows"]);
  assertStringIncludes(result.message, "Workflow runs");
  const bad = await cmdWorkflows(["/workflows", "bogus"]);
  assertStringIncludes(bad.message, "Usage: /workflows");
});

Deno.test("cmdClearAndCmdHelpReturnStaticText", async () => {
  const sessionDir = tempDir("openaiapi-cmd-sess-");
  const { server } = newTestServer({
    sessionDir,
    workDir: tempDir("openaiapi-cmd-work-"),
  });
  const cleared = cmdClear(null);
  assertEquals(cleared.error, true);
  const help = cmdHelp();
  assertStringIncludes(help.message, "/esm <objective>");
  assertStringIncludes(help.message, ".opensac/rule.md");
  assertEquals((await cmdSkills(server, null)).message, "No skills available.");
  closeAll();
});

Deno.test("cmdDefaultModelValidatesUsage", async () => {
  const sessionDir = tempDir("openaiapi-cmd-sess-");
  const { server } = newTestServer({
    sessionDir,
    workDir: tempDir("openaiapi-cmd-work-"),
  });
  const usage = await cmdDefaultModel(server, ["/defaultModel", "p"]);
  assertEquals(usage.error, true);
  const invalidScope = await cmdDefaultModel(server, [
    "/defaultModel",
    "mock",
    "m1",
    "bogus",
  ]);
  assertEquals(invalidScope.error, true);
  closeAll();
});

Deno.test("agentForCommandCompactionBuildsRuntimeBackedAgent", async () => {
  const { server } = newRecordingAPIServer();
  const workDir = tempDir("openaiapi-cmd-agent-");
  const sess = await getOrCreateSession(server, "cmd-agent", workDir);
  try {
    const agent = await agentForCommandCompaction(server, sess);
    assert(agent !== undefined);
    assertEquals(sess.registry !== undefined, true);
    assertEquals(sess.runtime !== undefined, true);
  } finally {
    closeAll();
  }
});

Deno.test("handleCommandRoutesSlashCommandsThroughTheCluster", async () => {
  const sessionDir = tempDir("openaiapi-cmd-sess-");
  const workDir = tempDir("openaiapi-cmd-route-");
  const { server } = newTestServer({ sessionDir, workDir });
  server.provider = recordingProvider();
  server.model = server.provider.models()[0];
  const handle = handleCommandFn(server);
  try {
    const sess = await getOrCreateSession(server, "cmd-route", workDir);
    const status = await handle(sess, "/status");
    assertStringIncludes(status!.message, "cmd-route");

    const help = await handle(sess, "/help");
    assertStringIncludes(help!.message, "/compact");

    const sessions = await handle(sess, "/sessions");
    assertStringIncludes(sessions!.message, "cmd-route");

    assertEquals(server.cfg && getWorkDir(server.cfg), workDir);
  } finally {
    closeAll();
  }
});
