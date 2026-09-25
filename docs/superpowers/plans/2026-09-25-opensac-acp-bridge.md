# OpenSAC ACP Core Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert `opensac acp` into a protocol-only bridge over the shared Core Runtime Host while preserving ACP stdio wire compatibility and Desktop behavior.

**Architecture:** Add a front-end-neutral Core Runtime Host and Core domain RPC/event transport. The ACP bridge owns only stdio framing, ACP request/response correlation, capability negotiation, and deterministic ACP projections; it never constructs Agent, Provider, MCP, SessionRuntime, Durable Run, or Decision state. Existing ACP wire tests remain the compatibility contract while runtime ownership tests assert that ACP code no longer reaches domain implementation modules.

**Tech Stack:** Deno 2.9+, TypeScript 6, Deno Web APIs, Deno WebSocket upgrade, JSON-RPC 2.0, existing `src/agentruntime`, `src/agent`, `src/session`, `src/dao`, `src/core`, and `@std/assert`.

**Spec:** `docs/proposal/opensac-core-acp-bridge-design.md`

## Execution Status — 2026-09-25

This checklist records implementation state separately from the detailed TDD steps below.

| Task | State | Current boundary |
|---|---|---|
| 1. Core Runtime Host contracts | Complete | Neutral contracts, in-memory host facade, session/run event shape, production session-runtime factory, and narrow Core runtime import guard exist. |
| 2. Core RPC/events | Complete | Domain dispatcher, JSON-RPC schemas, event cursor stream, reverse-request correlation, Core server event route, and CoreClient event connection exist and are verified end to end. |
| 3. ACP projection | Complete | ACP request/response/event/reverse-request mapping preserves raw IDs and canonical session/run/message/tool fields. |
| 4. ACP bridge lifecycle | Complete | `ACPBridge`, `ACPBridgeClient`, fake-client contracts, event forwarding, reverse-response correlation, and Core-only startup/EOF lifecycle exist. |
| 5. Session/prompt contract | Complete for bridge contract | `session/new`, prompt, replay, and cancel mappings are covered. Real prompt execution is supplied by the production Runtime extraction in Task 7. |
| 6. ACP extensions | Complete for mapping/port | ACP extension methods map to Core method names and the Core extension handler port; production Core handlers now cover doctor, project CRUD, attachment list/fetch/store, secret-safe environment management, expert CRUD/catalog operations, masked/persisted settings get/patch, application get/patch, provider list/save/delete/discover/test, skills list/set, MCP list/set, stats summary/timeseries, memory get/put, deliveries list/retry, cron list/create/update/remove/run, knowledge-base CRUD/scan/status/query/MCP apply, and SkillHub settings/catalog/install/activate/uninstall. |
| 7. Ownership/extraction | Complete | Public `opensac acp` uses the Core-only `runACPCore` path; `src/acp/run.ts` is protocol/Core-only and guarded. Legacy ACP Runtime, direct management router, and compatibility tests are removed; all current manage families, including SkillHub, have Core-owned ports. |
| 8. End-to-end verification | Complete | Production Core SessionRuntime, Core-only ACP cutover, ACP subprocess extension paths, full repository tests, and static checks are verified. |

### Current extraction seams

- `src/agentruntime/run_handle.ts` is the shared decision/cancellation Run handle; `src/tui/tui_run.ts` is a compatibility adapter.
- `src/agentruntime/session_executor.ts` owns admission/event/terminal/release coordination; TUI now delegates its Agent event loop to it.
- `src/agentruntime/session_run.ts` owns the front-end-neutral durable Run descriptor, fingerprint, policy, and started-event construction; TUI and CLI print now share it.
- `createProductionCoreRuntimeDependencies()` in `src/core/runtime_host.ts` owns the real Builder/SessionRuntime/Decision/Execution lifecycle; `opensac core` injects it lazily so Core startup does not load the Agent graph.
- `opensac acp` now enters through `runACPCore`; `src/acp/run.ts` contains only stdio framing, CoreClient/ACPBridge wiring, and error/reconnect boundaries. The old implementation and its compatibility-only tests have been removed.
- The legacy ACP direct management router and its SkillHub/knowledge-base compatibility tests have also been removed; `src/acp/mod.ts` exposes only the protocol/projection/Core bridge surface.
- The next extraction target was the `manage.providers.*` family; it and the subsequent skills, MCP, stats, memory, deliveries, cron, knowledge-base, and SkillHub manage families are now implemented behind Core-owned handlers. SkillHub Core owns secret-safe settings, cached catalog clients, global/project persistence, install/uninstall, and Core session skill activation.

