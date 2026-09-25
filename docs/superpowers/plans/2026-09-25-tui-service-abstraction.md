# TUI Service Abstraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the interactive TUI depend on a front-end-neutral `TUIService` port backed by the Core Runtime Host, removing direct TUI ownership of Provider, Builder, SessionRuntime, AgentManager, Decision, and session persistence.

**Architecture:** Introduce a small TUI-facing service contract with session lifecycle, prompt/event streaming, cancellation, configuration, skills, attachments, and capability operations. Implement an in-process `CoreTUIService` adapter over `CoreRuntimeHost` first, preserving the existing `opensac` TUI startup path; later transport adapters can reuse the same port without changing UI code. Migrate basic session/run flows before advanced AgentManager, ESM, and transient-agent flows so each stage remains independently testable.

**Tech Stack:** Deno 2.9+, TypeScript 6, existing `src/core/runtime.ts` and `src/core/runtime_host.ts`, existing `src/tui` projection/controller code, `@std/assert`, canonical `CoreRuntimeEvent` values.

**Spec:** This plan follows the approved TUI/Core boundary in the conversation and the completed Core/ACP migration plan at `docs/superpowers/plans/2026-09-25-opensac-acp-bridge.md`.

## Global Constraints

- TUI must not construct `Provider`, `Builder`, `SessionRuntime`, `AgentManager`, `DecisionService`, `RunStore`, or session persistence handles after the migration is complete.
- Core remains the sole owner of Agent, Provider, SessionRuntime, AgentManager, Decision, Run, persistence, and canonical events.
- TUI remains responsible for rendering, keyboard/input state, dialogs, activity presentation, and translating user actions into service calls.
- Preserve existing session IDs, work directories, settings semantics, approval/question correlation, event ordering, and prompt/cancel behavior.
- Preserve the current `opensac` TUI startup behavior; the first adapter is in-process over `CoreRuntimeHost`, not a new network dependency.
- `CoreRuntimeEvent` values remain the only source of prompt lifecycle events consumed by the TUI.
- Service calls must preserve raw error causes and map them to the existing TUI error presentation rather than swallowing them.
- Tests that mutate `OPENSAC_DIR` or other process-wide state must restore it in `finally` and must not run concurrently with other tests that mutate the same state.
- Do not remove the current ACP Core-only boundary or reintroduce ACP domain imports while changing TUI.
- Do not commit or push until the user explicitly requests integration; this plan is documentation only.

## Review Focus

- A prompt accepted before a TUI reconnect must replay from the last event cursor without duplicating text, tool, or terminal events.
- Closing or cancelling a TUI session must release the Core-owned run, decision, and runtime resources exactly once.
- Approval and question responses must correlate to the originating Core request even when the TUI re-renders or a second prompt is submitted.
- A service error must reach the TUI with enough context to show the existing error state and must not be converted into a successful terminal event.
- A Core session must retain its work directory, provider/model configuration, active skills, attachments, and advanced capability state across TUI command reloads.

---

## File Map

The migration uses these focused units:

- Create `src/tui/service.ts`: TUI-facing service interfaces and view types; no Agent, Provider, SessionRuntime, or persistence imports.
- Create `src/tui/service_test.ts`: contract behavior and fake-service tests independent of Core implementation.
- Create `src/tui/core_service.ts`: adapter translating `TUIService` calls to `CoreRuntimeHost` calls and canonical event streams.
- Create `src/tui/core_service_test.ts`: adapter tests with a fake `CoreRuntimeHost` covering prompt, replay, cancel, config, skills, and errors.
- Modify `src/tui/tui_session.ts`: replace direct lifecycle and run execution with service calls; keep UI projection state locally.
- Modify `src/tui/tui_session_commands.ts`: replace direct Runtime/Manager calls with service capability calls as each capability is migrated.
- Modify `src/tui/tui_commands.ts`: route settings/provider/model/skill operations through the service port.
- Modify `src/cli/root_tui.ts`: construct the Core-backed TUI service and inject it into `TUISession` without changing CLI argument parsing or TUI startup semantics.
- Modify `src/core/runtime.ts`: add only neutral service-facing contracts that the TUI adapter needs; do not import TUI types.
- Modify `src/core/runtime_host.ts`: implement neutral capability methods needed by the TUI adapter, including resource/skill/agent operations when required by the task.
- Modify `src/architecture/guard.ts`: prohibit TUI production files from importing runtime implementation packages after the final migration task, with a narrow transitional allowlist only while the staged tasks are active.
- Modify `src/architecture/ownership_test.ts` or create `src/tui/ownership_test.ts`: assert TUI service/adapter boundaries and reject direct runtime-owner construction.

