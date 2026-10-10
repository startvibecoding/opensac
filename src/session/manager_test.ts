// additional_directories_test.go, and content_override_test.go (Manager slice).
//
// Covers the SQLite-backed Manager: construction/init, append family, replay,
// listing/detail projection, open/reload, sub-agent table isolation, deletion,
// content overrides, and additional-directory bindings.

import { runtime } from "../platform/runtime.ts";
import { assert, assertEquals, assertThrows } from "../compat/assert.ts";
import * as path from "../compat/path.ts";
import { closeAll } from "../db/mod.ts";
import {
  type ContentBlock,
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
  type Message,
} from "../provider/types.ts";
import {
  acquireExecutionAdmission,
  RuntimeLeaseBusyError,
} from "./runtime_lock.ts";
import { openRootDB } from "./root_db.ts";
import { listSessionMessagesWithSeq } from "./session_events.ts";
import {
  SessionIDExistsError,
  SessionModifiedError,
} from "./session_errors.ts";
import {
  continueRecent,
  countAll,
  countWithMessages,
  createBound,
  createManager,
  createSubAgentManager,
  deleteSession,
  encodePath,
  listAll,
  listAllDetailed,
  listForDir,
  listForDirDetailed,
  openByID,
  openByIDExact,
  openByPathOrID,
  openSession,
  rotateBoundSession,
  sessionFileID,
  withMessagesOnly,
  withSearch,
} from "./manager.ts";
import { test } from "#testing";

function textBlock(text: string): ContentBlock {
  return { type: "text", text };
}

function withTempDir(fn: (dir: string, sessionDir: string) => void): void {
  const dir = runtime.makeTempDirSync({ prefix: "opensac-session-test-" });
  const sessionDir = path.join(dir, "sessions");
  try {
    fn(dir, sessionDir);
  } finally {
    closeAll();
    try {
      runtime.removeSync(dir, { recursive: true });
    } catch {
      // best-effort cleanup
    }
  }
}

function countRows(
  sessionDir: string,
  sql: string,
  ...params: (string | number)[]
): number {
  const db = openRootDB(sessionDir);
  const row = db.db!.get<{ n: number }>(sql, ...params);
  return row === null || row === undefined ? 0 : Number(row.n);
}

test("session manager: new", () => {
  const dir = runtime.makeTempDirSync();
  try {
    const sessionDir = path.join(dir, "sessions");
    const m = createManager("/tmp/test", sessionDir);
    assertEquals(m.cwd, "/tmp/test");
    assertEquals(m.sessionDir, sessionDir);

    const defaulted = createManager("/tmp/test", "");
    assert(defaulted.sessionDir !== "");
  } finally {
    runtime.removeSync(dir, { recursive: true });
  }
});

test("session manager: init", () => {
  withTempDir((_dir, sessionDir) => {
    const m = createManager("/tmp/test", sessionDir);
    m.init();
    const header = m.getHeader();
    assert(header !== null);
    assertEquals(header!.version, 3);
    assertEquals(header!.cwd, "/tmp/test");
    assert(header!.id !== "");
    assert(runtime.statSync(path.join(sessionDir, "sessions.db")));
  });
});

test("session manager: init with duplicate ID does not merge entries", () => {
  withTempDir((_dir, sessionDir) => {
    const first = createManager(runtime.makeTempDirSync(), sessionDir);
    first.initWithID("duplicate-session");
    first.appendMessage(createUserMessage("first conversation"));

    const second = createManager(runtime.makeTempDirSync(), sessionDir);
    assertThrows(
      () => second.initWithID("duplicate-session"),
      SessionIDExistsError,
    );

    const reopened = openByIDExact(sessionDir, "duplicate-session");
    assertEquals(reopened.getMessages().length, 1);
  });
});

test("session manager: append message", () => {
  withTempDir((_dir, sessionDir) => {
    const m = createManager("/tmp/test", sessionDir);
    m.init();
    const id = m.appendMessage(createUserMessage("Hello"));
    assert(id !== "");
    assertEquals(m.entries.length, 1);
    const id2 = m.appendMessage(
      createAssistantMessage([textBlock("Hi there")]),
    );
    assert(id2 !== "");
    assertEquals(m.entries.length, 2);
  });
});