### Latest verification

- Focused architecture/Core/ACP ownership/executor checks: `27 passed, 0 failed`.
- `deno check` passed for `src/core/`, ACP bridge files, shared Runtime handle/executor, and `src/tui/tui_session.ts`.
- TUI full suite after shared event-loop wiring: `262 passed, 0 failed`.
- Full ACP/Core/architecture/executor regression after latest wiring: `339 passed, 0 failed`.
- Final ACP/CLI subprocess/architecture regression: `230 passed, 0 failed`.
- Core final review: `28 passed, 0 failed`.
- Canonical Core Host events are connected to the shared `CoreEventStream` used by ACP WebSocket/replay.
- Final ACP/Core/architecture/CLI subprocess regression: `336 passed, 0 failed` before the latest extension and cleanup changes.
- Production Core extension handler now owns doctor, project CRUD, attachment list/fetch/store, secret-safe environment management, expert CRUD/catalog operations, masked/persisted settings get/patch, application get/patch, provider list/save/delete/discover/test, skills list/set, MCP list/set, stats summary/timeseries, memory get/put, deliveries list/retry, cron list/create/update/remove/run, and knowledge-base CRUD/scan/status/query/MCP apply; lazy Core wiring, reverse-request transport, and handler contract tests passed.
- The source Core launcher now grants `--allow-ffi`, required by production Builder/image runtime initialization.
- `src/acp/legacy_run.ts` and its compatibility-only `run_test.ts` were removed after the Core-only ACP cutover.
- `deno task check`, `deno task lint`, `deno fmt --check`, and `git diff --check` passed after the final Core reverse-request, expert, settings, stats, memory, deliveries, cron, and knowledge handler wiring.
- Final full repository test suite after stats/memory/deliveries/cron/knowledge migration: `2093 passed, 0 failed`.
- SkillHub Core contract tests, ACP workspace mapping, architecture guard, Core/CLI subprocess regression, and static checks passed after the SkillHub migration.
- Task 8 is verified for the current bridge boundary; all manage families, including SkillHub, now route through Core-owned handlers.
- Final full repository test suite after the SkillHub migration: `2097 passed, 0 failed`.
- Final ACP management cleanup removed six obsolete ACP direct-management source/test files; the post-cleanup full repository suite passed (`2054/2054`), with `deno task check`, `deno task lint`, `deno fmt --check`, and `git diff --check` passing.

## Global Constraints

- Preserve existing ACP stdio NDJSON/JSON-RPC wire protocol and Desktop startup behavior.
- ACP bridge must not directly create Agent, AgentManager, Provider, MCP, SessionRuntime, Durable Run, Decision, or Runtime Lease.
- Core must not import ACP protocol types or ACP wire helpers.
- Core Runtime Host owns Runtime Source/Policy resolution, providers, resources, SessionRuntime, AgentManager, Run lifecycle, Decisions, and canonical events.
- Core RPC is ordinary JSON-RPC 2.0 over HTTP; event/control transport uses Deno WebSocket without HTTP/3 or WebTransport.
- Streaming `TextDelta` and `ReasoningDelta` events are individual JSON-RPC notifications, never batched.
- Every event carries `sessionId`, `runId`, `sequence`, `eventType`, and payload; replay uses a cursor.
- ACP EOF closes only the bridge/Core Client and does not stop the global Core; Standalone mode owns and closes its Private Core.
- Preserve `sessions.db`, existing Session/Run/Decision persistence, and `session_runtime_leases` semantics.
- Update architecture guards so ACP has protocol/projection dependencies only; the explicitly reviewed Core Runtime Host files are the only Core files allowed to import runtime implementation modules.
- Tests that alter `OPENSAC_DIR` restore it in `finally`; do not run filesystem/config tests in parallel when they mutate the environment.
- Do not change `serve`, `a2a`, or channel entry modes; `opensac core` remains the only shared runtime host.
- Do not commit unless the user explicitly requests it; this plan's implementation tasks leave changes uncommitted for review.

