// the `speedtest` benchmark. Runs
// text-only streaming requests against configured provider/model pairs,
// averages successful runs, and prints a sorted table by output tokens/s.
// Pure helpers (target collection, averaging, formatting) are exported so the
// table projection is testable without a live provider.

import { create } from "../provider/factory/factory.ts";
import {
  type ChatParams,
  createUserMessage,
  type Model,
  type Provider,
  streamDone,
  streamError,
  type StreamEvent,
  streamTextDelta,
  streamThinkDelta,
  streamUsage,
  type ThinkingLevel,
  type Usage,
} from "../provider/mod.ts";
import {
  getProviderConfig,
  getSessionDir,
  loadSettings,
  type Settings,
} from "../config/mod.ts";
import * as path from "@std/path";

export const DEFAULT_SPEEDTEST_PROMPT =
  "Reply with exactly 120 English words about terminal software performance. Do not use markdown, lists, or code.";

export interface SpeedtestFlags {
  provider: string;
  model: string;
  prompt: string;
  maxTokens: number;
  timeoutMs: number;
  concurrency: number;
  runs: number;
  thinking: string;
}

export function defaultSpeedtestFlags(): SpeedtestFlags {
  return {
    provider: "",
    model: "",
    prompt: DEFAULT_SPEEDTEST_PROMPT,
    maxTokens: 256,
    timeoutMs: 2 * 60 * 1000,
    concurrency: 1,
    runs: 3,
    thinking: "off",
  };
}

export interface SpeedtestTarget {
  provider: string;
  modelId: string;
  modelName: string;
}

export interface SpeedtestRequestOptions {
  prompt: string;
  maxTokens: number;
  thinkingLevel: ThinkingLevel;
}

export interface SpeedtestResult {
  target: SpeedtestTarget;
  tokensPerSecond: number;
  networkLatencyMs: number;
  firstTokenLatencyMs: number;
  totalDurationMs: number;
  outputTokens: number;
  estimatedTokens: boolean;
  stopReason: string;
  error: string | null;
}

const VALID_THINKING_LEVELS: ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export function parseSpeedtestThinkingLevel(
  level: string,
): ThinkingLevel {
  const normalized = level.trim() as ThinkingLevel;
  if (VALID_THINKING_LEVELS.includes(normalized)) return normalized;
  throw new Error(
    `invalid --thinking "${level}" (use off, minimal, low, medium, high, xhigh, or max)`,
  );
}

/** Collects provider/model pairs from settings honoring --provider/--model. */
export function collectSpeedtestTargets(
  settings: Settings,
  flags: SpeedtestFlags,
): SpeedtestTarget[] {
  const targets: SpeedtestTarget[] = [];
  const seen = new Set<string>();
  for (const [providerName, pc] of Object.entries(settings.providers ?? {})) {
    if (pc === undefined || pc === null) continue;
    if (flags.provider !== "" && providerName !== flags.provider) continue;
    if (!speedtestProviderConfigured(settings, providerName)) continue;

    for (const model of pc.models ?? []) {
      if (!model || model.id.trim() === "") continue;
      if (flags.model !== "" && model.id !== flags.model) continue;
      const key = `${providerName}\u0000${model.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push({
        provider: providerName,
        modelId: model.id,
        modelName: model.name ?? "",
      });
    }

    const models = pc.models ?? [];
    if (models.length === 0) {
      let modelId = flags.model;
      if (modelId === "" && providerName === settings.defaultProvider) {
        modelId = settings.defaultModel ?? "";
      }
      if (modelId === "") continue;
      const key = `${providerName}\u0000${modelId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push({ provider: providerName, modelId, modelName: "" });
    }
  }
  targets.sort((a, b) =>
    a.provider !== b.provider
      ? a.provider.localeCompare(b.provider)
      : a.modelId.localeCompare(b.modelId)
  );
  return targets;
}

function speedtestProviderConfigured(
  settings: Settings,
  providerName: string,
): boolean {
  const pc = getProviderConfig(settings, providerName);
  if (pc === undefined || pc === null) return false;
  if (resolvedCredentialConfigured(pc.apiKey ?? "")) return true;
  for (const value of Object.values(pc.headers ?? {})) {
    if (resolvedCredentialConfigured(String(value))) return true;
  }
  return false;
}

function resolvedCredentialConfigured(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === "") return false;
  return !(trimmed.startsWith("${") && trimmed.endsWith("}"));
}

/**
 * Runs one target's request cycle `runs` times (with the per-run timeout) and
 * averages successful runs into a single result.
 */
