// Translated from internal/agentruntime/knowledge_cron_test.go.

import { assert, assertEquals } from "@std/assert";
import { createKnowledgeBase, getKnowledgeBase } from "../session/mod.ts";
import {
  defaultKnowledgeBaseIndexPolicy,
  newKnowledgeBaseService,
} from "./knowledgebase.ts";
import {
  KnowledgeBaseCronJobID,
  KnowledgeBaseIDFromCronJobID,
  RunKnowledgeBaseCronJob,
} from "./knowledge_cron.ts";

Deno.test("run knowledge base cron job routes namespaced jobs only", async () => {
  const sessionDir = Deno.makeTempDirSync({ dir: Deno.env.get("TMPDIR") });
  const service = newKnowledgeBaseService(
    sessionDir,
    defaultKnowledgeBaseIndexPolicy(),
  );

  const foreign = await RunKnowledgeBaseCronJob(
    undefined,
    service,
    "plain-cron-job",
  );
  assert(foreign.handled === false);
  assertEquals(foreign.response, "");

  let missingThrew = false;
  try {
    await RunKnowledgeBaseCronJob(
      undefined,
      service,
      KnowledgeBaseCronJobID("missing"),
    );
  } catch {
    missingThrew = true;
  }
  assert(missingThrew);

  let nilThrew = false;
  try {
    await RunKnowledgeBaseCronJob(
      undefined,
      null,
      KnowledgeBaseCronJobID("any"),
    );
  } catch {
    nilThrew = true;
  }
  assert(nilThrew);
});

Deno.test("run knowledge base cron job indexes through canonical background path", async () => {
  const sessionDir = Deno.makeTempDirSync({ dir: Deno.env.get("TMPDIR") });
  const source = Deno.makeTempDirSync({ dir: Deno.env.get("TMPDIR") });
  Deno.writeTextFileSync(
    `${source}/guide.md`,
    "# Guide\n\nScheduled scans reuse the canonical index path.\n",
  );
  const base = createKnowledgeBase(sessionDir, {
    name: "Scheduled",
    rootDir: source,
    preprocessProfile: "documents",
    provider: "",
    model: "",
    mode: "",
    schedule: "daily",
    enabled: true,
  });
  const service = newKnowledgeBaseService(
    sessionDir,
    defaultKnowledgeBaseIndexPolicy(),
  );

  const jobID = KnowledgeBaseCronJobID(base.id);
  const parsed = KnowledgeBaseIDFromCronJobID(jobID);
  assert(parsed.ok === true);
  assertEquals(parsed.id, base.id);

  const outcome = await RunKnowledgeBaseCronJob(undefined, service, jobID);
  assert(outcome.handled === true);
  assert(outcome.response.includes(`indexed knowledge base ${base.id}`));
  assert(outcome.response.includes("1 files"));

  const reloaded = getKnowledgeBase(sessionDir, base.id);
  assert(reloaded.activeSnapshotId.trim() !== "");

  const progress = service.indexProgress(base.id);
  assertEquals(progress.running, false);
  assertEquals(progress.progress.running, false);
});

Deno.test("run knowledge base cron job honors context cancellation", async () => {
  const sessionDir = Deno.makeTempDirSync({ dir: Deno.env.get("TMPDIR") });
  const source = Deno.makeTempDirSync({ dir: Deno.env.get("TMPDIR") });
  const base = createKnowledgeBase(sessionDir, {
    name: "Cancelled",
    rootDir: source,
    preprocessProfile: "documents",
    provider: "",
    model: "",
    mode: "",
    schedule: "daily",
    enabled: true,
  });
  const service = newKnowledgeBaseService(
    sessionDir,
    defaultKnowledgeBaseIndexPolicy(),
  );
  const controller = new AbortController();
  controller.abort();
  let threw = false;
  try {
    await RunKnowledgeBaseCronJob(
      controller.signal,
      service,
      KnowledgeBaseCronJobID(base.id),
    );
  } catch {
    threw = true;
  }
  assert(threw);
});
