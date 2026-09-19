// Ported from internal/provider/types_test.go

import { assert, assertEquals } from "@std/assert";
import {
  cacheInfo,
  classifyTurn,
  isStubUsage,
  promptTokens,
  totalInputTokens,
  turnEmpty,
  turnMeaningful,
  type Usage,
} from "./mod.ts";

function usage(partial: Partial<Usage>): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    ...partial,
  };
}

Deno.test("Usage CacheInfo", () => {
  const tests: Array<{
    name: string;
    input?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
    want: string;
  }> = [
    { name: "all_zeros_empty", want: "" },
    { name: "input_only_shows_zero_pct", input: 1000, want: "Cache: 0%" },
    { name: "single_token_no_cache", input: 1, want: "Cache: 0%" },
    { name: "cache_25pct", input: 1000, cacheRead: 250, want: "Cache: 20%" },
    { name: "cache_50pct", input: 1000, cacheRead: 500, want: "Cache: 33%" },
    { name: "cache_75pct", input: 1000, cacheRead: 750, want: "Cache: 43%" },
    {
      name: "cache_100pct_exact",
      input: 1000,
      cacheRead: 1000,
      want: "Cache: 50%",
    },
    {
      name: "prompt_tokens_use_total_tokens_when_present",
      input: 400,
      cacheRead: 200,
      cacheWrite: 100,
      total: 700,
      want: "Cache: 29%",
    },
    {
      name: "rounding_down_33pct",
      input: 1000,
      cacheRead: 333,
      want: "Cache: 25%",
    },
    {
      name: "rounding_up_67pct",
      input: 1000,
      cacheRead: 667,
      want: "Cache: 40%",
    },
    { name: "small_counts_75pct", input: 4, cacheRead: 3, want: "Cache: 43%" },
    {
      name: "cache_read_exceeds_input_capped_at_100pct",
      input: 100,
      cacheRead: 200,
      want: "Cache: 67%",
    },
    {
      name: "cache_write_only_no_input",
      cacheWrite: 5000,
      want: "CacheWrite: 5000",
    },
    {
      name: "cache_write_with_input_no_reads",
      input: 1000,
      cacheWrite: 5000,
      want: "CacheWrite: 5000",
    },
    {
      name: "cache_read_without_input_empty",
      cacheRead: 500,
      want: "Cache: 100%",
    },
    {
      name: "read_and_write_no_input_empty",
      cacheRead: 200,
      cacheWrite: 300,
      want: "Cache: 40%",
    },
    {
      name: "anthropic_proxy_split_usage_50pct",
      input: 500,
      cacheRead: 500,
      want: "Cache: 50%",
    },
  ];

  for (const tt of tests) {
    const u = usage({
      input: tt.input ?? 0,
      cacheRead: tt.cacheRead ?? 0,
      cacheWrite: tt.cacheWrite ?? 0,
      totalTokens: tt.total ?? 0,
    });
    assertEquals(cacheInfo(u), tt.want, tt.name);
  }
});

Deno.test("Usage PromptTokens", () => {
  const tests: Array<{ name: string; usage: Usage | null; want: number }> = [
    { name: "nil usage", usage: null, want: 0 },
    {
      name: "uses total tokens when present",
      usage: usage({
        input: 400,
        output: 50,
        cacheRead: 200,
        cacheWrite: 100,
        totalTokens: 750,
      }),
      want: 700,
    },
    {
      name: "falls back to input when total missing",
      usage: usage({ input: 400, output: 50, cacheRead: 200, cacheWrite: 100 }),
      want: 400,
    },
  ];
  for (const tt of tests) {
    assertEquals(promptTokens(tt.usage), tt.want, tt.name);
  }
});

