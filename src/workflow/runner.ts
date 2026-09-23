// internal/workflow/js.go (resolveJSValue, lookupResult, resultsText, logs).
//
// `context.Context` maps to `AbortSignal`; Go goroutines/channels map to
// async/Promise with a small async semaphore; `sync.RWMutex` is dropped (Deno
// is single-threaded). `errors.Join` maps to an AggregateError whose message
// concatenates the joined errors.

import { type ActiveRegistry, defaultActiveRegistry } from "./active.ts";
import {
  evalJsWorkflowWithin,
  isJsExpr,
  jsEvalTimeoutMs,
  type JsExpr,
  type JsNode,
} from "./js.ts";
import {
  abortError,
  type AgentResult,
  type AgentTask,
  type Host,
  isCanceled,
  type ProgressEvent,
  type RunState,
  statusCanceled,
  statusDone,
  statusError,
  statusRunning,
  type Store,
  throwIfAborted,
} from "./types.ts";

/** A semaphore that bounds concurrent worker agents. */
class Semaphore {
  #cap: number;
  #used = 0;
  #waiters: (() => void)[] = [];

  constructor(cap: number) {
    this.#cap = cap;
  }

  async acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw abortError();
    if (this.#used < this.#cap) {
      this.#used++;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const waiter = () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      const onAbort = () => {
        const i = this.#waiters.indexOf(waiter);
        if (i >= 0) this.#waiters.splice(i, 1);
        reject(abortError());
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#waiters.push(waiter);
    });
  }

  release(): void {
    const next = this.#waiters.shift();
    if (next !== undefined) {
      next();
    } else if (this.#used > 0) {
      this.#used--;
    }
  }
}

/** Configuration for a Runner. */
export interface RunnerConfig {
  host?: Host;
  store?: Store;
  active?: ActiveRegistry;
  concurrency?: number;
  now?: () => Date;
  progress?: (ev: ProgressEvent) => void;
  evalTimeoutMs?: number;
}

/** Evaluates the JavaScript workflow DSL and delegates agent tasks to a Host. */
export class Runner {
  host?: Host;
  store?: Store;
  active?: ActiveRegistry;
  concurrency: number;
  now: () => Date;
  progress?: (ev: ProgressEvent) => void;
  evalTimeoutMs: number;

  constructor(cfg: RunnerConfig = {}) {
    this.host = cfg.host;
    this.store = cfg.store;
    this.active = cfg.active;
    this.concurrency = cfg.concurrency ?? 0;
    this.now = cfg.now ?? (() => new Date());
    this.progress = cfg.progress;
    this.evalTimeoutMs = cfg.evalTimeoutMs ?? 0;
  }

  /** Evaluates a workflow source string and returns its final state. */
  async run(source: string, signal?: AbortSignal): Promise<RunState> {
    if (this.host === undefined || this.host === null) {
      throw new Error("workflow host is required");
    }
    const cancelController = new AbortController();
    const combined = signal !== undefined
      ? AbortSignal.any([signal, cancelController.signal])
      : cancelController.signal;
    const now = this.now();
    const rt = new WorkflowRuntime(this, {
      id: "",
      name: "",
      status: statusRunning,
      startedAt: now,
      updatedAt: now,
      phases: [],
      results: {},
      logs: [],
    }, () => cancelController.abort());
    if (this.concurrency > 0) rt.concurrency = this.concurrency;
    if (rt.concurrency <= 0) rt.concurrency = 5;

    try {
      const wf = await evalJsWorkflowWithin(
        source,
        this.evalTimeoutMs > 0 ? this.evalTimeoutMs : jsEvalTimeoutMs,
        combined,
      );
      rt.state.name = wf.name;
      rt.state.id = makeRunId(wf.name, now);
      if (wf.concurrency > 0) rt.concurrency = wf.concurrency;
      await rt.save(combined);
      rt.registerActive();
      await rt.executeJSNodes(combined, wf.children, "", -1);
      rt.finish(statusDone, "");
      await rt.save(undefined);
      return rt.snapshot();
    } catch (err) {
      rt.markError(err);
      await safeSave(rt);
      if (err instanceof Error) {
        (err as Error & { workflowState?: RunState }).workflowState = rt
          .snapshot();
      }
      throw err;
    } finally {
      rt.unregisterActive();
    }
  }
}

