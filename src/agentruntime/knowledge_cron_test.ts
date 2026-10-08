import { assert, assertEquals } from "@opensac/assert";
import { createKnowledgeBase, getKnowledgeBase } from "../session/mod.ts";
import {
  createKnowledgeBaseService,
  defaultKnowledgeBaseIndexPolicy,
} from "./knowledgebase.ts";
import {
  knowledgeBaseCronJobID,
  knowledgeBaseIDFromCronJobID,
  runKnowledgeBaseCronJob,
} from "./knowledge_cron.ts";

Deno.test("run knowledge base cron job routes namespaced jobs only", async () => {
  const sessionDir = Deno.makeTempDirSync({ dir: Deno.env.get("TMPDIR") });
  const service = createKnowledgeBaseService(
    sessionDir,
    defaultKnowledgeBaseIndexPolicy(),
  );

  const foreign = await runKnowledgeBaseCronJob(
    undefined,
    service,
    "plain-cron-job",
  );
  assert(foreign.handled === false);
  assertEquals(foreign.response, "");

  let missingThrew = false;
  try {
    await runKnowledgeBaseCronJob(
      undefined,
      service,
      knowledgeBaseCronJobID("missing"),
    );
  } catch {
    missingThrew = true;
  }
  assert(missingThrew);

  let nilThrew = false;
  try {
    await runKnowledgeBaseCronJob(
      undefined,
      null,
      knowledgeBaseCronJobID("any"),
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
  const service = createKnowledgeBaseService(
    sessionDir,
    defaultKnowledgeBaseIndexPolicy(),
  );

  const jobID = knowledgeBaseCronJobID(base.id);
  const parsed = knowledgeBaseIDFromCronJobID(jobID);
  assert(parsed !== undefined);
  assertEquals(parsed, base.id);

  const outcome = await runKnowledgeBaseCronJob(undefined, service, jobID);
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
  const service = createKnowledgeBaseService(
    sessionDir,
    defaultKnowledgeBaseIndexPolicy(),
  );
  const controller = new AbortController();
  controller.abort();
  let threw = false;
  try {
    await runKnowledgeBaseCronJob(
      controller.signal,
      service,
      knowledgeBaseCronJobID(base.id),
    );
  } catch {
    threw = true;
  }
  assert(threw);
});