## Review Focus

- A prompt request can be accepted by Core and stream ordered events even if the ACP client disconnects after admission; reconnect must replay from a cursor without duplicating terminal events.
- Approval and Question requests must correlate Core server-to-client request IDs with ACP reverse-request IDs and resolve exactly once.
- A Core crash or bridge EOF must not make a later ACP client create a second Agent/SessionRuntime owner or replay an uncertain tool call.
- ACP IDs, especially string-vs-number and `null` IDs, must remain raw/echo-compatible through the Core bridge.
- Every ACP extension method must map to a Core domain operation; a bridge fallback to direct session/database/agent access is a release-blocking failure.

---

### Task 1: Define front-end-neutral Core Runtime Host contracts and schemas

**Files:**
- Create: `src/core/runtime.ts`
- Create: `src/core/runtime_host.ts`
- Create: `src/core/runtime_host_test.ts`
- Modify: `src/architecture/guard.ts`
- Modify: `src/architecture/architecture_guard_test.ts`
- Modify: `AGENTS.md`

**Interfaces:**
- Produces `CoreRuntimeHost`, `CoreRuntimeHostOptions`, `CoreSessionCreateInput`, `CoreSessionView`, `CorePromptInput`, `CorePromptAccepted`, `CoreRunView`, and `CoreRuntimeEvent`.
- Produces `createCoreRuntimeHost(options): Promise<CoreRuntimeHost>` for the shared Runtime owner.
- `CoreRuntimeHost` must expose `createSession`, `openSession`, `closeSession`, `history`, `prompt`, `cancelRun`, `getRun`, `listSessions`, `setSessionConfig`, and `subscribeRunEvents`.
- `subscribeRunEvents(sessionId, runId, cursor?)` returns an async event stream with ordered `sequence` values and terminal completion.

- [ ] **Step 1: Write failing contract tests.**

Add tests that construct a Runtime Host with isolated settings and assert:

```ts
const host = await createCoreRuntimeHost({
  source: "acp",
  workDir,
  settings,
  providerName: "test-provider",
  modelID: "test-model",
});
const session = await host.createSession({ workDir });
const accepted = await host.prompt({
  sessionId: session.sessionId,
  text: "hello",
});
assertEquals(accepted.runId !== "", true);
await host.cancelRun({ sessionId: session.sessionId, runId: accepted.runId });
await host.closeSession({ sessionId: session.sessionId });
```

Use injected fake provider/runtime dependencies for contract tests; do not call a real provider. Assert that Runtime Host creation does not import or depend on ACP types.

- [ ] **Step 2: Run the focused tests and verify they fail.**

Run:

```bash
cd /home/free/src/opensac
deno test -A src/core/runtime_host_test.ts
```

Expected: FAIL because the Core Runtime Host contracts and implementation do not exist.

- [ ] **Step 3: Implement the neutral contracts and host lifecycle.**

Define the contracts in `src/core/runtime.ts`. The implementation in `src/core/runtime_host.ts` must:

1. resolve the selected provider/model through the existing provider factory;
2. create one shared sandbox manager and context/skill resource set;
3. create/reuse one `SessionRuntime` per session;
4. create/reuse one `AgentManager` per session when multi-agent/delegate/workflow capabilities require it;
5. call the existing `ExecutionRuntime`/`RunStore` APIs for prompt admission and Run lifecycle;
6. preserve `session_runtime_leases` and DecisionService behavior;
7. emit canonical events through an injected `CoreEventSink` or in-memory stream;
8. shut down active runs, release decisions, close MCP resources, and close the host idempotently.

Do not import from `src/acp/`, `src/acp/protocol.ts`, or ACP wire helpers. Do not create ACP-specific result types.

- [ ] **Step 4: Add the narrowly scoped Core runtime boundary to the architecture guard.**

Allow only these reviewed Core files to import runtime implementation packages:

```text
src/core/runtime_host.ts
```