/** The per-run execution state. */
export class WorkflowRuntime {
  runner: Runner;
  state: RunState;
  activeId = "";
  cancel: () => void;
  phase = "";
  phaseIndex = -1;
  concurrency: number;
  #sem: Semaphore | null = null;

  constructor(runner: Runner, state: RunState, cancel: () => void) {
    this.runner = runner;
    this.state = state;
    this.cancel = cancel;
    this.concurrency = runner.concurrency;
  }

  async runAgent(
    task: AgentTask,
    phaseIndex: number,
    signal?: AbortSignal,
  ): Promise<AgentResult> {
    const keyError = validateInstanceKey(task.instanceKey ?? "");
    if (keyError !== null) {
      throw new Error(`agent "${task.name}" :key: ${keyError}`);
    }
    const sem = this.#semaphore();
    await sem.acquire(signal);
    try {
      const key = taskStorageKey(
        task.phase ?? "",
        task.name,
        task.instanceKey ?? "",
      );
      const started = this.runner.now();
      this.recordTaskStart(key, phaseIndex);
      this.emitProgress({
        phase: task.phase,
        task: task.name,
        status: statusRunning,
        message: `task ${key} started`,
      });
      let result: AgentResult = {
        key: "",
        name: "",
        status: "",
        startedAt: started,
      };
      let runErr: unknown;
      try {
        result = await this.runner.host!.runAgent(task, signal);
      } catch (err) {
        runErr = err;
      }
      const finished = this.runner.now();
      if (result.key === undefined || result.key === "") result.key = key;
      result.name = task.name;
      result.phase = task.phase;
      result.instanceKey = task.instanceKey;
      if (result.startedAt === undefined || result.startedAt.getTime() <= 0) {
        result.startedAt = started;
      }
      if (result.finishedAt === undefined || result.finishedAt.getTime() <= 0) {
        result.finishedAt = finished;
      }
      result.duration = durationString(
        finished.getTime() - result.startedAt.getTime(),
      );
      if (runErr !== undefined) {
        result.status = statusForError(runErr);
        result.error = errorMessage(runErr);
      } else if (result.status === "") {
        result.status = statusDone;
      }
      this.recordResult(result);
      this.emitProgress({
        phase: task.phase,
        task: task.name,
        status: result.status,
        message: `task ${key} ${result.status}`,
      });
      await this.save(signal);
      if (runErr !== undefined) throw runErr;
      return result;
    } finally {
      sem.release();
    }
  }

