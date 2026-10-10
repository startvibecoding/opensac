// and policy_test.go.
//
// The Go `TestSessionRuntimeRejectsMutationAfterClose` case is deferred until
// the `SessionRuntime`/`Builder` port lands later in backlog #26.

import {
  assert,
  assertEquals,
  assertFalse,
  assertThrows,
} from "../compat/assert.ts";
import { type Binding } from "../session/bindings.ts";
import { type Header } from "../session/entry.ts";
import {
  ExecutionPolicy,
  isValidMode,
  MODE_AGENT,
  MODE_OS,
  MODE_PLAN,
  MODE_YOLO,
  ModeResolver,
  type Policy,
  resolvePolicy,
  resolveSource,
  resolveSourceFromSession,
  resolveUnattendedMode,
  type RuntimeSource,
  SOURCE_ACP,
  SOURCE_CLI,
  SOURCE_FEISHU,
  SOURCE_TUI,
  SOURCE_UNKNOWN,
  SOURCE_WE_CHAT,
  SourceConflictError,
  sourceFromSessionHeader,
  sourceWaitsForMembers,
} from "./source.ts";
import { test } from "#testing";

test("ResolveSource prefers persisted binding and reports conflicts", () => {
  const resolved = resolveSource({
    binding: {
      sessionId: "s",
      channelType: "wechat",
      channelId: "c",
    } as Binding,
    sessionHeader: { channelType: "feishu" } as Header,
    current: SOURCE_CLI,
    requested: SOURCE_ACP,
  });
  assertEquals(resolved.source, SOURCE_WE_CHAT);
  assert(resolved.conflicted);
  assertEquals(resolved.diagnostics.length, 3);
});

test("ResolveSource falls back for a new session", () => {
  const resolved = resolveSource({ requested: SOURCE_ACP });
  assertEquals(resolved.source, SOURCE_ACP);
  assertFalse(resolved.conflicted);
});

test("ResolveSource binding wins over request and runtime", () => {
  const resolved = resolveSource({
    binding: {
      sessionId: "s",
      channelType: "wechat",
      channelId: "c",
    } as Binding,
    current: SOURCE_CLI,
    requested: SOURCE_ACP,
  });
  assertEquals(resolved.source, SOURCE_WE_CHAT);
});

test("ResolvePolicy uses resolved channel source", () => {
  const { resolution, mode, error } = resolvePolicy(
    {
      sessionHeader: { channelType: "feishu" } as Header,
      requested: SOURCE_CLI,
    },
    MODE_AGENT,
    MODE_PLAN,
    MODE_AGENT,
  );
  assertEquals(error, null);
  assertEquals(resolution.source, SOURCE_FEISHU);
  assertEquals(mode, MODE_YOLO);
});

test("ResolvePolicy bound channel cannot downgrade mode", () => {
  const { resolution, mode, error } = resolvePolicy(
    {
      binding: {
        sessionId: "s",
        channelType: "feishu",
        channelId: "c",
      } as Binding,
      requested: SOURCE_CLI,
    },
    MODE_AGENT,
    MODE_PLAN,
    MODE_AGENT,
  );
  assertEquals(error, null);
  assertEquals(resolution.source, SOURCE_FEISHU);
  assertEquals(mode, MODE_YOLO);
});

test("ResolvePolicy rejects persisted runtime source conflict", () => {
  const { error } = resolvePolicy(
    {
      binding: {
        sessionId: "s",
        channelType: "feishu",
        channelId: "c",
      } as Binding,
      current: SOURCE_CLI,
      requested: SOURCE_ACP,
    },
    MODE_AGENT,
    MODE_PLAN,
    MODE_AGENT,
  );
  assert(error instanceof SourceConflictError);
});

test("ResolvePolicy unbound CLI uses requested mode", () => {
  const { mode, error } = resolvePolicy(
    {
      current: SOURCE_CLI,
      requested: SOURCE_CLI,
    },
    MODE_AGENT,
    MODE_YOLO,
    MODE_AGENT,
  );
  assertEquals(error, null);
  assertEquals(mode, MODE_YOLO);
});