The guard must still reject direct Agent/Provider/Session imports from `src/core/client.ts`, `src/core/server.ts`, `src/core/protocol.ts`, and future ACP bridge files. Add a test proving a synthetic Core protocol file cannot import `src/agent/agent.ts` while `runtime_host.ts` can.

- [ ] **Step 5: Update repository guidance.**

Document that `src/core/runtime_host.ts` is the only current Core boundary allowed to import `src/agentruntime`, `src/agent`, Provider, or Session implementation modules. ACP remains wire/projection-only.

- [ ] **Step 6: Run focused tests and architecture checks.**

Run:

```bash
cd /home/free/src/opensac
deno test -A src/core/runtime_host_test.ts
deno task test:architecture
```

Expected: PASS with no ACP import in the Core Host.

---

### Task 2: Add Core domain RPC dispatch and event/reverse-request transport

**Files:**
- Create: `src/core/runtime_protocol.ts`
- Create: `src/core/event_stream.ts`
- Create: `src/core/dispatcher.ts`
- Create: `src/core/dispatcher_test.ts`
- Create: `src/core/event_stream_test.ts`
- Modify: `src/core/server.ts`
- Modify: `src/core/protocol.ts`
- Modify: `src/core/client.ts`
- Modify: `src/core/client_test.ts`

**Interfaces:**
- Produces Core method constants for `session.create`, `session.open`, `session.close`, `session.list`, `session.history`, `session.config.set`, `session.prompt`, `run.status`, `run.cancel`, `run.events.subscribe`, and `run.events.replay`.
- Produces `CoreRuntimeDispatcher` with `dispatch(request: CoreRpcRequest, signal: AbortSignal): Promise<CoreRpcResponse | undefined>`.
- Produces `CoreEventStream` with `publish(event)`, `subscribe(sessionId, runId, cursor)`, `replay(sessionId, runId, cursor)`, and `close()`.
- Extends `CoreClient` with `call`, event subscription, reconnect, and server-to-client request response correlation.

- [ ] **Step 1: Write failing RPC and event tests.**

Cover:

```ts
const response = await dispatcher.dispatch({
  jsonrpc: "2.0",
  id: 1,
  method: "session.create",
  params: { workDir },
}, signal);
assertEquals(response.id, 1);
```

Assert that unknown methods return `-32601`, invalid params return `-32602`, notifications return no response, and streaming events are independent notifications. Assert that a Core server-to-client approval request has an ID and that a later response resolves only the matching pending request.

- [ ] **Step 2: Run tests and verify they fail.**

Run:

```bash
cd /home/free/src/opensac
deno test -A src/core/dispatcher_test.ts src/core/event_stream_test.ts
```

Expected: FAIL because the domain dispatcher and stream do not exist.

- [ ] **Step 3: Add strict domain request/result schemas.**

In `runtime_protocol.ts`, define strict runtime input/result types and parsers for all methods in the interfaces block. Reject unknown method shapes, missing required IDs, invalid cursor values, malformed Run IDs, and ACP-specific fields. Keep event payload types front-end-neutral.

- [ ] **Step 4: Implement the dispatcher and event stream.**

The dispatcher must:

1. authenticate the HTTP/WS boundary before dispatch;
2. call `CoreRuntimeHost` methods;
3. map domain errors to stable JSON-RPC error codes/data;
4. return responses only for requests;
5. publish `RunStarted`, `TextDelta`, `ReasoningDelta`, tool events, approval/question requests, retry/status events, and one terminal event;
6. assign per-Run monotonically increasing sequence numbers;
7. retain events until the configured replay window expires;
8. support cursor-based replay without duplicate terminal events.

- [ ] **Step 5: Add a WebSocket route to the Core server.**

Upgrade authenticated requests at `/events` to a WebSocket. The socket carries:

- client → Core JSON-RPC requests/notifications;
- Core → client JSON-RPC notifications;
- Core → client approval/question requests;
- client → Core matching responses.

Keep `/health` and `/rpc` behavior compatible. The WebSocket must close cleanly when the Runtime Host closes and reject unauthenticated upgrades with a structured error.

- [ ] **Step 6: Extend CoreClient for WebSocket events and reverse requests.**

Add:

```ts
connectEvents(signal?: AbortSignal): Promise<CoreEventConnection>
```