  #semaphore(): Semaphore {
    if (this.#sem === null) {
      this.#sem = new Semaphore(this.concurrency);
    }
    return this.#sem;
  }

  startPhase(name: string): number {
    const now = this.runner.now();
    this.state.phases!.push({ name, status: statusRunning, startedAt: now });
    this.state.updatedAt = now;
    const idx = this.state.phases!.length - 1;
    this.emitProgress({
      phase: name,
      status: statusRunning,
      message: `phase "${name}" started`,
    });
    return idx;
  }

  finishPhase(idx: number, status: string, msg: string): void {
    const now = this.runner.now();
    const phases = this.state.phases!;
    if (idx >= 0 && idx < phases.length) {
      phases[idx].status = status;
      phases[idx].finishedAt = now;
      phases[idx].error = msg;
      this.emitProgress({
        phase: phases[idx].name,
        status,
        message: `phase "${phases[idx].name}" ${status}`,
      });
    }
    this.state.updatedAt = now;
  }

  recordTaskStart(key: string, phaseIndex: number): void {
    const phases = this.state.phases!;
    if (phaseIndex >= 0 && phaseIndex < phases.length) {
      (phases[phaseIndex].tasks ??= []).push(key);
    }
    this.state.updatedAt = this.runner.now();
  }

  recordResult(result: AgentResult): void {
    (this.state.results ??= {})[result.key] = result;
    this.state.updatedAt = this.runner.now();
  }

  markError(err: unknown): void {
    this.finish(statusForError(err), errorMessage(err));
  }

  finish(status: string, msg: string): void {
    const now = this.runner.now();
    this.state.status = status;
    this.state.error = msg;
    this.state.updatedAt = now;
    this.state.finishedAt = now;
    let message = `workflow ${status}`;
    if (msg !== "") message += ": " + msg;
    this.emitProgress({ status, message });
  }

  emitProgress(ev: ProgressEvent): void {
    this.emitProgressLocked(ev);
  }

  emitProgressLocked(ev: ProgressEvent): void {
    const progress = this.runner.progress;
    if (progress === undefined || progress === null) return;
    if (ev.runId === undefined || ev.runId === "") ev.runId = this.state.id;
    if (ev.name === undefined || ev.name === "") ev.name = this.state.name;
    if (ev.phase === undefined || ev.phase === "") ev.phase = this.phase;
    if (ev.time === undefined) ev.time = this.runner.now();
    progress(ev);
  }

  snapshot(): RunState {
    const state = this.state;
    const results: Record<string, AgentResult> = {};
    for (const [k, v] of Object.entries(state.results ?? {})) results[k] = v;
    return {
      ...state,
      phases: [...(state.phases ?? [])],
      logs: [...(state.logs ?? [])],
      results,
    };
  }

  async save(signal?: AbortSignal): Promise<void> {
    const store = this.runner.store;
    if (store === undefined || store === null) return;
    await store.save(this.snapshot(), signal);
  }

  activeRegistry(): ActiveRegistry {
    return this.runner.active ?? defaultActiveRegistry();
  }

  registerActive(): void {
    const id = this.state.id;
    if (this.activeId === id) return;
    this.activeId = id;
    this.activeRegistry().register(id, this.cancel);
  }

  unregisterActive(): void {
    const id = this.activeId;
    this.activeId = "";
    this.activeRegistry().unregister(id);
  }

  async executeJSNodes(
    signal: AbortSignal | undefined,
    nodes: JsNode[],
    phase: string,
    phaseIndex: number,
  ): Promise<void> {
    for (const node of nodes) {
      if (node === null || node === undefined) continue;
      switch (node.kind) {
        case "phase": {
          const idx = this.startPhase(node.name);
          try {
            await this.executeJSNodes(signal, node.children, node.name, idx);
          } catch (err) {
            this.finishPhase(idx, statusForError(err), errorMessage(err));
            throw err;
          }
          this.finishPhase(idx, statusDone, "");
          break;
        }
        case "parallel": {
          const ac = new AbortController();
          const pSignal = signal !== undefined
            ? AbortSignal.any([signal, ac.signal])
            : ac.signal;
          const errs: unknown[] = [];
          await Promise.all(node.children.map(async (child) => {
            if (child === null || child === undefined) return;
            try {
              await this.executeJSNodes(
                pSignal,
                [child],
                phase,
                phaseIndex,
              );
            } catch (err) {
              errs.push(err);
              ac.abort();
            }
          }));
          if (errs.length > 1) {
            const nonCanceled = errs.filter((e) => !isCanceled(e));
            if (nonCanceled.length > 0) {
              throw joinErrors(nonCanceled);
            }
          }
          if (errs.length > 0) {
            throw joinErrors(errs);
          }
          break;
        }
        case "series":
          await this.executeJSNodes(signal, node.children, phase, phaseIndex);
          break;
        case "agent": {
          const task: AgentTask = { name: node.name, phase, prompt: "" };
          for (const [key, value] of Object.entries(node.opts)) {
            const resolved = await resolveJsValue(this, signal, value);
            applyJsAgentOption(task, key, resolved);
          }
          if (task.prompt === "") {
            throw new Error(`agent "${task.name}" requires prompt`);
          }
          await this.runAgent(task, phaseIndex, signal);
          break;
        }
      }
    }
  }

  // --- Result lookup / logs (from js.go) ----------------------------------

  resolveJsValue(
    signal: AbortSignal | undefined,
    value: unknown,
  ): Promise<unknown> {
    return resolveJsValue(this, signal, value);
  }

  lookupResult(baseKey: string, instanceKey: string): [AgentResult, boolean] {
    if (instanceKey !== "") {
      return this.resultByStorageKey(
        resultStorageKey(baseKey, instanceKey),
      );
    }
    const direct = this.resultByStorageKey(baseKey);
    if (direct[1]) return direct;
    return this.latestResultForBase(baseKey);
  }

  resultByStorageKey(key: string): [AgentResult, boolean] {
    const result = this.state.results?.[key];
    return result === undefined ? [emptyResult(), false] : [result, true];
  }

  latestResultForBase(baseKey: string): [AgentResult, boolean] {
    let latest = emptyResult();
    let found = false;
    for (const result of Object.values(this.state.results ?? {})) {
      if (!resultMatchesBase(result, baseKey)) continue;
      if (
        !found ||
        result.startedAt.getTime() > latest.startedAt.getTime() ||
        (result.finishedAt?.getTime() ?? 0) >
          (latest.finishedAt?.getTime() ?? 0)
      ) {
        latest = result;
        found = true;
      }
    }
    return [latest, found];
  }

  resultsText(query: string): string {
    const results = Object.values(this.state.results ?? {}).filter((res) =>
      resultMatchesBase(res, query) || res.phase === query
    );
    results.sort((a, b) => {
      if (a.startedAt.getTime() === b.startedAt.getTime()) {
        return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
      }
      return a.startedAt.getTime() - b.startedAt.getTime();
    });
    let out = "";
    for (const res of results) {
      if (out !== "") out += "\n\n";
      out += res.key + ":\n" + (res.result ?? "");
    }
    return out;
  }

  appendLog(msg: string): void {
    const now = this.runner.now();
    (this.state.logs ??= []).push({ time: now, message: msg });
    this.state.updatedAt = now;
    this.emitProgressLocked({ status: statusRunning, message: msg });
  }
}

