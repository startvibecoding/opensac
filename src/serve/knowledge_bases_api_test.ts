// Focused tests for src/serve/knowledge_bases_api.ts (the port of
// internal/serve/knowledge_bases.go). The Go package ships a heavier
// knowledge_bases_test.go behind the unported channelRuntime; the CRUD,
// routing, and error-status contracts are pinned here over a real per-base
// SQLite store.
//
// Deviations mirror the module header: Request.signal replaces context.Context;
// OPENSAC_DIR is pointed at a temp dir so the lazily constructed Runtime
// service never reads the developer's global settings.

import { assert, assertEquals } from "@std/assert";
import { closeAll } from "../db/mod.ts";
import {
  createKnowledgeBase,
  getKnowledgeBase,
} from "../session/knowledge_bases.ts";
import { KnowledgeBaseCronJobID } from "../agentruntime/knowledge_cron.ts";
import {
  knowledgeBaseErrorStatus,
  knowledgeBaseMutationSpec,
  ServeKnowledgeBaseState,
  validateWebKnowledgeBaseSpec,
} from "./knowledge_bases_api.ts";

function tempDir(prefix: string): string {
  return Deno.makeTempDirSync({ prefix });
}

function request(url: string, init?: RequestInit): Request {
  return new Request("http://serve.test" + url, init);
}

Deno.test("knowledge base web spec validation and defaults", () => {
  const spec = knowledgeBaseMutationSpec({
    name: "Docs",
    rootDir: "/tmp/docs",
    preprocessProfile: "notes",
    provider: "",
    model: "",
    mode: "yolo",
    schedule: "manual",
  });
  assertEquals(spec.enabled, true, "enabled defaults to true");
  validateWebKnowledgeBaseSpec(spec);

  assertThrows(
    () =>
      validateWebKnowledgeBaseSpec(
        knowledgeBaseMutationSpec({ provider: "p", model: "" }),
      ),
    Error,
    "provider and model must be configured together",
  );
  assertThrows(
    () =>
      validateWebKnowledgeBaseSpec(
        knowledgeBaseMutationSpec({ provider: "", model: "m" }),
      ),
    Error,
    "provider and model must be configured together",
  );
  assertThrows(
    () =>
      validateWebKnowledgeBaseSpec(
        knowledgeBaseMutationSpec({ schedule: "@daily" }),
      ),
    Error,
    "scheduled knowledge base indexing is not available in WebUI",
  );
  // A manual cadence is accepted.
  validateWebKnowledgeBaseSpec(
    knowledgeBaseMutationSpec({ schedule: "Manual" }),
  );
});

function assertThrows(fn: () => void, ctor: ErrorConstructor, msg: string) {
  let thrown: unknown;
  try {
    fn();
  } catch (err) {
    thrown = err;
  }
  assert(thrown instanceof ctor, `expected ${ctor.name}: ${msg}`);
  assertEquals((thrown as Error).message, msg);
}

Deno.test("knowledge base error status maps Go statuses", () => {
  assertEquals(knowledgeBaseErrorStatus(new Error("nope")), 400);
  assertEquals(
    knowledgeBaseErrorStatus(new Error("knowledge base not found")),
    404,
  );
  assertEquals(knowledgeBaseErrorStatus(new Error("base is disabled")), 409);
});