`CoreEventConnection` must expose `subscribe`, `replay`, `onNotification`, `respond`, `close`, and reconnect state. The existing HTTP `call()` remains the ordinary request path.

- [ ] **Step 7: Run focused Core tests.**

Run:

```bash
cd /home/free/src/opensac
deno test -A src/core/dispatcher_test.ts src/core/event_stream_test.ts src/core/client_test.ts
```

Expected: PASS, including request ID correlation, cursor replay, and no event batching.

---

### Task 3: Extract the ACP protocol projection layer

**Files:**
- Create: `src/acp/bridge_protocol.ts`
- Create: `src/acp/bridge_protocol_test.ts`
- Modify: `src/acp/protocol.ts`
- Modify: `src/acp/projection.ts`
- Modify: `src/acp/wire.ts`

**Interfaces:**
- Produces `mapACPRequestToCore(request: ACPRPCRequest, context: ACPBridgeContext): CoreRpcRequest`.
- Produces `mapCoreResponseToACP(response: CoreRpcResponse, request: ACPRPCRequest): ACPRPCResponse`.
- Produces `mapCoreEventToACP(event: CoreRuntimeEvent): ACPNotification`.
- Produces `mapCoreReverseRequestToACP(request: CoreServerRequest): ACPRPCRequest`.
- Preserves `src/acp/protocol.ts` and `src/acp/wire.ts` existing wire types and raw ID behavior.

- [ ] **Step 1: Write failing projection tests.**

Use representative ACP and Core messages:

```ts
const acp = mapACPRequestToCore(sessionNewRequest, context);
assertEquals(acp.method, "session.create");

const update = mapCoreEventToACP({
  sessionId: "session-1",
  runId: "run-1",
  sequence: 7,
  eventType: "text_delta",
  payload: { text: "hello" },
});
assertEquals(update.method, "session/update");
```

Assert that Session ID, Run ID, message ID, tool call ID, sequence, and terminal state survive projection. Assert that string/number/null ACP IDs are echoed using the existing raw ID encoder.

- [ ] **Step 2: Run the tests and verify they fail.**

Run:

```bash
cd /home/free/src/opensac
deno test -A src/acp/bridge_protocol_test.ts
```

Expected: FAIL because the projection module does not exist.

- [ ] **Step 3: Implement ACP ↔ Core mapping.**

Keep the mapping exhaustive and typed. Do not import `src/acp/server.ts` from the projection module. Put all ACP-specific wire decisions here, including existing error codes, session update names, tool call content, artifact projection, plan projection, usage projection, and question/permission payloads.

- [ ] **Step 4: Run projection and existing ACP wire tests.**

Run:

```bash
cd /home/free/src/opensac
deno test -A src/acp/bridge_protocol_test.ts src/acp/wire_test.ts src/acp/run_test.ts
```

Expected: PASS; existing ACP fixtures remain byte/shape compatible.

---

### Task 4: Implement the ACP Core bridge client and lifecycle

**Files:**
- Create: `src/acp/bridge_client.ts`
- Create: `src/acp/bridge_client_test.ts`
- Create: `src/acp/bridge.ts`
- Create: `src/acp/bridge_test.ts`
- Modify: `src/acp/run.ts`
- Modify: `src/acp/run_test.ts`
- Modify: `src/cli/command.ts`

**Interfaces:**
- Produces `ACPBridge` with `handle(request: ACPRPCRequest): Promise<void>`, `handleNotification`, `close`, and `connected`.
- Produces `ACPBridgeClient` with `connect`, `callCore`, `subscribe`, `respondToReverseRequest`, `replay`, `close`, and `reconnect`.
- `runACP` remains the public ACP entry point and returns a Promise that resolves at clean EOF.

- [ ] **Step 1: Write failing bridge tests.**

Cover:

```ts
const bridge = new ACPBridge({
  client: fakeCoreClient,
  transport: fakeAcpTransport,
});
await bridge.handle(sessionNewRequest);
await bridge.handle(sessionPromptRequest);
assertEquals(coreClient.calls.map((call) => call.method), [
  "session.create",
  "session.prompt",
]);
```

Assert:

