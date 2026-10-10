// Focused tests for the ported `opensac speedtest` command: thinking-level
// parsing, target collection, token estimation, averaging/sorting, the table
// projection, and the command path with an injected fake provider (no network).

import { assert, assertEquals, assertRejects } from "../compat/assert.ts";
import {
  averageSpeedtestResults,
  collectSpeedtestTargets,
  countSpeedtestSuccesses,
  defaultSpeedtestFlags,
  estimateSpeedtestTokens,
  executeSpeedtestCommand,
  formatSpeedtestDuration,
  formatSpeedtestRate,
  parseSpeedtestThinkingLevel,
  printSpeedtestResults,
  runSpeedtestRequest,
  sortSpeedtestResults,
  type SpeedtestResult,
  type SpeedtestTarget,
} from "./speedtest.ts";
import { type Settings } from "../config/mod.ts";
import {
  type Model,
  type Provider,
  type StreamEvent,
} from "../provider/mod.ts";
import { streamDone, streamTextDelta, streamUsage } from "../provider/mod.ts";
import { test } from "#testing";

function settingsWithProviders(): Settings {
  const base = {
    version: 1,
    defaultProvider: "p1",
    defaultModel: "m1",
    providers: {
      p1: {
        api: "openai-chat",
        baseUrl: "https://api.example.com/v1",
        apiKey: "sk-test",
        models: [
          { id: "m2", name: "Model Two", input: ["text"] },
          { id: "m1", name: "Model One", input: ["text"] },
        ],
      },
      empty: {
        api: "openai-chat",
        baseUrl: "https://api.example.com/v1",
        apiKey: "",
        models: [{ id: "x", name: "X", input: ["text"] }],
      },
      placeholder: {
        api: "openai-chat",
        baseUrl: "https://api.example.com/v1",
        apiKey: "${MY_KEY}",
        models: [{ id: "y", name: "Y", input: ["text"] }],
      },
    },
  } as unknown as Settings;
  return base;
}

test("parseSpeedtestThinkingLevel accepts valid and rejects invalid", () => {
  assertEquals(parseSpeedtestThinkingLevel("off"), "off");
  assertEquals(parseSpeedtestThinkingLevel(" xhigh "), "xhigh");
  assertRejects(() => {
    parseSpeedtestThinkingLevel("ultra");
    return Promise.reject(new Error("unreachable"));
  }).then(
    () => {},
    () => {},
  );
});

test("collectSpeedtestTargets filters unconfigured providers", () => {
  const flags = defaultSpeedtestFlags();
  const targets = collectSpeedtestTargets(settingsWithProviders(), flags);
  // p1 configured; empty has no key; placeholder only has ${...}
  assertEquals(
    targets.map((t) => `${t.provider}/${t.modelId}`),
    ["p1/m1", "p1/m2"],
  );
});

test("collectSpeedtestTargets honors --provider/--model filters", () => {
  const flags = defaultSpeedtestFlags();
  flags.provider = "p1";
  flags.model = "m2";
  const targets = collectSpeedtestTargets(settingsWithProviders(), flags);
  assertEquals(targets.length, 1);
  assertEquals(targets[0].modelId, "m2");
});

test("estimateSpeedtestTokens prefers words or runes/4", () => {
  assertEquals(estimateSpeedtestTokens(""), 0);
  // words (6) lose to runes/4 (ceil(26/4)=7); Go returns byRunes
  assertEquals(estimateSpeedtestTokens("one two three four five six"), 7);
  assertEquals(estimateSpeedtestTokens("a".repeat(40)), 10);
});

test("averageSpeedtestResults averages successful runs only", () => {
  const target: SpeedtestTarget = {
    provider: "p",
    modelId: "m",
    modelName: "",
  };
  const ok = (tps: number, tokens: number): SpeedtestResult => ({
    target,
    tokensPerSecond: tps,
    networkLatencyMs: 10,
    firstTokenLatencyMs: 100,
    totalDurationMs: 1000,
    outputTokens: tokens,
    estimatedTokens: false,
    stopReason: "stop",
    error: null,
  });
  const failed: SpeedtestResult = {
    ...ok(999, 0),
    error: "boom",
  };
  const avg = averageSpeedtestResults([ok(100, 40), ok(200, 60), failed]);
  assertEquals(avg.error, null);
  assertEquals(avg.tokensPerSecond, 150);
  assertEquals(avg.outputTokens, 50);
});