test("ResolvePolicy rejects unknown source candidates", () => {
  for (const input of [
    { requested: "adapter-without-policy" as RuntimeSource },
    { current: "stale-runtime" as RuntimeSource },
  ]) {
    const { error } = resolvePolicy(input, "", "", MODE_AGENT);
    assert(error !== null, `expected error for ${JSON.stringify(input)}`);
  }
});

test("Policy ResolveMode table", () => {
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
        source: SOURCE_WE_CHAT,
        defaultMode: MODE_AGENT,
      }),
      session: MODE_AGENT,
      requested: MODE_PLAN,
      want: MODE_YOLO,
    },
    {
      name: "wechat ignores malformed adapter hint",
      policy: new ExecutionPolicy({
        source: SOURCE_WE_CHAT,
        defaultMode: MODE_AGENT,
      }),
      session: "not-a-mode",
      requested: "invalid",
      want: MODE_YOLO,
    },
    {
      name: "feishu empty session uses yolo",
      policy: new ExecutionPolicy({
        source: SOURCE_FEISHU,
        defaultMode: MODE_AGENT,
      }),
      want: MODE_YOLO,
    },
    {
      name: "regular request overrides session",
      policy: new ExecutionPolicy({
        source: SOURCE_CLI,
        defaultMode: MODE_AGENT,
      }),
      session: MODE_PLAN,
      requested: MODE_YOLO,
      want: MODE_YOLO,
    },
    {
      name: "regular empty session uses default",
      policy: new ExecutionPolicy({
        source: SOURCE_CLI,
        defaultMode: MODE_AGENT,
      }),
      want: MODE_AGENT,
    },
    {
      name: "empty policy default falls back to yolo",
      policy: new ExecutionPolicy({ source: SOURCE_CLI }),
      want: MODE_YOLO,
    },
    {
      name: "regular request uses os",
      policy: new ExecutionPolicy({
        source: SOURCE_CLI,
        defaultMode: MODE_AGENT,
      }),
      requested: MODE_OS,
      want: MODE_OS,
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

test("ModeResolver", () => {
  const got = new ModeResolver(
    new ExecutionPolicy({ source: SOURCE_FEISHU, defaultMode: MODE_AGENT }),
  ).resolve(MODE_PLAN, MODE_AGENT);
  assertEquals(got, MODE_YOLO);
});

test("SourceFromSessionHeader", () => {
  assertEquals(
    sourceFromSessionHeader({ channelType: "feishu" } as Header),
    SOURCE_FEISHU,
  );
  assertEquals(
    sourceFromSessionHeader({ channelType: "local" } as Header),
    SOURCE_UNKNOWN,
  );
});

test("ResolveUnattendedMode", () => {
  const tests: Array<[string, string]> = [
    ["", MODE_YOLO],
    [MODE_PLAN, MODE_YOLO],
    [MODE_AGENT, MODE_YOLO],
    [MODE_YOLO, MODE_YOLO],
    [MODE_OS, MODE_OS],
    [" os ", MODE_OS],
    ["not-a-mode", MODE_YOLO],
  ];
  for (const [session, want] of tests) {
    assertEquals(resolveUnattendedMode(session), want);
  }
});

test("IsValidMode and member waiting", () => {
  assert(isValidMode("yolo"));
  assertFalse(isValidMode("bogus"));
  assert(sourceWaitsForMembers(SOURCE_TUI));
  assert(sourceWaitsForMembers(SOURCE_ACP));
  assertFalse(sourceWaitsForMembers(SOURCE_CLI));
});

test("ResolveSourceFromSession rejects an empty session ID", () => {
  assertThrows(
    () => resolveSourceFromSession("/tmp", "", { requested: SOURCE_ACP }),
    Error,
  );
});