function emptyResult(): AgentResult {
  return { key: "", name: "", status: "", startedAt: new Date(0) };
}

/** Resolves a deferred workflow expression or nested value. */
export async function resolveJsValue(
  rt: WorkflowRuntime,
  signal: AbortSignal | undefined,
  value: unknown,
): Promise<unknown> {
  throwIfAborted(signal);
  if (value === null || value === undefined) return null;
  if (isJsExpr(value)) {
    return resolveExpr(rt, signal, value);
  }
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) {
      out.push(await resolveJsValue(rt, signal, item));
    }
    return out;
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, item] of Object.entries(value as Record<string, unknown>)) {
      out[k] = await resolveJsValue(rt, signal, item);
    }
    return out;
  }
  return value;
}

async function resolveExpr(
  rt: WorkflowRuntime,
  signal: AbortSignal | undefined,
  expr: JsExpr,
): Promise<unknown> {
  const str = async (i: number): Promise<string> => {
    const x = await resolveJsValue(rt, signal, expr.args[i]);
    if (typeof x !== "string") {
      throw new Error(`${expr.expr} expects a string`);
    }
    return x;
  };
  switch (expr.expr) {
    case "result": {
      const s = await str(0);
      const [r, ok] = rt.lookupResult(s, "");
      if (!ok) {
        throw new Error(`workflow result ${JSON.stringify(s)} not found`);
      }
      return r.result ?? "";
    }
    case "resultKey": {
      const s = await str(0);
      const k = await str(1);
      const keyError = validateInstanceKey(k);
      if (keyError !== null) throw new Error(keyError);
      const [r, ok] = rt.lookupResult(s, k);
      if (!ok) {
        throw new Error(
          `workflow result ${JSON.stringify(s)} with key ${
            JSON.stringify(k)
          } not found`,
        );
      }
      return r.result ?? "";
    }
    case "resultLatest": {
      const s = await str(0);
      const [r, ok] = rt.latestResultForBase(s);
      if (!ok) {
        throw new Error(`workflow result ${JSON.stringify(s)} not found`);
      }
      return r.result ?? "";
    }
    case "results": {
      const s = await str(0);
      return rt.resultsText(s);
    }
    case "log": {
      const parts: string[] = [];
      for (const arg of expr.args) {
        parts.push(stringify(await resolveJsValue(rt, signal, arg)));
      }
      const s = parts.join(" ");
      rt.appendLog(s);
      return s;
    }
    case "concurrency":
      return expr.args[0];
    default:
      throw new Error(`unknown workflow expression ${expr.expr}`);
  }
}