test("session manager: append message auto-initializes", () => {
  withTempDir((_dir, sessionDir) => {
    const m = createManager("/tmp/test", sessionDir);
    const id = m.appendMessage(createUserMessage("Hello"));
    assert(id !== "");
    assert(m.getHeader() !== null);
    assert(m.getFile() !== "");
    assert(runtime.statSync(path.join(sessionDir, "sessions.db")));
  });
});

test("session manager: append model / thinking / compaction / session info", () => {
  withTempDir((_dir, sessionDir) => {
    const m = createManager("/tmp/test", sessionDir);
    m.init();
    assert(m.appendModelChange("anthropic", "claude-sonnet-4") !== "");
    assert(m.appendThinkingLevelChange("high") !== "");
    assert(m.appendSessionInfo("My Session") !== "");
    const id = m.appendCompaction("Compacted 10 messages", "entry-1", 1000);
    assert(id !== "");
    const entry = m.entries[3];
    assertEquals(entry.type, "compaction");
    assertEquals((entry as { summaryVersion: number }).summaryVersion, 1);
  });
});

test("session manager: compaction metadata chain", () => {
  withTempDir((_dir, sessionDir) => {
    const m = createManager("/tmp/test", sessionDir);
    m.init();
    m.appendMessage(createUserMessage("old user"));
    const oldAssistantID = m.appendMessage(
      createAssistantMessage([textBlock("old assistant")]),
    );
    const recentUserID = m.appendMessage(createUserMessage("recent user"));

    const firstID = m.appendCompaction("summary one", recentUserID, 100);
    const first = m.getLatestCompaction()!;
    assertEquals(first.id, firstID);
    assertEquals(first.summaryVersion, 1);
    assertEquals(first.previousCompactionId ?? "", "");
    assertEquals(first.lastSummarizedEntryId, oldAssistantID);

    const nextUserID = m.appendMessage(createUserMessage("next user"));
    const secondID = m.appendCompaction("summary two", nextUserID, 200);
    const second = m.getLatestCompaction()!;
    assertEquals(second.id, secondID);
    assertEquals(second.summaryVersion, 2);
    assertEquals(second.previousCompactionId, firstID);
    assertEquals(second.lastSummarizedEntryId, recentUserID);
  });
});

test("session manager: header / leaf / file", () => {
  withTempDir((_dir, sessionDir) => {
    const m = createManager("/tmp/test", sessionDir);
    m.init();
    assertEquals(m.getHeader()!.cwd, "/tmp/test");
    assertEquals(m.getLeafID(), null);
    m.appendMessage(createUserMessage("Hello"));
    assert(m.getLeafID() !== null);
    assert(m.getFile() !== "");
  });
});

test("session manager: get messages applies compaction", () => {
  withTempDir((_dir, sessionDir) => {
    const m = createManager("/tmp/test", sessionDir);
    m.init();
    const id1 = m.appendMessage(createUserMessage("old user"));
    m.appendMessage(createAssistantMessage([textBlock("old assistant")]));
    m.appendMessage(createUserMessage("recent user"));
    m.appendMessage(createAssistantMessage([textBlock("recent assistant")]));
    m.appendCompaction("## Goal\ncompacted", id1, 100);

    const messages = m.getMessages();
    assertEquals(messages.length, 5);
    assertEquals(messages[0].systemInjected, true);
    assertEquals(messages[0].content, "## Goal\ncompacted");
    assertEquals(messages[1].content, "old user");
    assertEquals(messages[3].content, "recent user");

    const replay = m.getReplayState();
    assertEquals(replay.entryIDs.length, messages.length);
    assertEquals(replay.entryIDs[0], "");
    assertEquals(replay.entryIDs[1], id1);
  });
});