- ACP EOF closes only the bridge;
- Core EOF/error does not create a local Agent;
- reconnect replays from the last cursor;
- pending reverse requests are not answered automatically;
- one ACP request ID maps to one Core request ID;
- a Core error becomes the expected ACP error envelope.

- [ ] **Step 2: Run bridge tests and verify they fail.**

Run:

```bash
cd /home/free/src/opensac
deno test -A src/acp/bridge_client_test.ts src/acp/bridge_test.ts
```

Expected: FAIL because the bridge modules do not exist.

- [ ] **Step 3: Implement ACPBridgeClient.**

Use the existing `CoreClient` for discovery, authentication, health, and ordinary calls. Add the Core event connection for notifications and reverse requests. Maintain a request correlation map keyed by Core RPC ID and an ACP-to-Core session/run ID map. The bridge must not call `CoreClient.close()` on Core EOF in a way that deletes Core registration.

- [ ] **Step 4: Implement ACPBridge dispatch and lifecycle.**

`ACPBridge.handle()` must:

1. reject requests before `initialize` as before;
2. map ACP request to Core request;
3. send the Core request;
4. map the response back to ACP;
5. subscribe to or use the active event stream;
6. forward Core notifications to ACP `session/update`;
7. forward Core reverse requests to ACP and correlate responses;
8. serialize ACP writes to prevent interleaved JSON lines.

`runACPInner()` must stop constructing `AcpServer`, `SessionRuntime`, `AgentManager`, Provider, Sandbox, MCP, and RecoveryCoordinator. It may load only ACP process options and create the Core Client. Startup errors before ACP initialize must remain `OPENSAC_ACP_ERROR` compatible.

- [ ] **Step 5: Preserve command and transport behavior.**

Keep `opensac acp` command registration and `stdioTransport()` unchanged. Keep the existing ACP protocol version and initialize capabilities. Do not add `serve` or `a2a`.

- [ ] **Step 6: Run ACP bridge and process tests.**

Run:

```bash
cd /home/free/src/opensac
deno test -A src/acp/bridge_client_test.ts src/acp/bridge_test.ts src/acp/run_test.ts src/cli/run_process_test.ts
```

Expected: PASS with ACP wire fixtures and subprocess startup behavior preserved.

---

### Task 5: Migrate ACP session, event, and prompt methods to Core

**Files:**
- Modify: `src/acp/bridge.ts`
- Modify: `src/acp/bridge_protocol.ts`
- Modify: `src/acp/bridge_protocol_test.ts`
- Modify: `src/acp/run_test.ts`
- Modify: `src/core/runtime_protocol.ts`
- Modify: `src/core/dispatcher.ts`
- Modify: `src/core/dispatcher_test.ts`

**Interfaces:**
- `ACPBridge` supports the complete existing prompt lifecycle: `initialize`, `session/new`, `session/load`, `session/prompt`, `session/cancel`, `session/updates`, config/mode updates, and prompt responses.
- Core Runtime Host supplies session creation/open/close, history, prompt, run status, cancel, config updates, and event subscription/replay.

- [ ] **Step 1: Add failing cross-entry contract tests.**

Drive the real `ACPBridge` with a fake Core WebSocket and a real in-memory Runtime Host. Assert that:

```ts
await bridge.handle(sessionNew);
await bridge.handle(sessionPrompt);
expect(acpOutput).toContain('"sessionUpdate"');
expect(coreEvents).toContain("text_delta");
expect(coreCalls).toContain("run.cancel");
```

Assert the same Session ID and Run ID appear in ACP and Core records, and that a terminal event is not emitted twice after replay.

- [ ] **Step 2: Run the contract tests and verify they fail.**

Run:

```bash
cd /home/free/src/opensac
deno test -A src/acp/bridge_protocol_test.ts src/acp/run_test.ts src/core/dispatcher_test.ts
```

Expected: FAIL until the complete prompt path is mapped.

- [ ] **Step 3: Move the session/prompt lifecycle into Core RPC.**

Implement and test:

```text
session.create
session.open
session.close
session.history
session.list
session.config.set
session.prompt
run.status
run.cancel
run.events.subscribe
run.events.replay
```