Deno.test("knowledge base routing rejects bad paths and methods", async () => {
  const sessionDir = tempDir("kb-api-sess-");
  Deno.env.set("OPENSAC_DIR", tempDir("kb-api-openasc-"));
  try {
    const state = new ServeKnowledgeBaseState("");

    // An empty sessionDir keeps the runtime unavailable, matching Go.
    const unavailable = await state.handleKnowledgeBases(
      request("/api/knowledge-bases"),
    );
    assertEquals(unavailable.status, 503);
    assertEquals(await unavailable.json(), {
      error: "knowledge base runtime is unavailable",
    });

    const live = new ServeKnowledgeBaseState(sessionDir);
    const badPath = await live.handleKnowledgeBases(
      request("/api/knowledge-bases/a/b/c"),
    );
    assertEquals(badPath.status, 400);
    assertEquals((await badPath.json()).error, "invalid knowledge base path");

    const badID = await live.handleKnowledgeBases(
      request("/api/knowledge-bases/%2f"),
    );
    assertEquals(badID.status, 400);
    assertEquals((await badID.json()).error, "invalid knowledge base ID");

    const badMethod = await live.handleKnowledgeBases(
      request("/api/knowledge-bases", { method: "PUT" }),
    );
    assertEquals(badMethod.status, 405);

    const badSubMethod = await live.handleKnowledgeBases(
      request("/api/knowledge-bases/id1/scan", { method: "GET" }),
    );
    assertEquals(badSubMethod.status, 405);

    const badIDMethod = await live.handleKnowledgeBases(
      request("/api/knowledge-bases/id1", { method: "POST" }),
    );
    assertEquals(badIDMethod.status, 405);
  } finally {
    Deno.env.delete("OPENSAC_DIR");
    Deno.removeSync(sessionDir, { recursive: true });
    closeAll();
  }
});

