// Ported from internal/workflow/runner_test.go and the remaining cases of
// internal/workflow/semantics_test.go (results/log ordering).

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { Runner } from "./runner.ts";
import { FileStore, newFileStore } from "./store.ts";
import {
  abortError,
  type AgentResult,
  type AgentTask,
  type Host,
  statusDone,
  statusError,
  statusRunning,
} from "./types.ts";

function fixedClock(): () => Date {
  let t = new Date(Date.UTC(2026, 5, 18, 10, 0, 0, 0));
  return () => {
    t = new Date(t.getTime() + 1);
    return t;
  };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(abortError());
    }, { once: true });
  });
}

class FakeHost implements Host {
  running = 0;
  maxRunning = 0;
  tasks: AgentTask[] = [];
  resultsByName: Record<string, string>;

  constructor(resultsByName: Record<string, string> = {}) {
    this.resultsByName = resultsByName;
  }

  async runAgent(task: AgentTask, signal?: AbortSignal): Promise<AgentResult> {
    this.running++;
    if (this.running > this.maxRunning) this.maxRunning = this.running;
    this.tasks.push(task);
    try {
      await sleep(5, signal);
    } catch (err) {
      this.running--;
      throw err;
    }
    const out = this.resultsByName[task.name] || `${task.name}:${task.prompt}`;
    this.running--;
    return {
      key: "",
      name: task.name,
      status: "",
      startedAt: new Date(0),
      result: out,
    };
  }
}

class PromptHost implements Host {
  prompts: Record<string, string> = {};

  runAgent(task: AgentTask, signal?: AbortSignal): Promise<AgentResult> {
    if (signal?.aborted) return Promise.reject(abortError());
    this.prompts[task.name] = task.prompt;
    return Promise.resolve({
      key: "",
      name: task.name,
      status: "",
      startedAt: new Date(0),
      result: task.prompt,
    });
  }
}

Deno.test("runner executes JavaScript workflow", async () => {
  const host = new FakeHost({
    api: "api findings",
    channels: "channels findings",
  });
  const r = new Runner({ host, concurrency: 2, now: fixedClock() });
  const state = await r.run(
    `workflow("auth audit", {concurrency:2, phases:[phase("scan", parallel(agent("api", {mode:"plan", tools:["read","grep"], prompt:"scan api"}), agent("channels", {mode:"plan", tools:["read","grep"], prompt:"scan channels"}))), phase("verify", agent("cross-check", {mode:"plan", prompt:"verify prior findings"}))]});`,
  );
  assertEquals(state.status, statusDone);
  assertEquals(state.results!["scan.api"].result, "api findings");
  assert(host.maxRunning <= 2, `max=${host.maxRunning}`);
});

Deno.test("runner rejects invalid JavaScript agent option", async () => {
  const r = new Runner({ host: new FakeHost(), now: fixedClock() });
  const err = await assertRejects(
    () =>
      r.run(
        `workflow("bad",{phases:[phase("scan",agent("worker",{prompt:"bad",unknown:true}))]});`,
      ),
  );
  assertStringIncludes((err as Error).message, "unknown agent option");
});

Deno.test("runner reports missing result", async () => {
  const r = new Runner({ host: new FakeHost(), now: fixedClock() });
  await assertRejects(
    () =>
      r.run(
        `workflow("bad",{phases:[phase("verify",agent("cross-check",{prompt:result("scan.missing")}))]});`,
      ),
  );
});

Deno.test("runner concurrency limit and semaphore reuse", async () => {
  const host = new FakeHost();
  const r = new Runner({ host, concurrency: 1, now: fixedClock() });
  const state = await r.run(
    `workflow("bounded", {phases:[phase("p", parallel(agent("a", {prompt:"a"}), agent("b", {prompt:"b"}), agent("c", {prompt:"c"})))]});`,
  );
  assertEquals(state.status, statusDone);
  assertEquals(host.maxRunning, 1);

  const host2 = new FakeHost();
  const r2 = new Runner({ host: host2, concurrency: 2, now: fixedClock() });
  const state2 = await r2.run(
    `workflow("bounded2", {phases:[phase("p", parallel(agent("a", {prompt:"a"}), agent("b", {prompt:"b"}), agent("c", {prompt:"c"})))]});`,
  );
  assertEquals(state2.status, statusDone);
  assertEquals(host2.maxRunning, 2);
});

Deno.test("runner keyed results and fan-in", async () => {
  const host = new PromptHost();
  const r = new Runner({ host, concurrency: 2, now: fixedClock() });
  const state = await r.run(
    `workflow("keyed", {phases:[phase("scan", [agent("worker", {key:"r0", prompt:"item 0"}), agent("worker", {key:"r1", prompt:"item 1"})]), phase("verify", agent("check", {prompt:results("scan")}))]});`,
  );
  assertEquals(state.results!["scan.worker[r0]"].status, statusDone);
  assertEquals(state.results!["scan.worker[r1]"].status, statusDone);
  const prompt = host.prompts["check"];
  assertStringIncludes(prompt, "item 0");
  assertStringIncludes(prompt, "scan.worker[r1]:");
});

Deno.test("parallel aggregates failures and cancels siblings", async () => {
  let failOnce = false;
  const host: Host = {
    async runAgent(
      task: AgentTask,
      signal?: AbortSignal,
    ): Promise<AgentResult> {
      if (task.name === "fail") {
        failOnce = true;
        throw new Error("boom");
      }
      await sleep(1000, signal);
      return {
        key: "",
        name: task.name,
        status: "",
        startedAt: new Date(0),
      };
    },
  };
  const r = new Runner({ host, concurrency: 3, now: fixedClock() });
  let message = "";
  try {
    await r.run(
      `workflow("parallel", {phases:[phase("p", parallel(agent("fail", {prompt:"fail"}), agent("wait-a", {prompt:"wait"}), agent("wait-b", {prompt:"wait"})))]});`,
    );
  } catch (err) {
    message = (err as Error).message;
  }
  assertStringIncludes(message, "boom");
  assert(failOnce);
});

Deno.test("file store persists loads and lists workflow state", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const store = newFileStore(dir);
    const started = new Date(Date.UTC(2026, 7, 7, 12, 0, 0, 0));
    const state = {
      id: "run-1",
      name: "demo",
      status: statusDone,
      startedAt: started,
      updatedAt: started,
      results: {
        "p.a": {
          key: "p.a",
          name: "a",
          status: statusDone,
          result: "ok",
          startedAt: started,
        },
      },
    };
    await store.save(state);
    const loaded = await store.load("run-1");
    assertEquals(loaded.results!["p.a"].result, "ok");
    const listed = await store.list();
    assertEquals(listed.length, 1);
    assertEquals(listed[0].id, "run-1");
    await assertRejects(() =>
      store.save({
        id: "",
        name: "",
        status: statusDone,
        startedAt: started,
        updatedAt: started,
      })
    );
    await assertRejects(() => store.load("../escape"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("file store instance exposes the class", () => {
  const store = new FileStore("/tmp/x");
  assert(store instanceof FileStore);
});

Deno.test("results status constants are stable", () => {
  assertEquals(statusRunning, "running");
  assertEquals(statusError, "error");
});
