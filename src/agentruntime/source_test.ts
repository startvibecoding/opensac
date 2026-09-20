// Ported from internal/agentruntime/source_test.go, source_contract_test.go,
// and policy_test.go.
//
// The Go `TestSessionRuntimeRejectsMutationAfterClose` case is deferred until
// the `SessionRuntime`/`Builder` port lands later in backlog #26.

import { assert, assertEquals, assertFalse, assertThrows } from "@std/assert";
import type { Binding } from "../session/bindings.ts";
import type { Header } from "../session/entry.ts";
import {
  ExecutionPolicy,
  isValidMode,
  ModeAgent,
  ModeOS,
  ModePlan,
  ModeResolver,
  ModeYolo,
  Policy,
  resolvePolicy,
  resolveSource,
  resolveSourceFromSession,
  resolveUnattendedMode,
  type RuntimeSource,
  SourceACP,
  SourceCLI,
  SourceConflictError,
  SourceFeishu,
  sourceFromSessionHeader,
  SourceUnknown,
  sourceWaitsForMembers,
  SourceWebUI,
  SourceWeChat,
} from "./source.ts";

Deno.test("ResolveSource prefers persisted binding and reports conflicts", () => {
  const resolved = resolveSource({
    binding: {
      sessionId: "s",
      channelType: "wechat",
      channelId: "c",
    } as Binding,
    sessionHeader: { channelType: "feishu" } as Header,
    current: SourceWebUI,
    requested: SourceACP,
  });
  assertEquals(resolved.source, SourceWeChat);
  assert(resolved.conflicted);
  assertEquals(resolved.diagnostics.length, 3);
});

Deno.test("ResolveSource falls back for a new session", () => {
  const resolved = resolveSource({ requested: SourceACP });
  assertEquals(resolved.source, SourceACP);
  assertFalse(resolved.conflicted);
});

Deno.test("ResolveSource binding wins over request and runtime", () => {
  const resolved = resolveSource({
    binding: {
      sessionId: "s",
      channelType: "wechat",
      channelId: "c",
    } as Binding,
    current: SourceWebUI,
    requested: SourceACP,
  });
  assertEquals(resolved.source, SourceWeChat);
});

Deno.test("ResolvePolicy uses resolved channel source", () => {
  const { resolution, mode, error } = resolvePolicy(
    {
      sessionHeader: { channelType: "feishu" } as Header,
      requested: SourceWebUI,
    },
    ModeAgent,
    ModePlan,
    ModeAgent,
  );
  assertEquals(error, null);
  assertEquals(resolution.source, SourceFeishu);
  assertEquals(mode, ModeYolo);
});

Deno.test("ResolvePolicy bound channel cannot downgrade mode", () => {
  const { resolution, mode, error } = resolvePolicy(
    {
      binding: {
        sessionId: "s",
        channelType: "feishu",
        channelId: "c",
      } as Binding,
      requested: SourceWebUI,
    },
    ModeAgent,
    ModePlan,
    ModeAgent,
  );
  assertEquals(error, null);
  assertEquals(resolution.source, SourceFeishu);
  assertEquals(mode, ModeYolo);
});

Deno.test("ResolvePolicy rejects persisted runtime source conflict", () => {
  const { error } = resolvePolicy(
    {
      binding: {
        sessionId: "s",
        channelType: "feishu",
        channelId: "c",
      } as Binding,
      current: SourceWebUI,
      requested: SourceACP,
    },
    ModeAgent,
    ModePlan,
    ModeAgent,
  );
  assert(error instanceof SourceConflictError);
});

Deno.test("ResolvePolicy unbound WebUI uses requested mode", () => {
  const { mode, error } = resolvePolicy(
    {
      current: SourceWebUI,
      requested: SourceWebUI,
    },
    ModeAgent,
    ModeYolo,
    ModeAgent,
  );
  assertEquals(error, null);
  assertEquals(mode, ModeYolo);
});