Deno.test("Usage TotalInputTokens", () => {
  const tests: Array<{ name: string; usage: Usage | null; want: number }> = [
    { name: "nil usage", usage: null, want: 0 },
    {
      name: "uses total tokens when present",
      usage: usage({
        input: 400,
        output: 50,
        cacheRead: 200,
        cacheWrite: 100,
        totalTokens: 750,
      }),
      want: 700,
    },
    {
      name: "falls back to components when total missing",
      usage: usage({ input: 400, output: 50, cacheRead: 200, cacheWrite: 100 }),
      want: 700,
    },
  ];
  for (const tt of tests) {
    assertEquals(totalInputTokens(tt.usage), tt.want, tt.name);
  }
});

Deno.test("ClassifyTurn", () => {
  const stub = usage({ input: 1, output: 1, totalTokens: 2 });
  const real = usage({ input: 338962, output: 17, totalTokens: 338979 });
  const toolCall = [{ id: "c1", name: "ls" }];

  const tests: Array<{
    name: string;
    text: string;
    think: string;
    toolCalls: typeof toolCall | null;
    usage: Usage | null;
    stopReason: string;
    want: number;
  }> = [
    {
      name: "text present",
      text: "hi",
      think: "",
      toolCalls: null,
      usage: null,
      stopReason: "",
      want: turnMeaningful,
    },
    {
      name: "thinking present",
      text: "",
      think: "hmm",
      toolCalls: null,
      usage: null,
      stopReason: "",
      want: turnMeaningful,
    },
    {
      name: "toolcall present",
      text: "",
      think: "",
      toolCalls: toolCall,
      usage: null,
      stopReason: "",
      want: turnMeaningful,
    },
    {
      name: "empty+stub+nostop",
      text: "",
      think: "",
      toolCalls: null,
      usage: stub,
      stopReason: "",
      want: turnEmpty,
    },
    {
      name: "empty+nilusage+nostop",
      text: "",
      think: "",
      toolCalls: null,
      usage: null,
      stopReason: "",
      want: turnEmpty,
    },
    {
      name: "empty+realusage+nostop",
      text: "",
      think: "",
      toolCalls: null,
      usage: real,
      stopReason: "",
      want: turnMeaningful,
    },
    {
      name: "empty+stub+stop",
      text: "",
      think: "",
      toolCalls: null,
      usage: stub,
      stopReason: "stop",
      want: turnMeaningful,
    },
    {
      name: "empty+stub+end_turn",
      text: "",
      think: "",
      toolCalls: null,
      usage: stub,
      stopReason: "end_turn",
      want: turnMeaningful,
    },
    {
      name: "empty+nilusage+stop",
      text: "",
      think: "",
      toolCalls: null,
      usage: null,
      stopReason: "stop",
      want: turnMeaningful,
    },
    {
      name: "empty+stub+ STOP ",
      text: "",
      think: "",
      toolCalls: null,
      usage: stub,
      stopReason: " STOP ",
      want: turnMeaningful,
    },
    {
      name: "empty+stub+Completed",
      text: "",
      think: "",
      toolCalls: null,
      usage: stub,
      stopReason: "Completed",
      want: turnMeaningful,
    },
    {
      name: "empty+stub+length",
      text: "",
      think: "",
      toolCalls: null,
      usage: stub,
      stopReason: "length",
      want: turnEmpty,
    },
    {
      name: "empty+stub+tool_use",
      text: "",
      think: "",
      toolCalls: null,
      usage: stub,
      stopReason: "tool_use",
      want: turnEmpty,
    },
  ];
  for (const tt of tests) {
    const got = classifyTurn(
      tt.text,
      tt.think,
      tt.toolCalls,
      tt.usage,
      tt.stopReason,
    );
    assertEquals(got, tt.want, tt.name);
  }
});

Deno.test("IsStubUsage", () => {
  assert(isStubUsage(null));
  assert(isStubUsage(usage({ input: 1, output: 1, totalTokens: 2 })));
  assert(isStubUsage(usage({ input: 1, output: 50, totalTokens: 51 })));
  assert(!isStubUsage(usage({ input: 50, output: 1, totalTokens: 51 })));
  assert(
    !isStubUsage(usage({ input: 338962, output: 17, totalTokens: 338979 })),
  );
  assert(!isStubUsage(usage({ input: 100, output: 100, totalTokens: 200 })));
});