The ACP bridge may translate ACP-specific prompt content blocks into the neutral Core input contract, but it may not assemble provider messages or call the Agent directly.

- [ ] **Step 4: Preserve prompt response and notification semantics.**

The ACP prompt response must wait for the Core admission/terminal result according to the existing ACP contract. Streaming deltas must be emitted as individual ACP session/update notifications. Cancellation must return the same normalized terminal state as the existing ACP implementation.

- [ ] **Step 5: Run prompt/session contract tests.**

Run:

```bash
cd /home/free/src/opensac
deno test -A src/acp/bridge_protocol_test.ts src/acp/run_test.ts src/core/dispatcher_test.ts
```

Expected: PASS with no direct Agent or Provider call in ACP bridge code.

---

### Task 6: Migrate ACP approval, question, attachment, project, and manage extensions

**Files:**
- Create: `src/acp/bridge_extensions.ts`
- Create: `src/acp/bridge_extensions_test.ts`
- Modify: `src/acp/bridge.ts`
- Modify: `src/acp/bridge_protocol.ts`
- Modify: `src/core/runtime_protocol.ts`
- Modify: `src/core/dispatcher.ts`
- Modify: `src/core/dispatcher_test.ts`

**Interfaces:**
- Core provides `approval.request`, `approval.resolve`, `question.request`, `question.resolve`, `attachment.list`, `attachment.fetch`, `project.*`, and `manage.*` operations.
- ACP bridge maps `permission/request`, `question/request`, `fs/read_text_file`, `fs/write_text_file`, `opensac/manage/*`, and all existing additive ACP extensions without direct filesystem, database, or Agent access.

- [ ] **Step 1: Write failing extension contract tests.**

Use fake Core reverse requests and responses to assert:

```ts
await bridge.handle(coreApprovalRequest);
const acpRequest = output.requests[0];
assertEquals(acpRequest.method, "session/requestPermission");
await bridge.handle(acpPermissionResponse);
assert(coreClient.responses.some((response) => response.id === coreRequestId));
```

Also cover attachment fetch, project listing, manage requests, decision deadlines, and external run status notifications.

- [ ] **Step 2: Run extension tests and verify they fail.**

Run:

```bash
cd /home/free/src/opensac
deno test -A src/acp/bridge_extensions_test.ts src/core/dispatcher_test.ts
```

Expected: FAIL because extension mapping and Core extension methods are not complete.

- [ ] **Step 3: Implement Core extension methods.**

Move domain behavior for attachment/project/manage/decision operations behind Core RPC. The Core implementation may call the existing `src/session`, `src/dao`, `src/agentruntime`, and `src/mcp` owners, but it must not import ACP modules.

- [ ] **Step 4: Implement ACP extension projections.**

`bridge_extensions.ts` owns the translation from Core results to the existing ACP response/update shapes. It must not open files, access SQLite, inspect environment variables for domain state, or call Agent methods.

- [ ] **Step 5: Run extension and full ACP tests.**

Run:

```bash
cd /home/free/src/opensac
deno test -A src/acp/ src/cli/run_process_test.ts
```

Expected: PASS for existing ACP extensions and bridge-specific contracts.

---

### Task 7: Remove ACP Runtime ownership and enforce architecture boundaries

**Files:**
- Modify: `src/acp/run.ts`
- Modify: `src/acp/server.ts`
- Modify: `src/architecture/guard.ts`
- Modify: `src/architecture/architecture_guard_test.ts`
- Modify: `src/architecture/test_hygiene_guard_test.ts`
- Modify: `AGENTS.md`
- Create: `src/acp/ownership_test.ts`

**Interfaces:**
- ACP production code depends on Core Client, Core protocol, ACP wire/protocol/projection, and transport helpers only.
- Core Runtime Host is the only new Core boundary allowed to import runtime implementation modules.
- Existing ACP legacy server code may remain only behind a documented migration bridge until all extension tests pass; no direct runtime fallback is allowed after this task.

- [ ] **Step 1: Write failing ownership guard tests.**

Add synthetic fixtures proving these are rejected in `src/acp/`:

```text
new Agent(...)
createAgentManager(...)
new SessionRuntime(...)
create(...)
createManager(...)
openRootDB(...)
new RunStore(...)
new DecisionService(...)
```