---

### Task 1: Define the TUI service port and deterministic fake

**Files:**
- Create: `src/tui/service.ts`
- Create: `src/tui/service_test.ts`

**Interfaces:**
- Produces `TUIService`, `TUISessionInput`, `TUISessionView`, `TUIPromptInput`, `TUIPromptAccepted`, `TUIRunView`, `TUICancelInput`, `TUISessionConfig`, `TUISkillInput`, `TUIAttachmentInput`, `TUIAttachmentView`, and `TUICapabilityView`.
- Produces `createFakeTUIService()` for TUI tests; the fake owns no filesystem, database, provider, Agent, or Runtime implementation.

`src/tui/service.ts` must expose this shape:

```ts
export interface TUIService {
  createSession(input: TUISessionInput): Promise<TUISessionView>;
  openSession(input: { sessionId: string }): Promise<TUISessionView>;
  closeSession(input: { sessionId: string }): Promise<void>;
  prompt(input: TUIPromptInput): Promise<TUIPromptAccepted>;
  subscribeRunEvents(
    sessionId: string,
    runId: string,
    cursor?: number,
  ): AsyncIterableIterator<CoreRuntimeEvent>;
  cancelRun(input: TUICancelInput): Promise<TUIRunView>;
  setSessionConfig(input: TUISessionConfig): Promise<TUISessionView>;
  setSkillActive(input: TUISkillInput): Promise<TUISessionView>;
  addAttachment(input: TUIAttachmentInput): Promise<TUIAttachmentView>;
  capabilities(input: { sessionId: string }): Promise<TUICapabilityView>;
}
```

The port must use strings, plain records, dates, and canonical event values only. It must not expose `SessionRuntime`, `AgentManager`, `Provider`, `Manager`, `DecisionService`, or `RunStore` types. Import `CoreRuntimeEvent` as a type from `../core/runtime.ts`; do not import any Core implementation module. The concrete view types must contain only these fields: session identity/work directory/source/provider/model/mode/thinking/capabilities/timestamps for `TUISessionView`; run identity/status/sequence/error/timestamps for `TUIRunView`; attachment identity/name/media type/size for `TUIAttachmentView`; and capability name/enabled/available metadata for `TUICapabilityView`.

- [ ] **Step 1: Write failing contract tests.**

Add tests that construct `createFakeTUIService()` and assert:

```ts
const service = createFakeTUIService();
const session = await service.createSession({
  workDir: "/workspace/project",
  providerName: "test-provider",
  modelID: "test-model",
});
const accepted = await service.prompt({
  sessionId: session.sessionId,
  text: "hello",
});
const events: CoreRuntimeEvent[] = [];
for await (const event of service.subscribeRunEvents(
  session.sessionId,
  accepted.runId,
)) events.push(event);
assertEquals(accepted.status, "running");
assertEquals(events.at(-1)?.eventType, "run_finished");
```

Also assert that `createSession`, `prompt`, `cancelRun`, `setSessionConfig`, and `setSkillActive` reject unknown sessions with stable errors, and that `subscribeRunEvents(..., cursor)` emits only events after the cursor.

- [ ] **Step 2: Run the contract test and verify it fails.**

Run:

```bash
deno test -A src/tui/service_test.ts
```

Expected: FAIL because `src/tui/service.ts` and the fake do not exist.

- [ ] **Step 3: Implement the port and fake.**

Define the interfaces with no runtime implementation imports. The fake must generate deterministic IDs (`session-1`, `run-1`), retain events in memory, and expose a test-only `emit()` method that appends one canonical event with monotonically increasing sequence values.

- [ ] **Step 4: Run the contract test and verify it passes.**

Run:

```bash
deno test -A src/tui/service_test.ts
```

Expected: PASS with no filesystem or runtime-owner side effects.