test("session manager: summary-only compaction", () => {
  withTempDir((_dir, sessionDir) => {
    const m = createManager("/tmp/test", sessionDir);
    m.init();
    m.appendMessage(createUserMessage("old user"));
    m.appendMessage(createAssistantMessage([textBlock("old assistant")]));
    m.appendCompaction("## Goal\nsummary only", "", 100);
    const messages = m.getMessages();
    assertEquals(messages.length, 1);
    assertEquals(messages[0].systemInjected, true);
    assertEquals(messages[0].content, "## Goal\nsummary only");
    const compaction = m.getLatestCompaction()!;
    assert((compaction.lastSummarizedEntryId ?? "") !== "");
  });
});

test("session manager: compaction clears stale usage", () => {
  withTempDir((_dir, sessionDir) => {
    const m = createManager("/tmp/test", sessionDir);
    m.init();
    m.appendMessage(createUserMessage("old user"));
    m.appendMessage(createAssistantMessage([textBlock("old assistant")]));
    const recentUserID = m.appendMessage(createUserMessage("recent user"));
    const recentAssistant = createAssistantMessage([
      textBlock("recent assistant"),
    ]);
    recentAssistant.usage = {
      input: 1000,
      output: 50,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 1050,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    m.appendMessage(recentAssistant);
    m.appendCompaction("## Goal\ncompacted", recentUserID, 1000);
    const messages = m.getMessages();
    assertEquals(messages.length, 3);
    assertEquals(messages[2].usage, undefined);
  });
});

test("session manager: multiple compactions", () => {
  withTempDir((_dir, sessionDir) => {
    const m = createManager("/tmp/test", sessionDir);
    m.init();
    m.appendMessage(createUserMessage("old user"));
    m.appendMessage(createAssistantMessage([textBlock("old assistant")]));
    const recentUserID = m.appendMessage(createUserMessage("recent user"));
    m.appendMessage(createAssistantMessage([textBlock("recent assistant")]));
    m.appendCompaction("## Goal\nsummary one", recentUserID, 100);
    const nextUserID = m.appendMessage(createUserMessage("next user"));
    m.appendMessage(createAssistantMessage([textBlock("next assistant")]));
    m.appendCompaction("## Goal\nsummary two", nextUserID, 80);

    const messages = m.getMessages();
    assertEquals(messages.length, 3);
    assertEquals(messages[0].systemInjected, true);
    assertEquals(messages[0].content, "## Goal\nsummary two");
    assertEquals(messages[1].content, "next user");
  });
});

test("session manager: open round trip", () => {
  withTempDir((_dir, sessionDir) => {
    const m1 = createManager("/tmp/test", sessionDir);
    m1.init();
    m1.appendMessage(createUserMessage("Hello"));
    const m2 = openSession(m1.getFile());
    assertEquals(m2.getHeader()!.cwd, "/tmp/test");
    assertEquals(m2.entries.length, 1);
  });
});

test("session manager: open non-existent file fails", () => {
  assertThrows(() => openSession("/nonexistent/path.db"));
});

test("session manager: list for dir", () => {
  withTempDir((_dir, sessionDir) => {
    createManager("/tmp/test1", sessionDir).init();
    createManager("/tmp/test1", sessionDir).init();
    createManager("/tmp/test2", sessionDir).init();
    assertEquals(listForDir("/tmp/test1", sessionDir).length, 2);
    assertEquals(listForDir("/tmp/test2", sessionDir).length, 1);
    assertEquals(listForDir("/tmp/nonexistent", sessionDir).length, 0);
  });
});

test("session manager: sub-agent sessions excluded from main lists", () => {
  withTempDir((_dir, sessionDir) => {
    const main = createManager("/tmp/test", sessionDir);
    main.initWithID("main-session");
    const child = createSubAgentManager("/tmp/test", sessionDir);
    child.initWithID("sub-session");
    child.appendMessage(createUserMessage("sub-agent work"));

    const sessions = listForDir("/tmp/test", sessionDir);
    assertEquals(sessions.length, 1);
    assertEquals(sessionFileID(sessions[0].path), "main-session");

    const continued = continueRecent("/tmp/test", sessionDir);
    assertEquals(continued.getHeader()!.id, "main-session");

    assertEquals(
      countRows(sessionDir, "SELECT COUNT(*) AS n FROM sub_session"),
      1,
    );
    assertEquals(
      countRows(
        sessionDir,
        "SELECT COUNT(*) AS n FROM sub_entries WHERE session_id = ?",
        "sub-session",
      ),
      2,
    );
  });
});

test("session manager: continue recent", () => {
  withTempDir((_dir, sessionDir) => {
    const m1 = createManager("/tmp/test", sessionDir);
    m1.init();
    const m2 = continueRecent("/tmp/test", sessionDir);
    assertEquals(m2.getFile(), m1.getFile());
  });
});

test("session manager: continue recent creates a new session", () => {
  withTempDir((_dir, sessionDir) => {
    const m = continueRecent("/tmp/nonexistent", sessionDir);
    assert(m.getFile() !== "");
    assert(m.getHeader() !== null);
    assert(runtime.statSync(path.join(sessionDir, "sessions.db")));
    m.appendMessage(createUserMessage("Hello"));
  });
});

test("session manager: open by path or id", () => {
  withTempDir((_dir, sessionDir) => {
    const m1 = createManager("/tmp/test", sessionDir);
    m1.initWithID("session-test-id");
    assertEquals(
      openByPathOrID("/tmp/test", sessionDir, m1.getFile()).getFile(),
      m1.getFile(),
    );
    assertEquals(
      openByPathOrID("/tmp/test", sessionDir, "session-test-id").getFile(),
      m1.getFile(),
    );
    const shortID = sessionFileID(m1.getFile());
    assertEquals(
      openByPathOrID("/tmp/test", sessionDir, shortID).getFile(),
      m1.getFile(),
    );
  });
});

test("session manager: open by path or id rejects ambiguous prefix", () => {
  withTempDir((_dir, sessionDir) => {
    for (const id of ["abcdef01", "abcdef02"]) {
      createManager("/tmp/test", sessionDir).initWithID(id);
    }
    const err = assertThrows(() =>
      openByPathOrID("/tmp/test", sessionDir, "abc"),
    );
    assert((err as Error).message.includes("ambiguous"));
  });
});

test("session manager: open by ID recreates missing handle", () => {
  withTempDir((_dir, sessionDir) => {
    const m = createManager("/tmp/test", sessionDir);
    m.initWithID("custom-session-123");
    const reopened = openByID("/tmp/test", sessionDir, "custom-session-123");
    assertEquals(reopened.getHeader()!.id, "custom-session-123");
    assert(runtime.statSync(path.join(sessionDir, "sessions.db")));
  });
});

test("session manager: open by ID exact ignores cwd", () => {
  withTempDir((_dir, sessionDir) => {
    createManager("/tmp/test-a", sessionDir).initWithID("exact-session");
    const reopened = openByIDExact(sessionDir, "exact-session");
    assertEquals(reopened.getHeader()!.id, "exact-session");
    assertEquals(reopened.getHeader()!.cwd, "/tmp/test-a");
  });
});

test("session manager: load rejects session not registered in DB", () => {
  const dir = runtime.makeTempDirSync();
  try {
    const handlePath = path.join(dir, "session.db");
    runtime.writeTextFileSync(handlePath, "nonexistent-session-id");
    const err = assertThrows(() => openSession(handlePath));
    assert((err as Error).message.includes("not registered in DB"));
  } finally {
    closeAll();
    runtime.removeSync(dir, { recursive: true });
  }
});

test("session manager: append maintains parent chain", () => {
  withTempDir((_dir, sessionDir) => {
    const m = createManager("/tmp/test", sessionDir);
    m.init();
    const firstID = m.appendMessage(createUserMessage("first"));
    const secondID = m.appendModelChange("openai", "model");
    assertEquals(m.entries.length, 2);
    const second = m.entries[1];
    assertEquals(second.parentId, firstID);
    assertEquals(m.getLeafID(), secondID);
  });
});

test("session manager: append messages persists batch in order", () => {
  withTempDir((_dir, sessionDir) => {
    const m = createManager("/tmp/test", sessionDir);
    m.init();
    const seedID = m.appendMessage(createUserMessage("seed"));
    const ids = m.appendMessages([
      createUserMessage("tool result one"),
      createAssistantMessage([textBlock("interim")]),
      createUserMessage("tool result two"),
    ]);
    assertEquals(ids.length, 3);
    assertEquals(m.entries.length, 4);
    const wantParents = [seedID, ids[0], ids[1]];
    for (let i = 0; i < 3; i++) {
      const entry = m.entries[1 + i];
      assertEquals(entry.id, ids[i]);
      assertEquals(entry.parentId, wantParents[i]);
    }
    assertEquals(m.getLeafID(), ids[2]);

    const reopened = openSession(m.getFile());
    const messages = reopened.getMessages();
    assertEquals(messages.length, 4);
    assertEquals(messages[0].content, "seed");
    assertEquals(messages[1].content, "tool result one");
    assertEquals(messages[3].content, "tool result two");
    assertEquals(messages[2].role, "assistant");
  });
});

test("session manager: empty batch is a no-op", () => {
  withTempDir((_dir, sessionDir) => {
    const m = createManager("/tmp/batch-empty", sessionDir);
    m.initWithID("batch-empty-session");
    assertEquals(m.appendMessages([]), []);
    assertEquals(m.entries.length, 0);
  });
});

test("session manager: stale batch is rejected without persistence", () => {
  withTempDir((_dir, sessionDir) => {
    const first = createManager("/tmp/batch-stale", sessionDir);
    first.initWithID("batch-stale-session");
    const second = openSession(first.getFile());
    first.appendMessage(createUserMessage("first writer"));
    assertThrows(
      () =>
        second.appendMessages([
          createUserMessage("stale one"),
          createUserMessage("stale two"),
        ]),
      SessionModifiedError,
    );
    assertEquals(second.entries.length, 0);
    assertEquals(
      countRows(
        sessionDir,
        "SELECT COUNT(*) AS n FROM entries WHERE session_id = ?",
        "batch-stale-session",
      ),
      2,
    );
  });
});

test("session manager: large batches are chunked with an unbroken chain", () => {
  withTempDir((_dir, sessionDir) => {
    const m = createManager("/tmp/batch-cap", sessionDir);
    m.initWithID("batch-cap-session");
    const total = 64 * 2 + 5;
    const msgs: Message[] = [];
    for (let i = 0; i < total; i++) msgs.push(createUserMessage(`result ${i}`));
    const ids = m.appendMessages(msgs);
    assertEquals(ids.length, total);
    assertEquals(m.entries.length, total);
    for (let i = 1; i < total; i++) {
      assertEquals(m.entries[i].parentId, m.entries[i - 1].id);
    }
    assertEquals(m.getLeafID(), ids[total - 1]);
    const reopened = openSession(m.getFile());
    assertEquals(reopened.getMessages().length, total);
  });
});

test("session manager: sub-agent batch uses separate tables", () => {
  withTempDir((_dir, sessionDir) => {
    const child = createSubAgentManager("/tmp/batch-sub", sessionDir);
    child.initWithID("batch-sub-session");
    const ids = child.appendMessages([
      createUserMessage("sub one"),
      createUserMessage("sub two"),
    ]);
    assertEquals(ids.length, 2);
    assertEquals(
      countRows(
        sessionDir,
        "SELECT COUNT(*) AS n FROM sub_entries WHERE session_id = ?",
        "batch-sub-session",
      ),
      3,
    );
    assertEquals(countRows(sessionDir, "SELECT COUNT(*) AS n FROM entries"), 0);
  });
});

test("session manager: concurrent managers reject stale writer and reload recovers", () => {
  withTempDir((_dir, sessionDir) => {
    const first = createManager("/tmp/reload", sessionDir);
    first.initWithID("reload-session");
    const second = openSession(first.getFile());
    first.appendMessage(createUserMessage("first writer"));
    assertThrows(
      () => second.appendMessage(createUserMessage("stale writer")),
      SessionModifiedError,
    );
    second.reload();
    assert(second.appendMessage(createUserMessage("second writer")) !== "");
  });
});

test("session manager: session info listing", () => {
  withTempDir((_dir, sessionDir) => {
    createManager("/tmp/test", sessionDir).init();
    createManager("/tmp/test", sessionDir).init();
    const sessions = listForDir("/tmp/test", sessionDir);
    assertEquals(sessions.length, 2);
    for (const s of sessions) {
      assert(s.path !== "");
      assert(!isNaN(s.modTime.getTime()));
    }
  });
});

test("session manager: delete session", () => {
  withTempDir((_dir, sessionDir) => {
    const m = createManager("/tmp/test", sessionDir);
    m.init();
    assert(runtime.statSync(path.join(sessionDir, "sessions.db")));
    deleteSession(m.getFile(), sessionDir);
    assertEquals(listForDir("/tmp/test", sessionDir).length, 0);
  });
});

test("session manager: delete non-existent session is idempotent", () => {
  withTempDir((_dir, sessionDir) => {
    deleteSession(path.join(sessionDir, "missing.db"), sessionDir);
  });
});

test("session manager: delete refuses an execution owner", () => {
  withTempDir((_dir, sessionDir) => {
    const m = createManager(runtime.makeTempDirSync(), sessionDir);
    m.init();
    const guard = acquireExecutionAdmission(sessionDir, m.getHeader()!.id);
    try {
      assertThrows(
        () => deleteSession(m.getFile(), sessionDir),
        RuntimeLeaseBusyError,
      );
      const sessions = listForDir(m.getHeader()!.cwd, sessionDir);
      assertEquals(sessions.length, 1);
      assertEquals(sessionFileID(sessions[0].path), m.getHeader()!.id);
    } finally {
      guard.release();
    }
  });
});

test("session manager: delete rejects path outside session dir", () => {
  withTempDir((dir, sessionDir) => {
    const outside = path.join(dir, "outside.db");
    runtime.writeTextFileSync(outside, "session-id");
    assertThrows(() => deleteSession(outside, sessionDir));
  });
});

test("session manager: delete rejects shared DB", () => {
  withTempDir((_dir, sessionDir) => {
    const m = createManager("/tmp/test", sessionDir);
    m.init();
    const sharedDB = path.join(sessionDir, "sessions.db");
    assert(runtime.statSync(sharedDB));
    assertThrows(() => deleteSession(sharedDB, sessionDir));
  });
});

test("session manager: list for dir detailed", () => {
  withTempDir((_dir, sessionDir) => {
    const m = createManager("/tmp/test", sessionDir);
    m.init();
    m.appendMessage(createUserMessage("Hello world"));
    m.appendMessage(createAssistantMessage([textBlock("Hi there")]));
    m.appendMessage(createUserMessage("Another message"));
    const details = listForDirDetailed("/tmp/test", sessionDir);
    assertEquals(details.length, 1);
    assertEquals(details[0].messageCount, 3);
    assertEquals(details[0].preview, "Hello world");
    assert(details[0].id !== "");
    assertEquals(details[0].cwd, "/tmp/test");
  });
});

test("session manager: detailed list orders by last activity, not creation", () => {
  // `-c` continues "the most recent session" through this ordering. A freshly
  // created but abandoned startup must not outrank the conversation that was
  // actually used last, so modTime is the newest entry, floored by creation.
  const sleepSync = (ms: number) =>
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  withTempDir((_dir, sessionDir) => {
    const usedLast = createManager("/tmp/test", sessionDir);
    usedLast.init();
    usedLast.appendMessage(createUserMessage("first created"));
    sleepSync(5);
    const createdLast = createManager("/tmp/test", sessionDir);
    createdLast.init();
    sleepSync(5);
    const before = new Date();
    usedLast.appendMessage(createUserMessage("used last"));

    const details = listForDirDetailed("/tmp/test", sessionDir);
    assertEquals(details.length, 2);
    assertEquals(details[0].id, usedLast.getHeader()!.id);
    assertEquals(details[1].id, createdLast.getHeader()!.id);
    assert(
      details[0].modTime.getTime() >= before.getTime(),
      `modTime ${details[0].modTime.toISOString()} predates the last append`,
    );
    // A session without later activity keeps its creation-time floor and
    // never claims the newer activity of the other session.
    assert(
      details[1].modTime.getTime() >=
        createdLast.getHeader()!.timestamp.getTime(),
      "creation time is the modTime floor",
    );
    assert(
      details[1].modTime.getTime() < before.getTime(),
      "an unused session must not look newer than the last append",
    );
  });
});

test("session manager: list all detailed across work dirs with search and count", () => {
  withTempDir((_dir, sessionDir) => {
    const a = createManager("/tmp/alpha", sessionDir);
    a.init();
    a.appendSessionInfo("Alpha session");
    const b = createManager("/tmp/beta", sessionDir);
    b.init();
    b.appendMessage(createUserMessage("beta message"));

    assertEquals(listAll(sessionDir).length, 2);
    assertEquals(countAll(sessionDir), 2);
    assertEquals(countWithMessages(sessionDir), 1);
    assertEquals(listAll(sessionDir, [withMessagesOnly()]).length, 1);
    assertEquals(listAll(sessionDir, [withSearch("Alpha")]).length, 1);
    assertEquals(listAllDetailed(sessionDir, [withSearch("beta")]).length, 1);
  });
});

test("session manager: encode path is collision free", () => {
  assertEquals(encodePath("/tmp/test"), encodePath("/tmp/test"));
  assert(encodePath("/tmp/test") !== encodePath("/tmp/test2"));
  assert(encodePath("/tmp/test-1") !== encodePath("/tmp/test:1"));
});

test("session manager: session file ID parsing", () => {
  assertEquals(
    sessionFileID("/path/to/20240101-120000_abcd1234.db"),
    "abcd1234",
  );
  assertEquals(sessionFileID("/path/to/session.db"), "");
  assertEquals(sessionFileID("simple_id.db"), "id");
});

test("session manager: open by path or id rejects empty value", () => {
  assertThrows(() => openByPathOrID("/tmp", "/tmp/sessions", ""));
});

test("session manager: full round trip", () => {
  withTempDir((_dir, sessionDir) => {
    const m1 = createManager("/tmp/test", sessionDir);
    m1.init();
    m1.appendMessage(createUserMessage("Hello"));
    m1.appendMessage(createAssistantMessage([textBlock("Hi")]));
    m1.appendModelChange("anthropic", "claude-sonnet-4");
    m1.appendThinkingLevelChange("high");
    m1.appendCompaction("Summary", "", 1000);
    m1.appendSessionInfo("Test Session");

    const m2 = openSession(m1.getFile());
    assertEquals(m2.entries.length, 6);
    const msgs = m2.getMessages();
    assertEquals(msgs.length, 1);
    assertEquals(msgs[0].systemInjected, true);
    assertEquals(msgs[0].content, "Summary");
  });
});

test("session manager: entries survive reopen durably", () => {
  withTempDir((_dir, sessionDir) => {
    const m = createManager("/tmp/test", sessionDir);
    m.init();
    for (let i = 0; i < 5; i++) {
      m.appendMessage(createUserMessage(`message ${i}`));
    }
    const reopened = openSession(m.getFile());
    const loaded = reopened.getMessages();
    assertEquals(loaded.length, 5);
    assertEquals(loaded[4].content, "message 4");
  });
});

test("session manager: additional directories replay preserves leaf", () => {
  const dir = runtime.makeTempDirSync();
  try {
    const m = createManager(runtime.makeTempDirSync(), dir);
    m.initWithID("session-directories");
    m.appendModelChange("provider", "model");
    assert(m.getLeafID() !== null);
    m.reload();
    assert(m.getLeafID() !== null);
    m.appendAdditionalDirectories(["/tmp/extra"]);
    m.reload();
    const entry = m.getLatestAdditionalDirectories();
    assert(entry !== null);
    assertEquals(entry!.directories, ["/tmp/extra"]);
  } finally {
    closeAll();
    runtime.removeSync(dir, { recursive: true });
  }
});

function imageToolResultMessage(): Message {
  const msg = createToolResultMessage(
    "call-1",
    "read",
    "[Image file: /tmp/x.png, 4x4, 10B, mode: auto]",
    false,
  );
  msg.contents = [
    {
      type: "image",
      image: { data: "AAAA", mimeType: "image/png", width: 4, height: 4 },
    },
  ];
  return msg;
}

test("session manager: content override replaces message on replay", () => {
  withTempDir((_dir, sessionDir) => {
    const m = createManager(runtime.makeTempDirSync(), sessionDir);
    m.init();
    m.appendMessage(createUserMessage("look at this"));
    const target = imageToolResultMessage();
    const targetID = m.appendMessage(target);

    const replacement: Message = { ...target };
    replacement.contents = undefined;
    replacement.content = `${target.content}\n\n[image unavailable] 1 image(s) could not be sent to the model`;
    m.appendContentOverride(
      targetID,
      replacement,
      "rejected",
      "content_filter",
    );

    const assertApplied = (messages: Message[], entryIDs: string[]) => {
      assertEquals(messages.length, 2);
      const got = messages[1];
      assertEquals(got.contents ?? [], []);
      assert((got.content ?? "").includes("image unavailable"));
      assertEquals(got.role, "toolResult");
      assertEquals(got.toolCallId, "call-1");
      assertEquals(got.toolName, "read");
      assertEquals(entryIDs[1], targetID);
    };

    const state = m.getReplayState();
    assertApplied(state.messages, state.entryIDs);

    const reopened = openByIDExact(sessionDir, m.getHeader()!.id);
    const replay = reopened.getReplayState();
    assertApplied(replay.messages, replay.entryIDs);

    const sequenced = listSessionMessagesWithSeq(sessionDir, m.getHeader()!.id);
    assertEquals(sequenced.length, 2);
    assertEquals(sequenced[1].message.contents ?? [], []);
    assert((sequenced[1].message.content ?? "").includes("image unavailable"));
  });
});

test("session manager: content override rejects unknown target", () => {
  withTempDir((_dir, sessionDir) => {
    const m = createManager(runtime.makeTempDirSync(), sessionDir);
    m.init();
    assertThrows(() =>
      m.appendContentOverride("missing", createUserMessage("x"), "reason", ""),
    );
  });
});

test("session manager: expert binding persists across reload", () => {
  withTempDir((_dir, sessionDir) => {
    const m = createManager("/tmp/expert", sessionDir);
    m.initWithID("expert-session");
    assertEquals(m.getExpertId(), "");
    m.setExpertBinding("software-company");
    assertEquals(m.getExpertId(), "software-company");
    const reopened = openByIDExact(sessionDir, "expert-session");
    assertEquals(reopened.getExpertId(), "software-company");
    reopened.setExpertBinding("");
    assertEquals(reopened.getExpertId(), "");
  });
});

test("session manager: set work dir persists to the sessions row", () => {
  withTempDir((_dir, sessionDir) => {
    const m = createManager("/tmp/old", sessionDir);
    m.initWithID("workdir-session");
    assertThrows(() => m.setWorkDir("relative/path"));
    m.setWorkDir("/tmp/new");
    assertEquals(m.getHeader()!.cwd, "/tmp/new");
    const reopened = openByIDExact(sessionDir, "workdir-session");
    assertEquals(reopened.getHeader()!.cwd, "/tmp/new");
  });
});

test("session manager: channel binding rotate and create", () => {
  withTempDir((_dir, sessionDir) => {
    const bound = createBound("/tmp/chan", sessionDir, "wechat", "user-1");
    assertEquals(bound.getHeader()!.channelType, "wechat");
    assertEquals(bound.getHeader()!.channelId, "user-1");

    const oldID = bound.getHeader()!.id;
    const rotated = rotateBoundSession(
      "/tmp/chan",
      sessionDir,
      "wechat",
      "user-1",
      oldID,
    );
    assertEquals(rotated.getHeader()!.channelType, "wechat");
    assertEquals(rotated.getHeader()!.channelId, "user-1");
    assert(rotated.getHeader()!.id !== oldID);

    const old = openByIDExact(sessionDir, oldID);
    assertEquals(old.getHeader()!.channelType, "local");

    const m = createManager("/tmp/chan", sessionDir);
    m.init();
    m.setSessionBinding("feishu", "chat-1");
    assertEquals(m.getHeader()!.channelType, "feishu");
  });
});