Deno.test("ResolvePolicy rejects unknown source candidates", () => {
  for (
    const input of [
      { requested: "adapter-without-policy" as RuntimeSource },
      { current: "stale-runtime" as RuntimeSource },
    ]
  ) {
    const { error } = resolvePolicy(input, "", "", ModeAgent);
    assert(error !== null, `expected error for ${JSON.stringify(input)}`);
  }
});

Deno.test("Policy ResolveMode table", () => {
  const tests: Array<{
    name: string;
    policy: Policy;
    session?: string;
    requested?: string;
    want: string;
  }> = [
    {
      name: "wechat cannot be downgraded",
      policy: new ExecutionPolicy({
        source: SourceWeChat,
        defaultMode: ModeAgent,
      }),
      session: ModeAgent,
      requested: ModePlan,
      want: ModeYolo,
    },
    {
      name: "wechat ignores malformed adapter hint",
      policy: new ExecutionPolicy({
        source: SourceWeChat,
        defaultMode: ModeAgent,
      }),
      session: "not-a-mode",
      requested: "invalid",
      want: ModeYolo,
    },
    {
      name: "feishu empty session uses yolo",
      policy: new ExecutionPolicy({
        source: SourceFeishu,
        defaultMode: ModeAgent,
      }),
      want: ModeYolo,
    },
    {
      name: "regular request overrides session",
      policy: new ExecutionPolicy({
        source: SourceWebUI,
        defaultMode: ModeAgent,
      }),
      session: ModePlan,
      requested: ModeYolo,
      want: ModeYolo,
    },
    {
      name: "regular empty session uses default",
      policy: new ExecutionPolicy({
        source: SourceWebUI,
        defaultMode: ModeAgent,
      }),
      want: ModeAgent,
    },
    {
      name: "empty policy default falls back to yolo",
      policy: new ExecutionPolicy({ source: SourceWebUI }),
      want: ModeYolo,
    },
    {
      name: "regular request uses os",
      policy: new ExecutionPolicy({
        source: SourceWebUI,
        defaultMode: ModeAgent,
      }),
      requested: ModeOS,
      want: ModeOS,
    },
  ];
  for (const tt of tests) {
    assertEquals(
      tt.policy.resolveMode(tt.session ?? "", tt.requested ?? ""),
      tt.want,
      tt.name,
    );
  }
});

Deno.test("ModeResolver", () => {
  const got = new ModeResolver(
    new ExecutionPolicy({ source: SourceFeishu, defaultMode: ModeAgent }),
  ).resolve(ModePlan, ModeAgent);
  assertEquals(got, ModeYolo);
});

Deno.test("SourceFromSessionHeader", () => {
  assertEquals(
    sourceFromSessionHeader({ channelType: "feishu" } as Header),
    SourceFeishu,
  );
  assertEquals(
    sourceFromSessionHeader({ channelType: "local" } as Header),
    SourceUnknown,
  );
});

Deno.test("ResolveUnattendedMode", () => {
  const tests: Array<[string, string]> = [
    ["", ModeYolo],
    [ModePlan, ModeYolo],
    [ModeAgent, ModeYolo],
    [ModeYolo, ModeYolo],
    [ModeOS, ModeOS],
    [" os ", ModeOS],
    ["not-a-mode", ModeYolo],
  ];
  for (const [session, want] of tests) {
    assertEquals(resolveUnattendedMode(session), want);
  }
});

Deno.test("IsValidMode and member waiting", () => {
  assert(isValidMode("yolo"));
  assertFalse(isValidMode("bogus"));
  assert(sourceWaitsForMembers(SourceWebUI));
  assert(sourceWaitsForMembers(SourceACP));
  assertFalse(sourceWaitsForMembers(SourceCLI));
});

Deno.test("ResolveSourceFromSession rejects an empty session ID", () => {
  assertThrows(
    () => resolveSourceFromSession("/tmp", "", { requested: SourceACP }),
    Error,
  );
});