- [ ] **Step 5: Commit the isolated contract.**

```bash
git add src/tui/service.ts src/tui/service_test.ts
git commit -m "refactor(tui): define runtime service port"
```

---

### Task 2: Implement the Core-backed TUI service adapter

**Files:**
- Create: `src/tui/core_service.ts`
- Create: `src/tui/core_service_test.ts`
- Modify: `src/core/runtime.ts` only if a neutral method is missing from `CoreRuntimeHost`.

**Interfaces:**
- `createCoreTUIService(host: CoreRuntimeHost, options?: CoreTUIServiceOptions): TUIService`.
- `CoreTUIServiceOptions` may provide a `source` string and a `now()` function for deterministic tests; it must not provide Provider or SessionRuntime factories to TUI code.
- The adapter translates Core results without changing event payloads or error causes.

- [ ] **Step 1: Write failing adapter tests.**

Use a fake `CoreRuntimeHost` and assert:

```ts
const service = createCoreTUIService(fakeHost);
const session = await service.createSession({
  workDir: "/workspace/project",
  providerName: "test-provider",
  modelID: "test-model",
});
assertEquals(fakeHost.created, [{
  workDir: "/workspace/project",
  providerName: "test-provider",
  modelID: "test-model",
  mode: "yolo",
  thinkingLevel: "",
  capabilities: {},
}]);
```

Assert prompt calls `host.prompt`, event iteration delegates to `host.subscribeRunEvents`, cancel calls `host.cancelRun`, config calls `host.setSessionConfig`, skills call `host.setSessionSkill`, and attachments/capabilities fail with the explicit capability error until Task 4 adds those Core methods.

- [ ] **Step 2: Run the adapter tests and verify they fail.**

```bash
deno test -A src/tui/core_service_test.ts
```

Expected: FAIL because the adapter does not exist.

- [ ] **Step 3: Implement the adapter.**

Map `TUIService` calls directly to the existing `CoreRuntimeHost` methods. Do not import `src/provider`, `src/agent`, `src/agentruntime/session_runtime.ts`, or `src/session` from `core_service.ts`.

For an event stream, return the Core async iterator unchanged. For prompt errors, rethrow the original error. For optional service methods not yet present in Core, return `Error("TUI capability is not available in the Core Runtime")` rather than silently returning an empty success value.

- [ ] **Step 4: Run the adapter tests and verify they pass.**

```bash
deno test -A src/tui/core_service_test.ts src/tui/service_test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the adapter.**

```bash
git add src/tui/core_service.ts src/tui/core_service_test.ts src/core/runtime.ts
git commit -m "refactor(tui): add Core-backed service adapter"
```

---

### Task 3: Move TUI session lifecycle and prompt execution behind the service

**Files:**
- Modify: `src/tui/tui_session.ts`
- Modify: `src/cli/root_tui.ts`
- Create or modify: `src/tui/tui_session_service_test.ts`

**Interfaces:**
- `TUISession` constructor receives a `TUIService` in addition to display options and settings.
- The UI keeps local `#controller`, `#input`, dialogs, and rendering state; it no longer owns the session's prompt execution lifecycle.

- [ ] **Step 1: Write failing TUI session service tests.**

Construct `TUISession` with `createFakeTUIService()` and assert that submitting text calls `service.prompt`, forwards returned event payloads to the existing `AppController`, and exposes the accepted run ID to cancel/replay paths. Assert that `close()` calls `service.closeSession` exactly once.

- [ ] **Step 2: Run the focused tests and verify they fail.**

```bash
deno test -A src/tui/tui_session_service_test.ts src/tui/tui_session_commands_test.ts
```

Expected: FAIL because `TUISession` still constructs and drives `SessionRuntime` directly.

- [ ] **Step 3: Inject the service and migrate lifecycle calls.**

Change the constructor to accept `service: TUIService`. Replace direct `createSession`, `openSession`, `deleteSessionRuntime`, prompt admission, event consumption, and cancellation calls with the corresponding service methods. Preserve the existing UI projection methods and error strings.

The first green implementation may retain a private `SessionRuntime` reference only for capabilities not yet represented by `TUIService`; it must not be used for prompt admission, event delivery, or cancellation after this task.