Deno.test("knowledge base CRUD round trip over a real session dir", async () => {
  const sessionDir = tempDir("kb-api-sess-");
  const rootDir = tempDir("kb-api-root-");
  Deno.env.set("OPENSAC_DIR", tempDir("kb-api-openasc-"));
  try {
    const state = new ServeKnowledgeBaseState(sessionDir);
    const body = {
      knowledgeBase: {
        name: "Docs",
        rootDir,
        preprocessProfile: "notes",
        provider: "",
        model: "",
        mode: "yolo",
        schedule: "manual",
      },
    };

    const created = await state.handleKnowledgeBases(
      request("/api/knowledge-bases", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    );
    assertEquals(created.status, 201);
    const createdBody = await created.json();
    assertEquals(createdBody.knowledgeBase.name, "Docs");
    assertEquals(createdBody.status, "unindexed");
    assertEquals(createdBody.snapshot, null);
    const id = createdBody.knowledgeBase.id;
    assert(id !== "");

    const listed = await state.handleKnowledgeBases(
      request("/api/knowledge-bases"),
    );
    assertEquals(listed.status, 200);
    const listedBody = await listed.json();
    assertEquals(listedBody.knowledgeBases.length, 1);
    assertEquals(listedBody.knowledgeBases[0].knowledgeBase.id, id);

    const got = await state.handleKnowledgeBases(
      request(`/api/knowledge-bases/${id}`),
    );
    assertEquals(got.status, 200);
    assertEquals((await got.json()).knowledgeBase.id, id);

    const updated = await state.handleKnowledgeBases(
      request(`/api/knowledge-bases/${id}`, {
        method: "PATCH",
        body: JSON.stringify({
          knowledgeBase: { ...body.knowledgeBase, name: "Docs2" },
        }),
      }),
    );
    assertEquals(updated.status, 200);
    assertEquals((await updated.json()).knowledgeBase.name, "Docs2");

    const deleted = await state.handleKnowledgeBases(
      request(`/api/knowledge-bases/${id}`, { method: "DELETE" }),
    );
    assertEquals(deleted.status, 200);
    assertEquals(await deleted.json(), { deleted: true, id });

    const missing = await state.handleKnowledgeBases(
      request(`/api/knowledge-bases/${id}`),
    );
    assertEquals(missing.status, 404);
    assertEquals((await missing.json()).error, "knowledge base not found");

    // Invalid JSON body maps to the generic invalid-JSON error.
    const badBody = await state.handleKnowledgeBases(
      request("/api/knowledge-bases", { method: "POST", body: "{oops" }),
    );
    assertEquals(badBody.status, 400);
    assertEquals((await badBody.json()).error, "invalid knowledge base JSON");
  } finally {
    Deno.env.delete("OPENSAC_DIR");
    for (const dir of [sessionDir, rootDir]) {
      Deno.removeSync(dir, { recursive: true });
    }
    closeAll();
  }
});

Deno.test("knowledge base query endpoint requires a query", async () => {
  const sessionDir = tempDir("kb-api-sess-");
  Deno.env.set("OPENSAC_DIR", tempDir("kb-api-openasc-"));
  try {
    const state = new ServeKnowledgeBaseState(sessionDir);
    const empty = await state.handleKnowledgeBases(
      request("/api/knowledge-bases/id1/query", {
        method: "POST",
        body: JSON.stringify({ query: "  " }),
      }),
    );
    assertEquals(empty.status, 400);
    assertEquals((await empty.json()).error, "query is required");

    const malformed = await state.handleKnowledgeBases(
      request("/api/knowledge-bases/id1/query", {
        method: "POST",
        body: "not json",
      }),
    );
    assertEquals(malformed.status, 400);
    assertEquals((await malformed.json()).error, "query is required");

    // An unknown base surfaces through the shared error mapping.
    const missingBase = await state.handleKnowledgeBases(
      request("/api/knowledge-bases/nope/query", {
        method: "POST",
        body: JSON.stringify({ query: "hello" }),
      }),
    );
    assertEquals(missingBase.status, 404);
  } finally {
    Deno.env.delete("OPENSAC_DIR");
    Deno.removeSync(sessionDir, { recursive: true });
    closeAll();
  }
});

// --- knowledge_bases_test.go runtime-dependent halves --------------------------

Deno.test("knowledge base handlers manage runtime owned indexes", async () => {
  const sessionDir = tempDir("kb-api-sess-");
  const sourceDir = tempDir("kb-api-src-");
  Deno.env.set("OPENSAC_DIR", tempDir("kb-api-openasc-"));
  try {
    Deno.writeTextFileSync(
      `${sourceDir}/guide.md`,
      "# Runtime knowledge\n\nThe knowledge index belongs to the shared runtime.\n",
    );
    const state = new ServeKnowledgeBaseState(sessionDir);

    const listed = await state.handleKnowledgeBases(
      request("/api/knowledge-bases"),
    );
    assertEquals(listed.status, 200);
    assertEquals((await listed.json()).knowledgeBases, []);

    const created = await state.handleKnowledgeBases(
      request("/api/knowledge-bases", {
        method: "POST",
        body: JSON.stringify({
          knowledgeBase: {
            name: "Docs",
            rootDir: sourceDir,
            preprocessProfile: "documents",
            mode: "yolo",
            schedule: "manual",
            enabled: true,
          },
        }),
      }),
    );
    const createdText = await created.text();
    assertEquals(created.status, 201, createdText);
    const view = JSON.parse(createdText);
    assert(view.knowledgeBase.id !== "");
    assertEquals(view.knowledgeBase.schedule, "manual");
    assertEquals(view.status, "unindexed");
    const id = view.knowledgeBase.id;

    // Scans are admitted in the background: the POST returns immediately with
    // a running-job projection so a page reload can observe the scan.
    const scanned = await state.handleKnowledgeBases(
      request(`/api/knowledge-bases/${id}/scan`, {
        method: "POST",
        body: "{}",
      }),
    );
    assertEquals(scanned.status, 200);
    const scanView = await scanned.json();
    assertEquals(scanView.knowledgeBase.id, id);

    // Poll the management projection until the background scan commits its
    // snapshot; this mirrors how the WebUI tracks progress after a reload.
    const deadline = Date.now() + 15_000;
    let completed = await state.handleKnowledgeBases(
      request(`/api/knowledge-bases/${id}`),
    );
    let completedView = await completed.json();
    while (
      !(completedView.snapshot !== null && completedView.status === "completed")
    ) {
      if (Date.now() > deadline) {
        throw new Error(
          `scan did not complete: ${JSON.stringify(completedView)}`,
        );
      }
      await new Promise((r) => setTimeout(r, 20));
      completed = await state.handleKnowledgeBases(
        request(`/api/knowledge-bases/${id}`),
      );
      completedView = await completed.json();
    }
    assert(completedView.snapshot.chunkCount > 0);

    const queried = await state.handleKnowledgeBases(
      request(`/api/knowledge-bases/${id}/query`, {
        method: "POST",
        body: JSON.stringify({ query: "shared runtime", limit: 8 }),
      }),
    );
    const queriedText = await queried.text();
    assertEquals(queried.status, 200, queriedText);
    assert(queriedText.includes("guide.md"), queriedText);

    const deleted = await state.handleKnowledgeBases(
      request(`/api/knowledge-bases/${id}`, { method: "DELETE" }),
    );
    assertEquals(deleted.status, 200);
    const deletedBody = await deleted.json();
    assertEquals(deletedBody.deleted, true);
  } finally {
    Deno.env.delete("OPENSAC_DIR");
    Deno.removeSync(sessionDir, { recursive: true });
    Deno.removeSync(sourceDir, { recursive: true });
    closeAll();
  }
});

Deno.test("knowledge base handlers reject scheduled web UI configuration", async () => {
  const sessionDir = tempDir("kb-api-sess-");
  const sourceDir = tempDir("kb-api-src-");
  Deno.env.set("OPENSAC_DIR", tempDir("kb-api-openasc-"));
  try {
    const state = new ServeKnowledgeBaseState(sessionDir);
    const created = await state.handleKnowledgeBases(
      request("/api/knowledge-bases", {
        method: "POST",
        body: JSON.stringify({
          knowledgeBase: {
            name: "Docs",
            rootDir: sourceDir,
            preprocessProfile: "documents",
            schedule: "@daily",
            enabled: true,
          },
        }),
      }),
    );
    const body = await created.json();
    assertEquals(created.status, 400, JSON.stringify(body));
    assert(
      body.error.includes("scheduled knowledge base indexing"),
      body.error,
    );
  } finally {
    Deno.env.delete("OPENSAC_DIR");
    Deno.removeSync(sessionDir, { recursive: true });
    Deno.removeSync(sourceDir, { recursive: true });
    closeAll();
  }
});

Deno.test("knowledge base cron jobs route through runtime handler", async () => {
  const sessionDir = tempDir("kb-api-sess-");
  const sourceDir = tempDir("kb-api-src-");
  Deno.env.set("OPENSAC_DIR", tempDir("kb-api-openasc-"));
  try {
    Deno.writeTextFileSync(
      `${sourceDir}/guide.md`,
      "# Guide\n\nScheduled scans reuse the runtime handler.\n",
    );
    const state = new ServeKnowledgeBaseState(sessionDir);

    // A foreign job id falls through to the scheduler's own execution path.
    const foreign = await state.runKnowledgeBaseCronJob(undefined, {
      id: "ordinary-job",
      prompt: "do something",
    });
    assertEquals(foreign, { handled: false, response: "" });

    // A namespaced id for a missing base is a handled failure: the throw is
    // the port's projection of Go's (handled=true, err) return.
    let missingErr: unknown = null;
    try {
      await state.runKnowledgeBaseCronJob(undefined, {
        id: KnowledgeBaseCronJobID("missing"),
      });
    } catch (err) {
      missingErr = err;
    }
    assert(missingErr !== null, "missing base cron job must fail");

    const base = createKnowledgeBase(sessionDir, {
      name: "Scheduled",
      rootDir: sourceDir,
      preprocessProfile: "documents",
      provider: "",
      model: "",
      mode: "yolo",
      schedule: "daily",
      enabled: true,
    });
    const outcome = await state.runKnowledgeBaseCronJob(undefined, {
      id: KnowledgeBaseCronJobID(base.id),
    });
    assertEquals(outcome.handled, true);
    assert(
      outcome.response.includes(`indexed knowledge base ${base.id}`),
      outcome.response,
    );
    const reloaded = getKnowledgeBase(sessionDir, base.id);
    assert(
      (reloaded.activeSnapshotId ?? "").trim() !== "",
      "cron reindex left no active snapshot",
    );
  } finally {
    Deno.env.delete("OPENSAC_DIR");
    Deno.removeSync(sessionDir, { recursive: true });
    Deno.removeSync(sourceDir, { recursive: true });
    closeAll();
  }
});
