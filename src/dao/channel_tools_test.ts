import { assert, assertEquals } from "../compat/assert.ts";
import { BindingDAO, type ChannelToolRecord, SessionDAO } from "./mod.ts";
import { closeTestDbs, openTestDb } from "./test_util.ts";
import { test } from "#testing";

test("channel tools generation", () => {
  const db = openTestDb();
  try {
    const sessionId = "session-bound";
    new SessionDAO(db).insertSession(
      db,
      "sessions",
      sessionId,
      Deno.cwd(),
      "2026-01-01T00:00:00Z",
      "",
      1,
      "wechat",
      "test-dao",
      0,
      0,
      "",
      "",
    );

    const bindingDAO = new BindingDAO(db);
    assertEquals(bindingDAO.channelToolGeneration(sessionId), 0);

    const tools: ChannelToolRecord[] = [
      { sessionId: "", toolName: "read", enabled: true },
      { sessionId: "", toolName: "bash", enabled: true },
    ];
    bindingDAO.setChannelTools(sessionId, tools);
    bindingDAO.listChannelTools(sessionId);

    assertEquals(bindingDAO.channelToolGeneration(sessionId), 1);

    bindingDAO.setChannelTools(sessionId, tools);
    assertEquals(bindingDAO.channelToolGeneration(sessionId), 2);
    assert(
      bindingDAO.list().some((b) => b.sessionId === sessionId),
      "the session should be listed as a channel binding",
    );
  } finally {
    closeTestDbs();
  }
});
