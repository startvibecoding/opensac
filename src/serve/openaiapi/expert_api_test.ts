// Translated from internal/serve/openaiapi/expert_api_test.go — the expert
// catalog/session-binding flow through the Runtime (TestServerExpertCatalogAnd
// SessionBindingUseRuntime) and the fork-preserves-source flow
// (TestServerForkSessionWithExpertPreservesSource).
//
// Deviations: Go's errors.Is(err, agentruntime.ErrExpertSwitchRequiresFork)
// maps to the typed ExpertSwitchRequiresForkError thrown by
// SessionRuntime.setExpert; the manager create options use camelCase fields.
import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { closeAll } from "../../db/mod.ts";
import { ExpertSwitchRequiresForkError } from "../../agentruntime/expert.ts";
import type { AgentManager } from "../../agent/manager.ts";
import { subAgentToolNames } from "../../agent/subagent_support.ts";
import { newUserMessage } from "../../provider/mod.ts";
import type { Model } from "../../provider/types.ts";
import type { Provider } from "../../provider/provider.ts";
import { newMockProvider } from "../../provider/mock.ts";
import {
  streamDone,
  streamStart,
  streamTextDelta,
} from "../../provider/mod.ts";
import { openByIDExact } from "../../session/manager.ts";
import { type Config, getWorkDir } from "./config.ts";
import { Server } from "./server.ts";
import { SessionPool } from "./session_mgr.ts";
import {
  forkSessionWithExpert,
  getSessionExpert,
  listExperts,
  setSessionExpert,
} from "./expert_api.ts";
import { getOrCreateSession } from "./handler_chat_session.ts";
import { getSessionSubAgents } from "./session_read.ts";

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

function newTestServer(): {
  server: Server;
  sessionDir: string;
  workDir: string;
} {
  const sessionDir = tempDir("openaiapi-expert-sess-");
  const workDir = tempDir("openaiapi-expert-work-");
  const server = new Server({
    settings: { sessionDir } as never,
    cfg: { defaultWorkDir: workDir } as Config,
  });
  server.pool = new SessionPool(0, 0);
  const p = newMockProvider("mock", [testModel()], [
    { type: streamStart },
    { type: streamTextDelta, textDelta: "ok" },
    { type: streamDone, stopReason: "stop" },
  ]);
  server.provider = p as unknown as Provider;
  server.model = p.models()[0];
  return { server, sessionDir, workDir };
}

Deno.test("serverExpertCatalogAndSessionBindingUseRuntime", async () => {
  const { server } = newTestServer();
  try {
    const catalog = listExperts(server, "");
    const seen = new Map(catalog.map((item) => [item.id, item]));
    const team = seen.get("software-company");
    assert(team !== undefined, "catalog missing software-company");
    assertEquals(team.expertType, "team");
    assert(team.displayName.zh !== "");
    assert(
      seen.has("frontend-developer"),
      "catalog missing frontend-developer",
    );

    const sess = await getOrCreateSession(
      server,
      "expert-api-binding",
      getWorkDir(server.cfg as Config),
    );
    let state = await getSessionExpert(server, sess.id);
    assertEquals(state.expert ?? null, null);

    state = await setSessionExpert(
      server,
      undefined,
      sess.id,
      "software-company",
    );
    assert(state.expert !== null && state.expert !== undefined);
    assertEquals(state.expert.id, "software-company");
    assertEquals(state.expert.expertType, "team");
    assertEquals(state.expert.members?.length, 5);
    assertEquals(sess.manager!.getExpertId(), "software-company");
    assertEquals(sess.runtime!.teamExpertActive(), true);
    const agentMgr = sess.agentMgr as AgentManager;
    assert(agentMgr !== undefined);
    assert(agentMgr.members !== undefined);
    assert(sess.registry!.get("subagent_spawn").ok);
    assert(sess.registry!.get("subagent_wait").ok);
    const lead = agentMgr.create({ id: "expert-api-lead" });
    const member = agentMgr.create({
      id: "expert-api-engineer",
      parentId: lead.id(),
      memberId: "software-engineer",
      expertId: "software-company",
      memberDisplayName: "软件工程师",
      memberEmoji: "🛠️",
      memberRole: "member",
    });
    agentMgr.markRunning(member.id());
    const subAgents = getSessionSubAgents(server, sess.id);
    assertEquals(subAgents.length, 1);
    assertEquals(subAgents[0].memberId, "software-engineer");
    assertEquals(subAgents[0].expertId, "software-company");
    assertEquals(subAgents[0].memberDisplayName, "软件工程师");
    assertEquals(subAgents[0].memberEmoji, "🛠️");
    assertEquals(subAgents[0].memberRole, "member");
    assertEquals(subAgents[0].status, "running");

    let forkRequired: unknown = null;
    try {
      await setSessionExpert(server, undefined, sess.id, "frontend-developer");
    } catch (err) {
      forkRequired = err;
    }
    assert(
      forkRequired instanceof ExpertSwitchRequiresForkError,
      `in-place expert replacement error = ${forkRequired}, want fork requirement`,
    );

    state = await setSessionExpert(server, undefined, sess.id, "");
    assertEquals(state.expert ?? null, null);
    assertEquals(sess.runtime!.teamExpertActive(), false);
    assertEquals(sess.agentMgr, undefined);
    // Every canonical sub-agent tool must be gone, not just the spawn tool.
    for (const name of subAgentToolNames()) {
      assertEquals(
        sess.registry!.get(name).ok,
        false,
        `${name} remained after unbinding the only team capability`,
      );
    }
  } finally {
    closeAll();
  }
});

Deno.test("serverForkSessionWithExpertPreservesSource", async () => {
  const { server, sessionDir } = newTestServer();
  try {
    const source = await getOrCreateSession(
      server,
      "expert-api-fork",
      getWorkDir(server.cfg as Config),
    );
    source.manager!.startConversationTurn("expert-api-turn", "intent", "run");
    source.manager!.appendMessage(newUserMessage("fork this expert session"));
    source.manager!.endConversationTurn("expert-api-turn", "completed", "stop");
    await setSessionExpert(server, undefined, source.id, "software-company");

    const result = await forkSessionWithExpert(
      server,
      undefined,
      source.id,
      { requestId: "expert-api-fork-request", titleMode: "" },
      "frontend-developer",
    );
    const child = openByIDExact(sessionDir, result.sessionId);
    assertEquals(child.getExpertId(), "frontend-developer");
    assertEquals(source.manager!.getExpertId(), "software-company");
    assertNotEquals(result.sessionId, source.id);
  } finally {
    closeAll();
  }
});
