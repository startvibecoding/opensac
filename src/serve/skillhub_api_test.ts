// Focused tests for src/serve/skillhub_api.ts (ports of
// internal/serve/skillhub.go and skillhub_extra.go). The Go package ships no
// dedicated HTTP test for this surface, so these cover the routing table, the
// strict JSON decode contract, the error-status mapping, and the handlers that
// run without a marketplace connection (targets/installed).
//
// Deviations mirror the module header: Request.signal replaces context.Context;
// the DisallowUnknownFields contract is an explicit key check.

import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { closeAll } from "../db/mod.ts";
import type { Config } from "./openaiapi/config.ts";
import { Server } from "./openaiapi/server.ts";
import { SessionPool } from "./openaiapi/session_mgr.ts";
import {
  activationName,
  decodeSkillHubJSON,
  handleSkillHub,
  parseSkillHubPath,
  skillHubErrorStatus,
  skillHubMarket,
  skillHubQueryInt,
} from "./skillhub_api.ts";

function tempDir(prefix: string): string {
  const dir = Deno.makeTempDirSync({ prefix });
  return dir;
}

function jsonRequest(
  url: string,
  init?: RequestInit & { body?: BodyInit | null },
): Request {
  return new Request("http://serve.test" + url, init);
}

function newTestServer(opts?: {
  workDir?: string;
  globalSkillsDir?: string;
}): { server: Server; sessionDir: string } {
  const sessionDir = tempDir("skillhub-api-sess-");
  const workDir = opts?.workDir ?? tempDir("skillhub-api-work-");
  const server = new Server({
    settings: {
      sessionDir,
      skillsDir: opts?.globalSkillsDir ?? "",
    } as never,
    cfg: { defaultWorkDir: workDir } as Config,
  });
  server.pool = new SessionPool(0, 0);
  return { server, sessionDir };
}

Deno.test("skillhub routing maps known paths and methods", async () => {
  // nil server -> 503, matching Go's writeJSON in handleSkillHub.
  const unavailable = await handleSkillHub(
    null,
    jsonRequest("/api/skillhub/markets"),
  );
  assertEquals(unavailable.status, 503);
  assertEquals(await unavailable.json(), { error: "API server not ready" });

  const { server, sessionDir } = newTestServer();
  try {
    // Unknown endpoint -> 404 JSON.
    const missing = await handleSkillHub(
      server,
      jsonRequest("/api/skillhub/nope"),
    );
    assertEquals(missing.status, 404);
    assertEquals(await missing.json(), {
      error: "SkillHub endpoint not found",
    });

    // Known endpoint with the wrong method -> bare 405.
    const badMethod = await handleSkillHub(
      server,
      jsonRequest("/api/skillhub/markets", { method: "POST" }),
    );
    assertEquals(badMethod.status, 405);

    // GET-only detail route with a POST -> bare 405 too.
    const badDetail = await handleSkillHub(
      server,
      jsonRequest("/api/skillhub/skills/skillhub.cn/foo", { method: "POST" }),
    );
    assertEquals(badDetail.status, 405);
  } finally {
    Deno.removeSync(sessionDir, { recursive: true });
    closeAll();
  }
});

Deno.test("skillhub helpers follow Go semantics", () => {
  assertEquals(skillHubMarket("", "skillhub.cn"), "skillhub.cn");
  assertEquals(skillHubMarket("clawhub.ai", "skillhub.cn"), "clawhub.ai");
  assertThrows(
    () => skillHubMarket("bad", "skillhub.cn"),
    Error,
    'unsupported marketplace "bad"',
  );

  assertEquals(parseSkillHubPath("skillhub.cn/foo"), {
    market: "skillhub.cn",
    id: "foo",
  });
  assertEquals(parseSkillHubPath("clawhub.ai/a%20b"), {
    market: "clawhub.ai",
    id: "a b",
  });
  assertThrows(
    () => parseSkillHubPath("onlymarket"),
    Error,
    "market and skill id are required",
  );
  assertThrows(
    () => parseSkillHubPath("skillhub.cn/"),
    Error,
    "market and skill id are required",
  );

  const params = new URLSearchParams({ limit: "5", page: "" });
  assertEquals(skillHubQueryInt(params, "limit", 20), 5);
  assertEquals(skillHubQueryInt(params, "page", 1), 1);
  const bad = new URLSearchParams({ limit: "0" });
  assertThrows(
    () => skillHubQueryInt(bad, "limit", 20),
    Error,
    "limit must be a positive integer",
  );

  assertEquals(activationName(true, "/tmp/proj/.opensac/skills/demo"), "demo");
  assertEquals(activationName(false, "demo"), "");
});