export async function runSpeedtestRuns(
  provider: Provider,
  model: Model | undefined,
  target: SpeedtestTarget,
  opts: SpeedtestRequestOptions,
  timeoutMs: number,
  runs: number,
): Promise<SpeedtestResult> {
  const results: SpeedtestResult[] = [];
  for (let i = 0; i < runs; i++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const result = await runSpeedtestRequest(
        provider,
        model,
        target,
        opts,
        controller.signal,
      );
      results.push(result);
    } finally {
      clearTimeout(timer);
    }
  }
  return averageSpeedtestResults(results);
}

/** Averages successful runs; keeps the first error when none succeed. */
export function averageSpeedtestResults(
  results: SpeedtestResult[],
): SpeedtestResult {
  if (results.length === 0) {
    return {
      target: { provider: "", modelId: "", modelName: "" },
      tokensPerSecond: 0,
      networkLatencyMs: 0,
      firstTokenLatencyMs: 0,
      totalDurationMs: 0,
      outputTokens: 0,
      estimatedTokens: false,
      stopReason: "",
      error: "no speedtest runs",
    };
  }
  const out: SpeedtestResult = { ...results[0] };
  let tps = 0;
  let network = 0;
  let first = 0;
  let total = 0;
  let tokens = 0;
  let count = 0;
  for (const result of results) {
    if (result.error !== null) continue;
    count++;
    tps += result.tokensPerSecond;
    network += result.networkLatencyMs;
    first += result.firstTokenLatencyMs;
    total += result.totalDurationMs;
    tokens += result.outputTokens;
    out.stopReason = result.stopReason;
    out.error = null;
    out.estimatedTokens = out.estimatedTokens || result.estimatedTokens;
  }
  if (count === 0) return out;
  out.tokensPerSecond = tps / count;
  out.networkLatencyMs = network / count;
  out.firstTokenLatencyMs = first / count;
  out.totalDurationMs = total / count;
  out.outputTokens = Math.round(tokens / count);
  return out;
}

/** Streams one chat request and measures rate/latency/token counts. */
export async function runSpeedtestRequest(
  provider: Provider,
  model: Model | undefined,
  target: SpeedtestTarget,
  opts: SpeedtestRequestOptions,
  signal: AbortSignal,
): Promise<SpeedtestResult> {
  const result: SpeedtestResult = {
    target: { ...target },
    tokensPerSecond: 0,
    networkLatencyMs: 0,
    firstTokenLatencyMs: 0,
    totalDurationMs: 0,
    outputTokens: 0,
    estimatedTokens: false,
    stopReason: "",
    error: null,
  };
  if (model !== undefined) {
    result.target.modelId = model.id;
    if (result.target.modelName === "") {
      result.target.modelName = model.name ?? "";
    }
  }

  let maxTokens = opts.maxTokens;
  if (
    model !== undefined && (model.maxTokens ?? 0) > 0 &&
    maxTokens > (model.maxTokens ?? 0)
  ) {
    maxTokens = model.maxTokens ?? maxTokens;
  }

  const params: ChatParams = {
    messages: [createUserMessage(opts.prompt)],
    systemPrompt: "",
    thinkingLevel: opts.thinkingLevel,
    maxTokens,
    modelId: result.target.modelId,
    abort: signal,
  };
  if (model !== undefined) {
    params.temperature = model.temperature;
    params.topP = model.topP;
  }

  const start = performance.now();
  let firstTokenAt = -1;
  let output = "";
  let usage: Usage | undefined;
  let streamErr: string | null = null;
  let stopReason = "";

  const stream: AsyncIterable<StreamEvent> = provider.chat(params);
  for await (const ev of stream) {
    if (ev.type === streamTextDelta) {
      if (
        ev.textDelta !== undefined && ev.textDelta !== "" && firstTokenAt < 0
      ) {
        firstTokenAt = performance.now();
      }
      output += ev.textDelta ?? "";
    } else if (ev.type === streamThinkDelta) {
      if (
        ev.thinkDelta !== undefined && ev.thinkDelta !== "" && firstTokenAt < 0
      ) {
        firstTokenAt = performance.now();
      }
      output += ev.thinkDelta ?? "";
    } else if (ev.type === streamUsage) {
      if (ev.usage !== undefined) usage = ev.usage;
    } else if (ev.type === streamDone) {
      stopReason = ev.stopReason ?? "";
    } else if (ev.type === streamError) {
      streamErr = ev.error?.message ?? "stream error";
      if (ev.stopReason !== undefined && ev.stopReason !== "") {
        stopReason = ev.stopReason;
      }
    }
  }
  const end = performance.now();

  result.stopReason = stopReason;
  result.totalDurationMs = end - start;
  if (firstTokenAt >= 0) result.firstTokenLatencyMs = firstTokenAt - start;
  const tokens = speedtestOutputTokens(usage, output);
  result.outputTokens = tokens.tokens;
  result.estimatedTokens = tokens.estimated;
  if (streamErr !== null) {
    result.error = streamErr;
    return result;
  }
  if (firstTokenAt < 0) {
    result.error = "no streamed text tokens received";
    return result;
  }
  if (result.outputTokens <= 0) {
    result.error = "no output tokens measured";
    return result;
  }
  const generationDuration = Math.max(end - firstTokenAt, 1);
  result.tokensPerSecond = result.outputTokens / (generationDuration / 1000);
  return result;
}