function applyJsAgentOption(
  task: AgentTask,
  key: string,
  value: unknown,
): void {
  switch (key) {
    case "prompt":
      task.prompt = stringify(value);
      break;
    case "mode":
      task.mode = stringify(value);
      break;
    case "workDir":
      task.workDir = stringify(value);
      break;
    case "tools":
      if (Array.isArray(value)) {
        task.tools = value.map((x) => stringify(x));
      } else {
        throw new Error("tools expects an array");
      }
      break;
    case "maxIterations":
      task.maxIterations = Math.trunc(toNumber(value));
      break;
    case "key":
      task.instanceKey = stringify(value);
      {
        const keyError = validateInstanceKey(task.instanceKey);
        if (keyError !== null) throw new Error(keyError);
      }
      break;
    case "systemPromptExtra":
      task.systemPromptExtra = stringify(value);
      break;
    default:
      throw new Error(`unknown agent option ${key}`);
  }
}

function toNumber(v: unknown): number {
  return typeof v === "number" ? v : 0;
}

function stringify(v: unknown): string {
  if (v === null || v === undefined) return v === null ? "null" : "undefined";
  return String(v);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function joinErrors(errs: unknown[]): Error {
  const messages = errs.map((e) => errorMessage(e));
  return new AggregateError(errs, messages.join("\n"));
}

function statusForError(err: unknown): string {
  return isCanceled(err) ? statusCanceled : statusError;
}

function durationString(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  return `${seconds}s`;
}

/** Builds the storage key for a task (phase.name[instanceKey]). */
export function taskStorageKey(
  phase: string,
  name: string,
  instanceKey: string,
): string {
  let base = name;
  if (phase !== "") base = phase + "." + name;
  return resultStorageKey(base, instanceKey);
}

/** Appends the instance key to a base result key. */
export function resultStorageKey(baseKey: string, instanceKey: string): string {
  if (instanceKey === "") return baseKey;
  return baseKey + "[" + instanceKey + "]";
}

/** Returns the phase-qualified base key of a result. */
export function resultBaseKey(result: AgentResult): string {
  if (result.phase === undefined || result.phase === "") return result.name;
  return result.phase + "." + result.name;
}

/** Reports whether a result matches a base key. */
export function resultMatchesBase(
  result: AgentResult,
  baseKey: string,
): boolean {
  return resultBaseKey(result) === baseKey || result.key === baseKey;
}

/** Validates an optional instance key. Returns null when valid. */
export function validateInstanceKey(key: string): string | null {
  if (key === "") return null;
  if (key.trim() !== key) {
    return "must not have leading or trailing whitespace";
  }
  if (/[\[\]\n\r\t]/.test(key)) {
    return "must not contain brackets or control whitespace";
  }
  return null;
}

/** Builds a slugged, timestamped workflow run id. */
export function makeRunId(name: string, date: Date): string {
  const slugInput = name.trim().toLowerCase();
  let builder = "";
  for (const ch of slugInput) {
    if ((ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9")) {
      builder += ch;
    } else if (ch === "-" || ch === "_") {
      builder += ch;
    } else if (builder.length > 0 && !builder.endsWith("-")) {
      builder += "-";
    }
  }
  let slug = builder.replace(/^-+/, "").replace(/-+$/, "");
  if (slug === "") slug = "workflow";
  return `${slug}-${formatUTCTimestamp(date)}`;
}

function formatUTCTimestamp(date: Date): string {
  const pad = (n: number, len: number) => String(n).padStart(len, "0");
  const y = date.getUTCFullYear();
  const mo = pad(date.getUTCMonth() + 1, 2);
  const d = pad(date.getUTCDate(), 2);
  const h = pad(date.getUTCHours(), 2);
  const mi = pad(date.getUTCMinutes(), 2);
  const s = pad(date.getUTCSeconds(), 2);
  const ns = pad(date.getUTCMilliseconds() * 1_000_000, 9);
  return `${y}${mo}${d}T${h}${mi}${s}.${ns}`;
}

async function safeSave(rt: WorkflowRuntime): Promise<void> {
  try {
    await rt.save(undefined);
  } catch {
    // Go logs the failure; state is already returned to the caller.
  }
}