Deno.test("skillhub decode JSON is strict and bounded", async () => {
  const ok = await decodeSkillHubJSON(
    jsonRequest("/x", { method: "POST", body: JSON.stringify({ name: "a" }) }),
    ["name"],
  );
  assertEquals(ok, { name: "a" });

  await assertRejects(
    () =>
      decodeSkillHubJSON(
        jsonRequest("/x", {
          method: "POST",
          body: JSON.stringify({ name: "a", extra: 1 }),
        }),
        ["name"],
      ),
    Error,
    'invalid JSON: json: unknown field "extra"',
  );

  await assertRejects(
    () =>
      decodeSkillHubJSON(jsonRequest("/x", { method: "POST", body: "{oops" }), [
        "name",
      ]),
    Error,
    "invalid JSON:",
  );

  await assertRejects(
    () =>
      decodeSkillHubJSON(
        jsonRequest("/x", { method: "POST", body: "[1,2]" }),
        ["name"],
      ),
    Error,
    "invalid JSON:",
  );

  await assertRejects(
    () =>
      decodeSkillHubJSON(
        jsonRequest("/x", {
          method: "POST",
          body: JSON.stringify({ name: "a" }) + " ".repeat(1 << 20),
        }),
        ["name"],
      ),
    Error,
    "invalid JSON:",
  );
});

Deno.test("skillhub error status maps Go statuses", () => {
  assertEquals(
    skillHubErrorStatus(new Error("workdir not in allowedWorkDirs")),
    403,
  );
  assertEquals(skillHubErrorStatus(new Error("overrides are disabled")), 403);
  assertEquals(skillHubErrorStatus(new Error("skill not found: x")), 404);
  assertEquals(
    skillHubErrorStatus(
      new Error("installed, but failed to refresh session: boom"),
    ),
    500,
  );
  assertEquals(
    skillHubErrorStatus(new Error("scope must be project or global")),
    400,
  );
});

Deno.test("skillhub targets handler lists project and global dirs", async () => {
  const workDir = tempDir("skillhub-api-targets-");
  const globalDir = tempDir("skillhub-api-global-");
  const { server, sessionDir } = newTestServer({
    workDir,
    globalSkillsDir: globalDir,
  });
  try {
    // sessionId is required, matching Go.
    const missingSession = await handleSkillHub(
      server,
      jsonRequest("/api/skillhub/targets"),
    );
    assertEquals(missingSession.status, 400);
    assertEquals((await missingSession.json()).error, "sessionId is required");

    const response = await handleSkillHub(
      server,
      jsonRequest(
        `/api/skillhub/targets?sessionId=s1&workDir=${
          encodeURIComponent(workDir)
        }`,
      ),
    );
    assertEquals(response.status, 200);
    const body = await response.json();
    assertEquals(body.sessionId, "s1");
    assertEquals(body.workDir, workDir);
    assertEquals(body.targets, [
      {
        path: join(workDir, ".opensac", "skills"),
        scope: "project",
        label: "OpenSAC project skills",
      },
      {
        path: join(workDir, ".skills"),
        scope: "project",
        label: "Project skills",
      },
      {
        path: join(workDir, ".agents", "skills"),
        scope: "project",
        label: "Agents skills",
      },
      {
        path: join(workDir, "skills"),
        scope: "project",
        label: "Generic project skills",
      },
      { path: globalDir, scope: "global", label: "Global skills" },
    ]);
  } finally {
    for (const dir of [sessionDir, workDir, globalDir]) {
      Deno.removeSync(dir, { recursive: true });
    }
    closeAll();
  }
});

Deno.test("skillhub installed handler projects index and session state", async () => {
  const workDir = tempDir("skillhub-api-installed-");
  const globalDir = tempDir("skillhub-api-installed-global-");
  const { server, sessionDir } = newTestServer({
    workDir,
    globalSkillsDir: globalDir,
  });
  try {
    // An empty workDir yields an empty index and the not-materialized session
    // state for an unknown session (inspectSkillHubSession keeps sessions lazy).
    const response = await handleSkillHub(
      server,
      jsonRequest("/api/skillhub/installed?sessionId=s9"),
    );
    assertEquals(response.status, 200);
    const body = await response.json();
    assertEquals(body.installed, []);
    assertEquals(body.workDir, workDir);
    assertEquals(body.session, { sessionId: "s9", workDir, activeSkills: [] });

    // A global skill with only SKILL.md (no marketplace metadata) is indexed
    // as a local skill, matching Go's NewLocalIndex.
    Deno.mkdirSync(join(globalDir, "plain-skill"), { recursive: true });
    Deno.writeTextFileSync(
      join(globalDir, "plain-skill", "SKILL.md"),
      "# plain\n",
    );
    const response2 = await handleSkillHub(
      server,
      jsonRequest("/api/skillhub/installed"),
    );
    assertEquals(response2.status, 200);
    const body2 = await response2.json();
    assert(Array.isArray(body2.installed));
    assertEquals(body2.installed.length, 1);
    assertEquals(body2.installed[0].name, "plain-skill");
    assertEquals(body2.installed[0].local, true);
    assertEquals(body2.installed[0].scope, "global");
  } finally {
    for (const dir of [sessionDir, workDir, globalDir]) {
      Deno.removeSync(dir, { recursive: true });
    }
    closeAll();
  }
});