- [ ] **Step 4: Run the focused tests and verify they pass.**

```bash
deno test -A src/tui/tui_session_service_test.ts src/tui/tui_session_commands_test.ts src/tui/app_controller_test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the lifecycle slice.**

```bash
git add src/tui/tui_session.ts src/cli/root_tui.ts src/tui/tui_session_service_test.ts
git commit -m "refactor(tui): route session lifecycle through service"
```

---

### Task 4: Add service-owned resources, settings, and capability operations

**Files:**
- Modify: `src/core/runtime.ts`
- Modify: `src/core/runtime_host.ts`
- Modify: `src/tui/service.ts`
- Modify: `src/tui/core_service.ts`
- Modify: `src/tui/tui_commands.ts`
- Modify: `src/tui/dialogs.ts`
- Modify: `src/tui/tui_session_commands.ts`
- Modify: corresponding focused tests.

**Interfaces:**
- Add neutral Core methods for the TUI operations that currently read Runtime internals: provider/model/settings view, artifact/resource operations, attachment listing, skill state, and capability discovery.
- TUI service methods must return projections, never mutable Core objects.

- [ ] **Step 1: Write failing capability contract tests.**

Add one test per capability: settings/provider/model view is secret-safe; artifact/resource reads return Core-owned projections; attachment list uses the session work directory; skill activation updates the session projection; unsupported capabilities produce the explicit capability error.

- [ ] **Step 2: Run the focused tests and verify they fail.**

```bash
deno test -A src/tui/core_service_test.ts src/tui/tui_commands_test.ts src/tui/tui_session_commands_test.ts
```

Expected: FAIL because the service port and Core host do not yet expose all required neutral capability methods.

- [ ] **Step 3: Add only neutral Core operations.**

Add methods to `CoreRuntimeHost` and implement them in `createCoreRuntimeHost`. Reuse existing Core handlers and managers; do not expose raw `SessionRuntime`, `AgentManager`, Provider, or Manager objects. Keep all secret masking in Core.

- [ ] **Step 4: Update TUI commands to use service projections.**

Replace direct `this.#runtime.settingsSnapshot()`, `this.#runtime.provider`, `this.#runtime.model`, `this.#runtime.prepareInput()`, and direct skill index access with service calls. Keep dialogs responsible only for editing and displaying returned projections.

- [ ] **Step 5: Run focused and architecture tests.**

```bash
deno test -A src/tui/ src/core/runtime_host_test.ts src/architecture
```

Expected: PASS with no TUI import of Provider, SessionRuntime, AgentManager, or persistence implementations outside the explicitly documented transitional adapter.

- [ ] **Step 6: Commit the capability slice.**

```bash
git add src/core/runtime.ts src/core/runtime_host.ts src/tui/service.ts src/tui/core_service.ts src/tui/tui_commands.ts src/tui/dialogs.ts src/tui/tui_session_commands.ts
git commit -m "refactor(tui): expose Core-owned capabilities through service"
```

---

### Task 5: Migrate advanced AgentManager, ESM, and transient-agent features

**Files:**
- Modify: `src/core/runtime.ts`
- Modify: `src/core/runtime_host.ts`
- Modify: `src/tui/service.ts`
- Modify: `src/tui/core_service.ts`
- Modify: `src/tui/tui_session.ts`
- Modify: `src/tui/tui_session_commands.ts`
- Modify: `src/tui/tui_commands.ts`
- Modify: `src/tui/agent_tabbar.ts`
- Modify: `src/tui/esm_tui_adapter.ts`
- Modify: corresponding TUI/Core tests.

**Interfaces:**
- Add service-level projections for agent list/status, delegate operations, ESM continuation state, and transient-agent actions.
- The Core service owns every `AgentManager`, transient Agent, ESM supervisor, and capability lifecycle.

- [ ] **Step 1: Write failing advanced-feature tests.**

Use a fake Core host and assert that TUI delegate/ESM/agent commands call neutral service methods and render returned projections. Assert that the TUI never receives or constructs an `AgentManager`.

- [ ] **Step 2: Run the focused tests and verify they fail.**

```bash
deno test -A src/tui/tui_session_commands_test.ts src/tui/tui_commands_test.ts src/tui/esm_wiring_test.ts
```