Also assert `src/acp/bridge*.ts` cannot import `src/session/`, `src/agent/`, `src/agentruntime/`, Provider implementation modules, or SQLite drivers.

- [ ] **Step 2: Run architecture tests and verify the new guards fail.**

Run:

```bash
cd /home/free/src/opensac
deno test -A src/architecture/architecture_guard_test.ts
```

Expected: FAIL until guard and ACP imports are migrated.

- [ ] **Step 3: Remove direct ACP Runtime ownership.**

`runACP` must no longer instantiate:

```text
RecoveryCoordinator
Provider
SandboxManager
SkillsManager
SessionRuntime
AgentManager
MCP clients
RunStore
DecisionService
```

Keep compatibility helpers only when they are pure ACP wire/protocol functions. Move remaining domain operations behind Core RPC before deleting their ACP imports.

- [ ] **Step 4: Update architecture guidance and tests.**

Document the final ownership rule:

```text
Core Runtime Host owns domain state.
ACP bridge owns stdio/wire/projection only.
TUI/CLI/WebUI migration remains a later phase.
```

Add a test that checks `opensac acp --help`, ACP wire fixtures, and architecture tests still pass.

- [ ] **Step 5: Run focused ownership and ACP tests.**

Run:

```bash
cd /home/free/src/opensac
deno test -A src/acp/ownership_test.ts src/architecture/
deno test -A src/acp/ src/cli/run_process_test.ts
```

Expected: PASS and no direct ACP Runtime ownership violation.

---

### Task 8: End-to-end ACP bridge, reconnect, and full verification

**Files:**
- Create: `src/acp/core_bridge_integration_test.ts`
- Modify: `src/core/final_review_test.ts`
- Modify: `docs/proposal/opensac-core-acp-bridge-design.md` only for final implementation names
- Modify: `AGENTS.md`

**Interfaces:**
- Exercises `opensac acp` → ACPBridge → Core WebSocket/JSON-RPC → CoreRuntimeHost with real filesystem/runtime persistence.
- Verifies global Core remains alive after ACP EOF and reconnects with cursor replay.

- [ ] **Step 1: Write failing end-to-end tests.**

Start a real Core Runtime Host on an ephemeral port and run ACP bridge input/output through in-memory stdio. Assert:

```ts
assertEquals(core.healthy, true);
assertEquals(acpOutput.includes('"sessionUpdate"'), true);
await bridge.close();
assertEquals(core.healthy, true);
```

Add cases for cancel, approval pending, ACP reconnect, Core restart, and two ACP bridges sharing one Core.

- [ ] **Step 2: Run the integration test and verify it fails before the final path is complete.**

Run:

```bash
cd /home/free/src/opensac
deno test -A src/acp/core_bridge_integration_test.ts
```

Expected: FAIL until the complete bridge path is integrated.

- [ ] **Step 3: Implement only missing integration glue.**

Do not add new domain semantics in this task. Fix transport, lifecycle, correlation, and cleanup defects revealed by the integration tests.

- [ ] **Step 4: Run focused ACP/Core/architecture verification.**

Run:

```bash
cd /home/free/src/opensac
deno test -A src/acp/ src/core/ src/cli/run_process_test.ts
deno task test:architecture
```

Expected: PASS.

- [ ] **Step 5: Run full repository verification.**

Run:

```bash
cd /home/free/src/opensac
TMPDIR=/home/free/src/opensac-test-tmp deno task test
deno task check
deno task lint
deno fmt --check
```

Expected: all tests pass with 0 failures; check, lint, and format pass.

- [ ] **Step 6: Review the diff and leave it uncommitted.**

Run:

```bash
cd /home/free/src/opensac
git diff --stat
git diff --check
git status --short
```

Confirm no generated binaries, password values, HTTP/3 dependency, direct ACP Runtime ownership, or changes to `session_runtime_leases` are present. Do not commit unless explicitly requested.

## Follow-on Plans

After ACP bridge verification:

1. TUI Core Client migration;
2. CLI Print Core Client migration;
3. WebUI Core JSON-RPC projection;
4. public Core Client SDK extraction;
5. removal of remaining legacy adapter-only compatibility bridges.