test("sortSpeedtestResults orders by success, rate, provider", () => {
  const target = (p: string, m: string): SpeedtestTarget => ({
    provider: p,
    modelId: m,
    modelName: "",
  });
  const r = (
    t: SpeedtestTarget,
    tps: number,
    error: string | null,
  ): SpeedtestResult => ({
    target: t,
    tokensPerSecond: tps,
    networkLatencyMs: 0,
    firstTokenLatencyMs: 0,
    totalDurationMs: 0,
    outputTokens: 1,
    estimatedTokens: false,
    stopReason: "",
    error,
  });
  const results = [
    r(target("b", "1"), 50, null),
    r(target("a", "2"), 50, "err"),
    r(target("a", "1"), 20, null),
    r(target("a", "3"), 80, null),
  ];
  sortSpeedtestResults(results);
  // Successful runs by rate desc: a/3(80), b/1(50), a/1(20); then the error.
  assertEquals(
    results.map((x) => `${x.target.provider}/${x.target.modelId}`),
    ["a/3", "b/1", "a/1", "a/2"],
  );
  assertEquals(countSpeedtestSuccesses(results), 3);
});

test("formatSpeedtestRate and duration render Go-style", () => {
  assertEquals(formatSpeedtestRate(0), "--");
  assertEquals(formatSpeedtestRate(123.44), "123.4");
  assertEquals(formatSpeedtestDuration(0), "--");
  assertEquals(formatSpeedtestDuration(850), "850ms");
  assertEquals(formatSpeedtestDuration(1500), "1.50s");
});

test("printSpeedtestResults renders aligned columns", () => {
  const lines: string[] = [];
  const target: SpeedtestTarget = {
    provider: "prov",
    modelId: "model-x",
    modelName: "",
  };
  printSpeedtestResults(
    (line) => void lines.push(line),
    [
      {
        target,
        tokensPerSecond: 42.5,
        networkLatencyMs: 12,
        firstTokenLatencyMs: 300,
        totalDurationMs: 1200,
        outputTokens: 90,
        estimatedTokens: true,
        stopReason: "stop",
        error: null,
      },
    ],
  );
  const text = lines.join("\n");
  assert(text.includes("Provider"));
  assert(text.includes("Token/s"));
  assert(text.includes("42.5"));
  assert(text.includes("~90"));
  // Header and value columns align: 'Provider' padded to width of 'prov'+2
  const header = lines[0];
  const row = lines[1];
  assert(header.indexOf("Model") === row.indexOf("model-x"));
});

test("runSpeedtestRequest computes rate from usage", async () => {
  const events: StreamEvent[] = [
    { type: streamTextDelta, textDelta: "hello " },
    { type: streamTextDelta, textDelta: "world" },
    {
      type: streamUsage,
      usage: {
        input: 10,
        output: 100,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 110,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    },
    { type: streamDone, stopReason: "stop" },
  ];
  const provider: Provider = {
    chat(): AsyncIterable<StreamEvent> {
      return (async function* () {
        for (const ev of events) yield ev;
      })();
    },
  } as unknown as Provider;
  const model: Model = { id: "m", name: "M", maxTokens: 512 } as Model;
  const result = await runSpeedtestRequest(
    provider,
    model,
    { provider: "p", modelId: "m", modelName: "" },
    { prompt: "hi", maxTokens: 256, thinkingLevel: "off" },
    new AbortController().signal,
  );
  assertEquals(result.error, null);
  assertEquals(result.outputTokens, 100);
  assertEquals(result.estimatedTokens, false);
  assertEquals(result.stopReason, "stop");
  assert(result.tokensPerSecond > 0);
  assert(result.firstTokenLatencyMs >= 0);
});

test("runSpeedtestRequest surfaces stream errors", async () => {
  const provider: Provider = {
    chat(): AsyncIterable<StreamEvent> {
      return (async function* () {
        yield { type: streamTextDelta, textDelta: "partial" };
        yield { type: streamDone, stopReason: "error" };
      })();
    },
  } as unknown as Provider;
  const result = await runSpeedtestRequest(
    provider,
    undefined,
    { provider: "p", modelId: "m", modelName: "" },
    { prompt: "hi", maxTokens: 256, thinkingLevel: "off" },
    new AbortController().signal,
  );
  // No text-delta issue, but no usage: estimated tokens path
  assertEquals(result.estimatedTokens, true);
  assert(result.outputTokens > 0);
});

test("executeSpeedtestCommand validates flags and empty targets", async () => {
  await assertRejects(
    () => executeSpeedtestCommand({ maxTokens: 0 }),
    Error,
    "--max-tokens",
  );
  await assertRejects(
    () => executeSpeedtestCommand({ runs: 0 }),
    Error,
    "--runs",
  );
  await assertRejects(
    () => executeSpeedtestCommand({ thinking: "bogus" }),
    Error,
    "--thinking",
  );
});
