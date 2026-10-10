// Tests for the stats query executor placement (query_offload.ts):
// worker and in-process paths must produce identical results, transport
// failures fall back in-process, and query failures surface unchanged.

import { assert, assertEquals, assertRejects } from "../compat/assert.ts";
import * as path from "../compat/path.ts";
import { openStandalone } from "../db/mod.ts";
import {
  StatsDAO,
  type StatsRecord,
  wrapStandaloneDatabase,
} from "../dao/mod.ts";
import { closeDatabases } from "../session/mod.ts";
import {
  createInlineStatsQueryExecutor,
  createStatsQueryExecutor,
  type StatsQueryExecutor,
  type StatsQueryWorkerPort,
} from "./query_offload.ts";
import { DB, type Query } from "./stats.ts";
import { test } from "#testing";

function insert(db: DB, record: Partial<StatsRecord>): void {
  const raw = db.database.db;
  if (raw === null) throw new Error("nil connection");
  new StatsDAO(raw).insert(raw, {
    id: 0,
    timestamp: new Date().toISOString(),
    sessionId: null,
    provider: "openai",
    protocol: "openai-chat",
    model: "gpt-4",
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    durationMs: 0,
    ...record,
  });
}

function createSeededDB(): DB {
  const dbPath = path.join(Deno.makeTempDirSync(), "sessions.db");
  const f = Deno.openSync(dbPath, { create: true, write: true });
  f.close();
  const db = DB.open(dbPath);
  insert(db, { provider: "openai", model: "gpt-4", inputTokens: 100 });
  insert(db, { provider: "anthropic", model: "claude", outputTokens: 50 });
  return db;
}

async function assertExecutorsAgree(
  worker: StatsQueryExecutor,
  inline: StatsQueryExecutor,
): Promise<void> {
  const query: Query = { groupBy: "day" };
  assertEquals(await worker.summary(query), await inline.summary(query));
  assertEquals(await worker.timeSeries(query), await inline.timeSeries(query));
  assertEquals(await worker.byProvider(query), await inline.byProvider(query));
  assertEquals(await worker.byModel(query), await inline.byModel(query));
  const workerRecent = await worker.recentFiltered(query, 1, 10);
  const inlineRecent = await inline.recentFiltered(query, 1, 10);
  assertEquals(workerRecent.total, inlineRecent.total);
  assertEquals(workerRecent.items.length, inlineRecent.items.length);
  assertEquals(
    workerRecent.items.map((item) => item.totalTokens),
    inlineRecent.items.map((item) => item.totalTokens),
  );
}

test("worker executor returns the same results as the inline executor", async () => {
  const db = createSeededDB();
  const worker = createStatsQueryExecutor(db);
  const inline = createInlineStatsQueryExecutor(db);
  try {
    await assertExecutorsAgree(worker, inline);
  } finally {
    worker.close();
    inline.close();
    closeDatabases();
  }
});

test("worker executor falls back in-process when the worker cannot spawn", async () => {
  const db = createSeededDB();
  let spawns = 0;
  const worker = createStatsQueryExecutor(db, {
    spawnWorker: () => {
      spawns++;
      throw new Error("spawn denied");
    },
  });
  const inline = createInlineStatsQueryExecutor(db);
  try {
    await assertExecutorsAgree(worker, inline);
    assertEquals(spawns, 1, "a failed spawn must not retry per call");
  } finally {
    worker.close();
    inline.close();
    closeDatabases();
  }
});

test("worker executor falls back in-process on request timeout", async () => {
  const db = createSeededDB();
  // A port that never replies: the wall-clock budget must kick in.
  const silent = new FakeWorker(() => {});
  const worker = createStatsQueryExecutor(db, {
    spawnWorker: () => silent,
    timeoutMs: 50,
  });
  const inline = createInlineStatsQueryExecutor(db);
  try {
    await assertExecutorsAgree(worker, inline);
    assert(silent.terminated, "the stuck worker must be terminated");
  } finally {
    worker.close();
    inline.close();
    closeDatabases();
  }
});

test("worker executor surfaces query failures without falling back", async () => {
  const db = createSeededDB();
  // A port that reports a data-level failure for every request.
  const broken = new FakeWorker((msg) => {
    const data = msg as { id: number };
    broken.reply({
      id: data.id,
      ok: false,
      phase: "query",
      error: "bad filter",
    });
  });
  const worker = createStatsQueryExecutor(db, {
    spawnWorker: () => broken,
    timeoutMs: 5000,
  });
  try {
    const err = await assertRejects(
      () => worker.summary({}),
      Error,
      "bad filter",
    );
    assertEquals(err.name, "StatsQueryError");
    // Query failures keep the worker path alive for the next call.
    await assertRejects(() => worker.summary({}), Error, "bad filter");
  } finally {
    worker.close();
    closeDatabases();
  }
});

test("inline executor surfaces query failures as rejections", async () => {
  const db = createSeededDB();
  const raw = db.database.db;
  if (raw === null) throw new Error("nil connection");
  // A caller-owned standalone connection can be closed without disturbing the
  // managed cache, turning the next statement into a real query error.
  const standaloneRaw = openStandalone(raw.path);
  const standalone = new DB(
    wrapStandaloneDatabase(standaloneRaw) ?? (() => {
      throw new Error("database is not open");
    })(),
    new StatsDAO(standaloneRaw),
  );
  const inline = createInlineStatsQueryExecutor(standalone);
  standaloneRaw.close();
  try {
    await assertRejects(() => inline.summary({}), Error);
  } finally {
    inline.close();
    closeDatabases();
  }
});

test("close is idempotent and stops routing to the worker", async () => {
  const db = createSeededDB();
  const fake = new FakeWorker((msg) => {
    const data = msg as { id: number };
    fake.reply({ id: data.id, ok: true, result: { totalRequests: 999 } });
  });
  const worker = createStatsQueryExecutor(db, { spawnWorker: () => fake });
  worker.close();
  worker.close();
  // Post-close calls are served in-process by the same query implementation.
  const result = await worker.summary({});
  assert(
    result.totalRequests !== 999,
    "closed executor must not use the worker",
  );
  closeDatabases();
});

/** A scriptable in-memory {@link StatsQueryWorkerPort}. */
class FakeWorker implements StatsQueryWorkerPort {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  terminated = false;
  #onPost: (value: unknown) => void;

  constructor(onPost: (value: unknown) => void) {
    this.#onPost = onPost;
  }

  postMessage(value: unknown): void {
    if (this.terminated) return;
    this.#onPost(value);
  }

  terminate(): void {
    this.terminated = true;
    this.onmessage = null;
    this.onerror = null;
  }

  /** Delivers a worker reply to the host. */
  reply(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent);
  }
}