function speedtestOutputTokens(
  usage: Usage | undefined,
  output: string,
): { tokens: number; estimated: boolean } {
  if (usage !== undefined && usage.output > 0) {
    return { tokens: usage.output, estimated: false };
  }
  return { tokens: estimateSpeedtestTokens(output), estimated: true };
}

export function estimateSpeedtestTokens(output: string): number {
  const trimmed = output.trim();
  if (trimmed === "") return 0;
  const words = trimmed.split(/\s+/).length;
  const runes = Array.from(trimmed).length;
  const byRunes = Math.ceil(runes / 4);
  return words > byRunes ? words : byRunes;
}

/** Successful runs first by rate desc, then provider/model asc. */
export function sortSpeedtestResults(results: SpeedtestResult[]): void {
  results.sort((a, b) => {
    const aOK = a.error === null;
    const bOK = b.error === null;
    if (aOK !== bOK) return aOK ? -1 : 1;
    if (aOK && a.tokensPerSecond !== b.tokensPerSecond) {
      return b.tokensPerSecond - a.tokensPerSecond;
    }
    if (a.target.provider !== b.target.provider) {
      return a.target.provider.localeCompare(b.target.provider);
    }
    return a.target.modelId.localeCompare(b.target.modelId);
  });
}

export function countSpeedtestSuccesses(results: SpeedtestResult[]): number {
  return results.filter((r) => r.error === null).length;
}

// ─── output projection ──────────────────────────────────────────────────────

export function printSpeedtestProgress(
  write: (line: string) => void,
  result: SpeedtestResult,
): void {
  const name = `${result.target.provider}/${result.target.modelId}`;
  if (result.error !== null) {
    write(`err ${name}: ${shortSpeedtestError(result.error)}`);
    return;
  }
  write(
    `ok  ${name}: ${formatSpeedtestRate(result.tokensPerSecond)} token/s, ` +
      `network ${formatSpeedtestDuration(result.networkLatencyMs)}, ` +
      `first token ${formatSpeedtestDuration(result.firstTokenLatencyMs)}`,
  );
}

/** Renders the aligned results table (text/tabwriter shape, 2-col gap). */
export function printSpeedtestResults(
  write: (line: string) => void,
  results: SpeedtestResult[],
): void {
  const header = [
    "Provider",
    "Model",
    "Token/s",
    "Network",
    "First token",
    "Total",
    "Output",
    "Status",
  ].join("\t");
  const rows = results.map((result) =>
    [
      result.target.provider,
      result.target.modelId,
      formatSpeedtestRate(result.tokensPerSecond),
      formatSpeedtestDuration(result.networkLatencyMs),
      formatSpeedtestDuration(result.firstTokenLatencyMs),
      formatSpeedtestDuration(result.totalDurationMs),
      formatSpeedtestOutput(result.outputTokens, result.estimatedTokens),
      formatSpeedtestStatus(result),
    ].join("\t")
  );
  for (const line of alignTabColumns([header, ...rows])) write(line);
}

function alignTabColumns(lines: string[]): string[] {
  const split = lines.map((line) => line.split("\t"));
  const columns = Math.max(...split.map((cells) => cells.length));
  const widths = new Array<number>(columns).fill(0);
  for (const cells of split) {
    cells.forEach((cell, i) => {
      if (i < cells.length - 1) widths[i] = Math.max(widths[i], cell.length);
    });
  }
  return split.map((cells) =>
    cells.map((cell, i) =>
      i === cells.length - 1 ? cell : cell.padEnd(widths[i] + 2, " ")
    ).join("")
  );
}