Expected: FAIL because TUI still directly creates and calls `AgentManager` and ESM runtime adapters.

- [ ] **Step 3: Add Core capability projections and operations.**

Move ownership and mutation into Core Runtime Host. The TUI service must expose serializable views and command results, not runtime objects. Preserve existing source labels, cancellation, and event ordering.

- [ ] **Step 4: Replace direct TUI advanced-runtime calls.**

Change `ensureAgentManager`, delegate commands, ESM continuation, transient-agent construction, and agent tabbar data access to call `TUIService`. Remove the private `#agentManager` field and all direct `AgentManager` imports.

- [ ] **Step 5: Run the full TUI/Core/architecture regression.**

```bash
deno test -A src/tui/ src/core/ src/architecture/
deno task check
deno task lint
deno fmt --check
```

Expected: PASS with no direct TUI runtime-owner imports.

- [ ] **Step 6: Commit the advanced-feature slice.**

```bash
git add src/core src/tui
 git commit -m "refactor(tui): move advanced runtime features behind service"
```

---

### Task 6: Enforce the final TUI boundary and remove transitional imports

**Files:**
- Modify: `src/architecture/guard.ts`
- Modify: `src/architecture/architecture_guard_test.ts`
- Create or modify: `src/tui/ownership_test.ts`
- Modify: `src/tui/tui_session.ts`
- Modify: `src/tui/tui_session_commands.ts`
- Modify: `src/tui/tui_commands.ts`
- Modify: `src/tui/service.ts`
- Modify: `src/cli/root_tui.ts`

**Interfaces:**
- The final TUI production graph depends on `src/tui/service.ts`, Core-facing adapter contracts, UI projection modules, and CLI input modules.
- TUI production files must not import `src/agent`, `src/agentruntime/session_runtime.ts`, `src/provider`, `src/session`, or `src/dao` directly.

- [ ] **Step 1: Write failing architecture tests.**

Add a production guard assertion that rejects these imports from `src/tui/*.ts` and `src/cli/root_tui.ts`:

```text
src/agent/
src/agentruntime/session_runtime.ts
src/provider/
src/session/
src/dao/
```

Also assert that `src/tui/service.ts` has no local runtime implementation imports and that `TUISession` has no `new Builder`, `createAgentManager`, `createSession`, or `DecisionService` construction.

- [ ] **Step 2: Run the guard test and verify it fails.**

```bash
deno test -A src/tui/ownership_test.ts src/architecture/architecture_guard_test.ts
```

Expected: FAIL while transitional imports remain.

- [ ] **Step 3: Remove transitional imports and dead compatibility fields.**

Delete private fields and branches that exist only to access Runtime internals. Keep UI-only state such as controller, input, dialogs, activity rows, and presentation flags in TUI.

- [ ] **Step 4: Run the complete final verification.**

```bash
deno test -A
deno task check
deno task lint
deno fmt --check
git diff --check
```

Expected: all tests pass and the architecture guard reports no TUI runtime-owner bypass.

- [ ] **Step 5: Commit the final boundary.**

```bash
git add src/architecture src/tui src/cli/root_tui.ts
git commit -m "refactor(tui): enforce Core service ownership boundary"
```

---

## Completion Criteria

- `TUISession` and TUI command modules depend on `TUIService`, not concrete Runtime implementation modules.
- `CoreTUIService` is the production adapter used by the TUI entrypoint.
- Core owns all Provider, SessionRuntime, AgentManager, Decision, Run, persistence, and advanced capability state.
- TUI still preserves prompt UX, dialogs, event rendering, approval/question handling, session switching, cancel, reconnect/replay, and error presentation.
- ACP remains Core-only and no ACP domain fallback is introduced.
- The full repository test suite, type-check, lint, format, and diff checks pass.
- The TUI service abstraction is documented in the final architecture guidance.

## Execution Order

1. Task 1: service port and fake.
2. Task 2: Core adapter.
3. Task 3: session lifecycle and prompt execution.
4. Task 4: settings, resources, attachments, skills, and capabilities.
5. Task 5: AgentManager, ESM, delegate, and transient-agent features.
6. Task 6: final ownership guard and cleanup.
