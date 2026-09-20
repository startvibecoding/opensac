// Translated from internal/agentruntime/knowledge_index_job_test.go.

import { assert, assertEquals } from "@std/assert";
import { createKnowledgeBase } from "../session/mod.ts";
import {
  defaultKnowledgeBaseIndexPolicy,
  newKnowledgeBaseService,
} from "./knowledgebase.ts";
import { KnowledgeIndexPhaseCommitting } from "./knowledge_index_job.ts";
import { SourceACP } from "./source.ts";

Deno.test("knowledge base start index runs in background with progress", async () => {
  const sessionDir = Deno.makeTempDirSync({ dir: Deno.env.get("TMPDIR") });
  const source = Deno.makeTempDirSync({ dir: Deno.env.get("TMPDIR") });
  const files: Record<string, string> = {
    "notes.md": "# Notes\n\nBackground indexing keeps transports responsive.",
    "guide.md": "# Guide\n\nProgress is polled periodically by hosts.",
    "extra.md": "# Extra\n\nConcurrent starts share a single job.",
  };
  for (const [name, body] of Object.entries(files)) {
    Deno.writeTextFileSync(`${source}/${name}`, body);
  }
  const base = createKnowledgeBase(sessionDir, {
    name: "Async notes",
    rootDir: source,
    preprocessProfile: "documents",
    provider: "",
    model: "",
    mode: "yolo",
    schedule: "manual",
    enabled: true,
  });
  const service = newKnowledgeBaseService(
    sessionDir,
    defaultKnowledgeBaseIndexPolicy(),
  );

  const job = service.startIndex(undefined, base.id, SourceACP);
  assert(job.viewProgress().running === true);

  const shared = service.startIndex(undefined, base.id, SourceACP);
  assert(shared === job);

  assert(service.indexProgress(base.id).running === true);

  const snapshot = await job.wait(undefined);
  assertEquals(snapshot.status, "completed");
  assertEquals(snapshot.fileCount, 3);

  const progress = job.viewProgress();
  assertEquals(progress.running, false);
  assertEquals(progress.filesTotal, 3);
  assertEquals(progress.filesDone, 3);
  assertEquals(progress.phase, KnowledgeIndexPhaseCommitting);
  assertEquals(service.indexProgress(base.id).running, false);

  const again = service.startIndex(undefined, base.id, SourceACP);
  assert(again !== job);
  const reused = await again.wait(undefined);
  assertEquals(reused.id, snapshot.id);
});

Deno.test("knowledge base start index rejects disabled base synchronously", () => {
  const sessionDir = Deno.makeTempDirSync({ dir: Deno.env.get("TMPDIR") });
  const source = Deno.makeTempDirSync({ dir: Deno.env.get("TMPDIR") });
  const base = createKnowledgeBase(sessionDir, {
    name: "Disabled",
    rootDir: source,
    preprocessProfile: "documents",
    provider: "",
    model: "",
    mode: "yolo",
    schedule: "manual",
    enabled: false,
  });
  const service = newKnowledgeBaseService(
    sessionDir,
    defaultKnowledgeBaseIndexPolicy(),
  );
  let threw = false;
  try {
    service.startIndex(undefined, base.id, SourceACP);
  } catch {
    threw = true;
  }
  assert(threw);
  assertEquals(service.indexJob(base.id), null);
});