export function formatSpeedtestRate(rate: number): string {
  if (rate <= 0) return "--";
  return rate.toFixed(1);
}

export function formatSpeedtestDuration(ms: number): string {
  if (ms <= 0) return "--";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function formatSpeedtestOutput(tokens: number, estimated: boolean): string {
  if (tokens <= 0) return "--";
  return estimated ? `~${tokens}` : String(tokens);
}

function formatSpeedtestStatus(result: SpeedtestResult): string {
  if (result.error !== null) return shortSpeedtestError(result.error);
  if (result.stopReason !== "") return result.stopReason;
  return "ok";
}

function shortSpeedtestError(error: string): string {
  const text = error.split(/\s+/).join(" ");
  const limit = 120;
  if (text.length <= limit) return text;
  return text.slice(0, limit - 3) + "...";
}

// ─── command entry ──────────────────────────────────────────────────────────

export interface SpeedtestCommandOptions extends SpeedtestFlags {
  write?: (line: string) => void;
  writeError?: (line: string) => void;
  /** Overrides provider construction (tests). */
  providerFor?: (
    settings: Settings,
    providerName: string,
    modelId: string,
  ) => { provider: Provider; model: Model };
  /** Overrides network latency probing (tests). */
  measureNetwork?: (providerName: string) => number;
}

/** Executes the speedtest command; throws on invalid flags or total failure. */
export async function executeSpeedtestCommand(
  partial: Partial<SpeedtestCommandOptions> = {},
): Promise<void> {
  const flags: SpeedtestCommandOptions = {
    ...defaultSpeedtestFlags(),
    ...partial,
  };
  const write = flags.write ?? ((line: string) => console.log(line));
  const writeError = flags.writeError ??
    ((line: string) => console.error(line));

  if (flags.maxTokens <= 0) {
    throw new Error("--max-tokens must be greater than 0");
  }
  if (flags.timeoutMs <= 0) {
    throw new Error("--timeout must be greater than 0");
  }
  if (flags.concurrency <= 0) {
    throw new Error("--concurrency must be greater than 0");
  }
  if (flags.runs <= 0) {
    throw new Error("--runs must be greater than 0");
  }
  const thinkingLevel = parseSpeedtestThinkingLevel(flags.thinking);

  const settings = loadSettings();
  const targets = collectSpeedtestTargets(settings, flags);
  if (targets.length === 0) {
    throw new Error("no configured provider/model pairs found");
  }

  const requestOpts: SpeedtestRequestOptions = {
    prompt: flags.prompt,
    maxTokens: flags.maxTokens,
    thinkingLevel,
  };
  writeError(
    `Running text speedtest for ${targets.length} model(s), ${flags.runs} run(s) each...`,
  );

  const results: SpeedtestResult[] = [];
  for (const target of targets) {
    try {
      if (flags.providerFor !== undefined) {
        const created = flags.providerFor(
          settings,
          target.provider,
          target.modelId,
        );
        const result = await runSpeedtestRuns(
          created.provider,
          created.model,
          target,
          requestOpts,
          flags.timeoutMs,
          flags.runs,
        );
        result.networkLatencyMs = flags.measureNetwork !== undefined
          ? flags.measureNetwork(target.provider)
          : 0;
        results.push(result);
      } else {
        const created = create(
          settings,
          target.provider,
          target.modelId,
          { requireModel: true },
        );
        const result = await runSpeedtestRuns(
          created.provider,
          created.model,
          target,
          requestOpts,
          flags.timeoutMs,
          flags.runs,
        );
        result.networkLatencyMs = flags.measureNetwork !== undefined
          ? flags.measureNetwork(target.provider)
          : 0;
        results.push(result);
      }
    } catch (err) {
      results.push({
        target,
        tokensPerSecond: 0,
        networkLatencyMs: 0,
        firstTokenLatencyMs: 0,
        totalDurationMs: 0,
        outputTokens: 0,
        estimatedTokens: false,
        stopReason: "",
        error: (err as Error).message,
      });
    }
    printSpeedtestProgress(writeError, results[results.length - 1]);
  }

  sortSpeedtestResults(results);
  printSpeedtestResults(write, results);
  if (countSpeedtestSuccesses(results) === 0) {
    throw new Error("all speedtest requests failed");
  }
}

/** Resolves the default sessions.db path used by --db-less invocations. */
export function defaultSpeedtestSessionsDB(): string {
  return path.join(getSessionDir(loadSettings()), "sessions.db");
}
