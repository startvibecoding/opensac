# TUI Service Abstraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the interactive TUI depend on a front-end-neutral `TUIService` port backed by the shared `opensac core`, removing direct TUI ownership of Provider, Builder, SessionRuntime, AgentManager, Decision, and session persistence. The TUI becomes a thin client of the single shared Core process, alongside the ACP bridge.

**Architecture:** Introduce a small TUI-facing service contract with session lifecycle, prompt/event streaming, cancellation, configuration, skills, attachments, and capability operations. The production adapter is `createCoreClientTUIService(...)` over `src/core/client.ts`: the TUI discovers or auto-startes the shared `opensac core` exactly like `opensac acp` (`CoreClient.ensureStarted()`), speaks the Core JSON-RPC protocol plus the canonical event stream, and may run against an isolated private Core (`startPrivateCore`) for standalone isolation. An in-process `CoreRuntimeHost` adapter is **not** the endpoint of this migration; if a task needs one to stage a change it is a named migration bridge (owner: `src/cli/root_tui.ts` wiring) whose removal condition is deletion the moment the transport adapter covers the same capability. Migrate basic session/run flows before advanced AgentManager, ESM, and transient-agent flows so each stage remains independently testable. CLI print (`-P`) migrates to the same Core Client short connection (Task 7) so both interactive and print entry points are clients of one Core.

**Tech Stack:** Deno 2.9+, TypeScript 6, existing `src/core/client.ts` (CoreClient) and `src/core/runtime_protocol.ts` Core JSON-RPC surface, existing `src/core/runtime.ts` neutral event contracts, existing `src/tui` projection/controller code, `@std/assert`, canonical `CoreRuntimeEvent` values.

**Spec:** This plan follows the approved TUI/Core boundary in the conversation and the completed Core/ACP migration plan at `docs/superpowers/plans/2026-09-25-opensac-acp-bridge.md`.

**Execution status (2026-09-26):** Tasks 1–3 are implemented and verified, and Task 4 is implemented except for the dialog-settings projection remainder (see Task 4 Step 4); commit steps stay for the integrator because working rules prohibit unsolicited commits. The Core parameter parsers now carry the neutral `mode`/`thinkingLevel`/`capabilities`/`attachments`/`metadata` fields the host already accepted (previously dropped on the RPC path, silently ignoring ACP `--mode`/`--thinking` and prompt attachments; covered by `src/core/dispatcher_test.ts`). Task 3 routes `TUISession` lifecycle, prompt admission, run-event consumption, cancellation, deletion, and approval/question answering through `TUIService`; `src/cli/root_tui.ts` builds the Core Client transport service (`createCoreClientTUIService` over shared-Core discovery/auto-start exactly like `opensac acp`) and closes it on exit. Task 3 additionally gave the Core the neutral surface those flows need: `session.delete`, `CoreSessionCreateInput.sessionId` (adopt/open-or-create one persisted identity, used while the command-layer bridge mints the ID), per-prompt `providerName`/`modelID`/`mode`/`thinkingLevel`/`preparedInputs` overrides, `CorePromptAccepted.agentId`, and canonical `payload.agentEvent` on run events (JSON-safe Error projection in `src/agentruntime/session_executor.ts`). Decisions are Core reverse requests (`approval.request`/`question.request`) correlated by request ID through the port's `onDecisionRequest`/`answerDecision`. Task 4 added the neutral capability surface (`session.skills.list`, `session.skill.set`, `session.skill.state`, `session.capabilities`, `input.prepare`; `listSessionSkills`/`prepareInput`/`sessionCapabilities` on `CoreRuntimeHost`; `models: [{id, name}]` on the secret-safe provider view) and routed the TUI skill, prepared-input, provider-listing, and `/model` flows plus every policy-binding change through `TUIService`. Task 4 Step 4 (second pass, 2026-09-26) added the editor-document surface and moved every settings/env/context flow behind the service: neutral Core methods `settings.get`/`settings.update` (scope-aware read of the effective or global-sparse document and sparse global/project patch), `model.catalog` (built-in-plus-configured provider catalog with resolved models), `model.validate` (pair validation rethrowing the raw factory cause), `env.list`/`env.update` (whole-document env round-trip), and `session.context.get`/`session.context.set` (rule/extra system-prompt context); `TUIService` gained `getSettings`/`updateSettings`/`listProviders`/`validateProviderModel`/`listEnv`/`updateEnv`/`getSessionContext`/`setSessionContext`. `DefaultModelDialog`/`AuthDialog`/`SettingsDialog`/`EnvDialog`/`TuiLangDialog` now render from service-loaded documents and persist through `TUIService` (fire-and-forget with the existing dialog error presentation), `DialogHost.settings` and the `providerIDs` provider-factory catalog are gone, and `/rule`, `/statusline`, `/env` subcommands, `setDefaultModel`, `tuiLang`, and `/btw`'s context read all go through the service. Settings edits flowing through the service now also refresh the Core-owned shared settings snapshot in place (`refreshSharedSettings` in `src/core/runtime_host.ts`), fixing the staleness where Core prompts kept startup settings after a TUI edit; project-scope patches write the session work directory's project settings via `saveProjectSettingsPatchFor`. Asynchronous service completions repaint through a `TUISession.setRenderScheduler` hook wired in `src/cli/root_tui.ts` (idle repaints only; streaming keeps the 100 ms batch timer), and closed dialogs settle their outcome messages through `TUISession.requestRender`. The expert commands (`/expert list|show|bind|unbind|switch`) now run through `TUIService.listExperts`/`showExpert`/`expertState`/`setExpert`/`forkSession` over the neutral Core surface `expert.list`/`expert.show`/`expert.state`/`expert.set`/`session.fork`; the Runtime-owned fork preserves the source identity/history and applies a non-null expert only to the child branch, and switching one bound expert to another still requires a fork (the Core rethrows the raw cause). Task 5 (2026-09-26) moved the advanced runtime features behind the service: neutral Core methods `agent.list`/`agent.destroy`, `delegate.set`/`delegate.get`, `session.capability.set`, `esm.state`/`esm.update`/`esm.continue`/`esm.stop`, `transient.prompt`, and `session.compact` (plus `CoreAgentView`/`CoreEsmView`/`CoreEsmObjectiveView` projections and RPC parsers). `ProductionCoreSessionRuntime` now owns the lazily-built shared `AgentManager` and the `delegate_subagent` registration, the Core-owned ESM continuation worker (Supervisor loop over the session ESM store; roles run as managed child agents through the new `src/agentruntime/esm_role_adapter.ts` — `TuiESMRuntimeAdapter`/`src/tui/esm_tui_adapter.ts` is deleted — and surface canonical `esm_status`/`esm_finished`/`agent_event` run events the TUI consumes), the read-only `/btw` transient side query, and forced compaction as an event-only run (`session.compact`; the TUI reports `compact.done`/`compact.skipped` from the terminal payload instead of the old `compact.empty` bridge). `/delegate`, `/browser`, `/agent list|switch|destroy`, `/esm …`, `/btw`, and `/compact` all run through `TUIService`; `TUISession` has no `ensureAgentManager`/`#agentManager`/`AgentManager` import, and the Ctrl+O agent tabs extend from the service projection. The per-session run-policy prerequisite for print landed with Task 5: `CoreSessionCreateInput`/`CoreSessionView` carry `source`/`approvalPolicy`/`questionPolicy` (e.g. print-mode `cli`/`print`/`unattended`) and they persist into the canonical run intent policy (covered by `src/core/runtime_host_test.ts`). Residual migration bridges still active (owner: `src/tui/tui_session.ts` + `src/tui/tui_commands.ts`, removed by Task 6): the private `SessionRuntime`/`Manager` for the provider/model binding (`create()` factory, `configureSession`/`bindSession`, `TUISession.#settings`/`loadSettingsWithMeta`), the `fork`/`forkSession`/session-switch command bridge over `session_lifecycle`/`src/session` listing (SessionsDialog, cron's `manager.getSessionDir`, `TuiRun` sessionDir), and the TUI-minted persisted session identity. Task 6 must also decide where the pervasive `src/agent/events.ts` event-vocabulary imports go (they fall under Task 6's `src/agent/` import ban for `src/tui`/`src/cli/root_tui.ts`, so the canonical event types likely need a neutral re-export module or an explicit, documented allowlist entry). Remaining before this plan is complete: Task 6 (guard + removal of transitional imports) and Task 7 (CLI print over the Core Client short connection; its per-session `source`/run-policy Core surface already exists).

**Execution status (2026-09-27, Task 6):** Task 6 is implemented and verified (`deno task test` 2137 passed / 1 failed, the single failure being the production architecture guard's expected `src/cli/root_print.ts` violations that Task 7 removes; `src/tui/ownership_test.ts` is green). The final TUI boundary is enforced in `src/architecture/guard.ts` (`TUI_FORBIDDEN_IMPORT_ROOTS` — the plan's list plus the named `session_lifecycle`/`fork` bridge — `TUI_SERVICE_FORBIDDEN_IMPORT_ROOTS`, `CLI_PRINT_FORBIDDEN_IMPORT_ROOTS`, `TUI_FORBIDDEN_NEW_CLASSES`/`TUI_FORBIDDEN_CALLS`/`TUI_ENTRY_FILES` construction bans, and `tuiBoundaryViolations`, all inside `productionViolations`), and every transitional bridge is gone: `TUISession` has no `SessionRuntime`/`Manager`/`Settings`/`DecisionService`/`create()` binding (`configureSession`/`bindSession`/`loadSettingsWithMeta`/provider-model getters deleted; binding is the service-owned `#providerName`/`#modelID` string pair mirrored with `setSessionConfig`, display defaults from the Core `settings()` projection), no TUI-minted session identity (`createFreshSession()` adopts the Core-minted canonical view; `adoptSession(view)` covers switch/fork), decisions answer the originating Core request via `service.answerDecision`, session listing/switch/fork/delete/clear run through `service.listPersistedSessions`/`openSession`/`forkSession`/`deleteSession`/`createSession`, the cron store roots through `config.getSessionDir`, and `TuiRun` carries no `decisions`/`sessionDir`. The event vocabulary resolves as the plan allowed: a neutral `src/agentruntime/events.ts` re-export of the canonical `src/agent/events.ts` vocabulary consumed by the eight TUI modules. New Core-owned surface: `session.listPersisted`/`CoreSessionListEntry`/`listPersistedSessions` (host + dispatcher + `TUIService`/fake/`core_service.ts`) and `CoreSessionRuntime.persistedSummary()` (eager persisted identity plus work-directory/persisted-mode projection into `CoreSessionView`). Remaining before this plan is complete: Task 7 (CLI print over the Core Client short connection; its per-session `source`/run-policy Core surface already exists) and the re-run of the complete final verification with it.

**Execution status (2026-09-27, Task 7):** Task 7 is implemented and the plan's verification is complete: `deno task test` 2145 passed / 0 failed, `deno task test:architecture` 11 passed (18 steps) with zero TUI/CLI runtime-owner bypasses (`productionViolations` empty), and `deno task check`/`deno task lint`/`deno fmt --check`/`git diff --check` are clean. CLI print (`-P`) runs over the Core Client short connection (`CoreClient` discovery/auto-start + `createCoreClientTUIService`, the same shared `opensac core` as the TUI/ACP), creates one fresh Core-owned session per run with `source: cli`/`approvalPolicy: print`/`questionPolicy: unattended`, projects canonical run events into the unchanged text/NDJSON output, and keeps `-P`/`--json`/continuation/exit-code semantics (exit 1 only for a failed turn; a `failed` terminal status alone still exits 0 — preserved quirk). `src/cli/print_test.ts` (7 tests) covers the projections, the unattended decision answers (approval denied + question answered empty), the semantics locks, and the no-`Builder`/`ExecutionRuntime` assertion. Residual known gaps to decide outside this plan: `--workflows` in print has no Core surface yet (the Core assembles resources with `workflows: false`, same as the migrated ACP run), and the print exit-code quirk above. Commit steps for Tasks 6/7 remain for the integrator.

## Global Constraints

- TUI must not construct `Provider`, `Builder`, `SessionRuntime`, `AgentManager`, `DecisionService`, `RunStore`, or session persistence handles after the migration is complete.
- Core remains the sole owner of Agent, Provider, SessionRuntime, AgentManager, Decision, Run, persistence, and canonical events.
- TUI remains responsible for rendering, keyboard/input state, dialogs, activity presentation, and translating user actions into service calls.
- Preserve existing session IDs, work directories, settings semantics, approval/question correlation, event ordering, and prompt/cancel behavior.
- The TUI is a client of the single shared Core: `src/cli/root_tui.ts` builds a `CoreClient`, discovers/auto-starts `opensac core` exactly like `opensac acp`, and never constructs Runtime implementations. Standalone isolation means `startPrivateCore` (a real private Core process), not an in-process Runtime.
- Any in-process adapter is a named migration bridge with a documented owner and removal condition; the production path is the Core Client transport. "Reuse" means reusing the shared Core runtime path and lifecycle, not calling the Agent loop from a second orchestrator.
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
- Create `src/tui/core_service.ts`: adapter translating `TUIService` calls to Core Client JSON-RPC calls (`CORE_RUNTIME_METHODS`) and the canonical event stream over `CoreClient`/`CoreEventConnection`.
- Create `src/tui/core_service_test.ts`: adapter tests with a fake Core client seam covering prompt, replay, cancel, config, skills, and errors.
- Modify `src/tui/tui_session.ts`: replace direct lifecycle and run execution with service calls; keep UI projection state locally.
- Modify `src/tui/tui_session_commands.ts`: replace direct Runtime/Manager calls with service capability calls as each capability is migrated.
- Modify `src/tui/tui_commands.ts`: route settings/provider/model/skill operations through the service port.
- Modify `src/cli/root_tui.ts`: construct the Core Client-backed TUI service (shared Core discovery/auto-start, optional private Core) and inject it into `TUISession` without changing CLI argument parsing or TUI startup semantics.
- Modify `src/core/runtime_protocol.ts` / `src/core/dispatcher.ts` / `src/core/runtime_host.ts`: add only neutral Core methods the TUI service needs (capability projections); do not import TUI types.
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

- [x] **Step 1: Write failing contract tests.**

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

- [x] **Step 2: Run the contract test and verify it fails.**

Run:

```bash
deno test -A src/tui/service_test.ts
```

Expected: FAIL because `src/tui/service.ts` and the fake do not exist.

- [x] **Step 3: Implement the port and fake.**

Define the interfaces with no runtime implementation imports. The fake must generate deterministic IDs (`session-1`, `run-1`), retain events in memory, and expose a test-only `emit()` method that appends one canonical event with monotonically increasing sequence values.

- [x] **Step 4: Run the contract test and verify it passes.**

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

### Task 2: Implement the Core Client transport adapter for the TUI service

**Files:**
- Create: `src/tui/core_service.ts`
- Create: `src/tui/core_service_test.ts`
- Modify: `src/core/runtime_protocol.ts` only if a neutral method is missing from the Core JSON-RPC surface.

**Interfaces:**
- `createCoreClientTUIService(client: TUICoreClient, options?: CoreTUIServiceOptions): TUIService`.
- `TUICoreClient` is the narrow client seam (JSON-RPC `call`, event connection, close) satisfied structurally by `CoreClient`; tests substitute a deterministic fake.
- `CoreTUIServiceOptions` may provide a `source` string and a `now()` function for deterministic tests; it must not provide Provider or SessionRuntime factories to TUI code.
- The adapter translates Core results without changing event payloads or error causes.

- [x] **Step 1: Write failing adapter tests.**

Use a fake `TUICoreClient` and assert that `createSession` sends `session.create` with the resolved defaults:

```ts
const service = createCoreClientTUIService(fakeClient);
const session = await service.createSession({
  workDir: "/workspace/project",
  providerName: "test-provider",
  modelID: "test-model",
});
assertEquals(fakeClient.calls[0], {
  method: "session.create",
  params: {
    workDir: "/workspace/project",
    providerName: "test-provider",
    modelID: "test-model",
  },
});
```

Assert prompt calls `session.prompt`, event iteration delegates to `run.events.subscribe`/`run.events.replay` and yields the canonical `run.event` notifications in order, cancel calls `run.cancel`, config calls `session.config.set`, and skills/attachments/capabilities fail with the explicit capability error until Task 4 adds those Core methods.

- [x] **Step 2: Run the adapter tests and verify they fail.**

```bash
deno test -A src/tui/core_service_test.ts
```

Expected: FAIL because the adapter does not exist.

- [x] **Step 3: Implement the adapter.**

Map `TUIService` calls to the existing Core JSON-RPC methods in `src/core/runtime_protocol.ts`. Do not import `src/provider`, `src/agent`, `src/agentruntime/session_runtime.ts`, or `src/session` from `core_service.ts`.

For an event stream, replay from the cursor first, then yield live `run.event` notifications from the event connection in arrival order. For prompt errors, rethrow the original error. For optional service methods not yet present in Core, return `Error("TUI capability is not available in the Core Runtime")` rather than silently returning an empty success value.

- [x] **Step 4: Run the adapter tests and verify they pass.**

```bash
deno test -A src/tui/core_service_test.ts src/tui/service_test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the adapter.**

```bash
git add src/tui/core_service.ts src/tui/core_service_test.ts src/core/runtime_protocol.ts
git commit -m "refactor(tui): add Core Client transport service adapter"
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

- [x] **Step 1: Write failing TUI session service tests.**

Construct `TUISession` with `createFakeTUIService()` and assert that submitting text calls `service.prompt`, forwards returned event payloads to the existing `AppController`, and exposes the accepted run ID to cancel/replay paths. Assert that `close()` calls `service.closeSession` exactly once.

- [x] **Step 2: Run the focused tests and verify they fail.**

```bash
deno test -A src/tui/tui_session_service_test.ts src/tui/tui_session_commands_test.ts
```

Expected: FAIL because `TUISession` still constructs and drives `SessionRuntime` directly.

- [x] **Step 3: Inject the service and migrate lifecycle calls.**

Change the constructor to accept `service: TUIService`. Replace direct `createSession`, `openSession`, `deleteSessionRuntime`, prompt admission, event consumption, and cancellation calls with the corresponding service methods. Preserve the existing UI projection methods and error strings.

The first green implementation may retain a private `SessionRuntime` reference only for capabilities not yet represented by `TUIService`; it must not be used for prompt admission, event delivery, or cancellation after this task. This residual reference is a named migration bridge (owner: `src/tui/tui_session.ts`) with the removal condition that Task 4/5 capability methods replace it; it may not survive Task 6.

- [x] **Step 4: Run the focused tests and verify they pass.**

```bash
deno test -A src/tui/tui_session_service_test.ts src/tui/tui_session_commands_test.ts src/tui/app_controller_test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the lifecycle slice.**

(Deferred to the integrator: working rules prohibit unsolicited commits.)

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

- [x] **Step 1: Write failing capability contract tests.**

Add one test per capability: settings/provider/model view is secret-safe; artifact/resource reads return Core-owned projections; attachment list uses the session work directory; skill activation updates the session projection; unsupported capabilities produce the explicit capability error.

(Implemented 2026-09-26 in `src/tui/core_service_test.ts`, `src/tui/service_test.ts`, and `src/core/runtime_host_test.ts`; the contract tests were written together with the implementation and verified green rather than recorded red first.)

- [x] **Step 2: Run the focused tests and verify they fail.**

```bash
deno test -A src/tui/core_service_test.ts src/tui/tui_commands_test.ts src/tui/tui_session_commands_test.ts
```

Expected: FAIL because the service port and Core host do not yet expose all required neutral capability methods.

- [x] **Step 3: Add only neutral Core operations.**

Add methods to `CoreRuntimeHost` and implement them in `createCoreRuntimeHost`. Reuse existing Core handlers and managers; do not expose raw `SessionRuntime`, `AgentManager`, Provider, or Manager objects. Keep all secret masking in Core.

(Done: `listSessionSkills`, `prepareInput`, `sessionCapabilities`, `session.skill.set`, `session.skill.state`, `session.skills.list`, `input.prepare`, `session.capabilities`; settings/provider/model view reuses the existing secret-safe `manage.settings.get` projection, whose provider entries now also carry `models: [{id, name}]`; attachment listing reuses `attachment.list`.)

- [x] **Step 4: Update TUI commands to use service projections.**

Replace direct `this.#runtime.settingsSnapshot()`, `this.#runtime.provider`, `this.#runtime.model`, `this.#runtime.prepareInput()`, and direct skill index access with service calls. Keep dialogs responsible only for editing and displaying returned projections.

**Partial (2026-09-26):** done — `/skills` + `/skill` + `/skill:<name>` (skill index/activation/clear via `listSkills`/`setSkillActive`), `/paste-image` (`prepareInput` through `service.prepareInput`), `/auth` provider listing (`service.settings()`), `/model` (existence check + `ModelDialog` render the `listModels` projection), and every provider/model/mode/thinking change mirrors into `service.setSessionConfig` so Core-run prompts share the binding.

**Completed (2026-09-26, second pass):** `DefaultModelDialog`/`AuthDialog`/`SettingsDialog`/`EnvDialog`/`TuiLangDialog` render from service-loaded settings/provider/env documents and persist through `service.updateSettings`/`validateProviderModel`/`listProviders`/`updateEnv` (fire-and-forget with the existing dialog `#error`/outcome presentation and `requestRender` settle); `DialogHost.settings`, `providerIDs`, and the `src/provider`/`src/config` write paths are gone from `src/tui/dialogs.ts` and `src/tui/auth_dialog.ts`. `/rule` now sets Core-owned session context via `service.setSessionContext` (so Core-run prompts see it immediately instead of the stale private-runtime field), `/statusline` and `/env` subcommands, `setDefaultModel`, and `tuiLang` write settings/env through the service (Core refreshes its shared settings snapshot), and `/btw` reads `extraContext` via `service.getSessionContext`. The expert slice (2026-09-26) then moved `/expert list|show|bind|unbind|switch` behind the service with neutral Core methods `expert.list`/`expert.show`/`expert.state`/`expert.set`/`session.fork`: expert discovery and binding stay Core-owned (`CoreSessionRuntime.listExperts`/`inspectExpert`/`expertState`/`setExpert`), the Runtime-owned fork (`fork`/`forkWithExpert` semantics) creates the child branch with the expert applied only there, and `TUIService` gained `listExperts`/`showExpert`/`expertState`/`setExpert`/`forkSession`; `tui_commands.ts` no longer imports `src/agentruntime/expert.ts`/`fork.ts` expert helpers (only the command-layer `openSession` rebind bridge remains, Task 6). Contract tests cover the port fake (`src/tui/service_test.ts`), the Core Client adapter (`src/tui/core_service_test.ts`), and the Core host/dispatcher surface (`src/core/runtime_host_test.ts`, `src/core/dispatcher_test.ts`). Remaining direct-runtime reads (`ensureAgentManager`'s `settingsSnapshot`/`provider`/`model`, `/btw` construction, `fork`/`forkSession` command bridge, SessionsDialog listing) are explicitly Task 5/6 scope.

- [x] **Step 5: Run focused and architecture tests.**

```bash
deno test -A src/tui/ src/core/runtime_host_test.ts src/architecture
```

Expected: PASS with no TUI import of Provider, SessionRuntime, AgentManager, or persistence implementations outside the explicitly documented transitional adapter.

(PASS: 333 tests. The "no TUI import of Provider/..." expectation is not yet true — the transitional bridge in `src/tui/tui_session.ts` and command/dialog modules still import runtime/provider modules; the hard import prohibition lands in Task 6.)

- [ ] **Step 6: Commit the capability slice.**

(Deferred to the integrator: working rules prohibit unsolicited commits.)

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

- [x] **Step 1: Write failing advanced-feature tests.**

Use a fake Core host and assert that TUI delegate/ESM/agent commands call neutral service methods and render returned projections. Assert that the TUI never receives or constructs an `AgentManager`.

(Implemented 2026-09-26 alongside the slice and verified green rather than recorded red first: `src/tui/delegate_integration_test.ts` (delegate on/off/list/destroy/compact routing through `TUIService`), `src/tui/esm_wiring_test.ts` (Core worker stream consumption + idle settle), `src/tui/tui_session_commands_test.ts` (/btw transient routing), `src/tui/core_service_test.ts` (one-call-per-capability mapping for agent/delegate/capability/ESM/transient/compact), `src/core/dispatcher_test.ts` (new RPC surface forwarding + param rejection), and `src/core/runtime_host_test.ts` (production delegate tool registration on the shared registry, ESM supervisor state/continuation/stop, transient prompt over a read-only registry, compact run terminal semantics, and per-session source/run-policy persistence).)

- [x] **Step 2: Run the focused tests and verify they fail.**

```bash
deno test -A src/tui/tui_session_commands_test.ts src/tui/tui_commands_test.ts src/tui/esm_wiring_test.ts
```

Expected: FAIL because TUI still directly creates and calls `AgentManager` and ESM runtime adapters.

(Superseded by the combined test+implementation pass above; all focused suites are green.)

- [x] **Step 3: Add Core capability projections and operations.**

Move ownership and mutation into Core Runtime Host. The TUI service must expose serializable views and command results, not runtime objects. Preserve existing source labels, cancellation, and event ordering.

(Done: neutral Core methods `agent.list`/`agent.destroy`, `delegate.set`/`delegate.get`, `session.capability.set`, `esm.state`/`esm.update`/`esm.continue`/`esm.stop`, `transient.prompt`, and `session.compact`, with `CoreAgentView`/`CoreEsmView`/`CoreEsmObjectiveView` projections and parsers in `runtime_protocol.ts`. `ProductionCoreSessionRuntime` owns the lazily-built shared `AgentManager` (`createAgentManager`), the `delegate_subagent` tool registration, the Core-owned ESM continuation worker (Supervisor loop over the session ESM store; roles run as managed child agents through the new `src/agentruntime/esm_role_adapter.ts`, replacing `TuiESMRuntimeAdapter`) with canonical `esm_status`/`esm_finished`/`agent_event` run events, the read-only transient side query (`buildTransientAgent`), and forced compaction as an event-only run. Per-session `source` and run policy (`approvalPolicy`/`questionPolicy`, e.g. print `print`/`unattended`) now travel on `CoreSessionCreateInput`/`CoreSessionView` and persist into the canonical run intent policy — the Task 7 prerequisite the execution status called out. `TUIService` exposes `listAgents`/`destroyAgent`/`setDelegate`/`delegateState`/`setCapability`/`esmState`/`esmCommand`/`esmContinue`/`esmStop`/`askTransient`/`compact` over the port, the fake, and the Core Client adapter.)

- [x] **Step 4: Replace direct TUI advanced-runtime calls.**

Change `ensureAgentManager`, delegate commands, ESM continuation, transient-agent construction, and agent tabbar data access to call `TUIService`. Remove the private `#agentManager` field and all direct `AgentManager` imports.

(Done: `TUISession.ensureAgentManager`/`#agentManager` and every `AgentManager`/`createAgentManager` import are gone; `src/tui/esm_tui_adapter.ts` is deleted. `/delegate`, `/browser`, `/agent list|switch|destroy`, `/esm …`, `/btw`, and `/compact` all run through `TUIService`; the ESM continuation is a Core-owned worker whose canonical run events the TUI consumes (`#consumeEsmEvents`) and whose abort goes through `esm.stop`; `/compact` consumes its canonical run through `consumeRunEvents`; the Ctrl+O tool-modal agent tabs extend from the service projection. The `/browser` capability toggle also moved (`session.capability.set`), keeping `CommandHost` free of the runtime registry.)

- [x] **Step 5: Run the full TUI/Core/architecture regression.**

```bash
deno test -A src/tui/ src/core/ src/architecture/
deno task check
deno task lint
deno fmt --check
```

Expected: PASS with no direct TUI runtime-owner imports.

(PASS: `deno task test` 2133 passed/0 failed, `deno task test:architecture` 11 passed (18 steps), `deno task check`/`deno task lint`/`deno fmt --check src docs` clean. The "no direct TUI runtime-owner imports" expectation still holds only partially: the documented Task 6 bridge remains in `src/tui/tui_session.ts` (provider factory/`Builder`/`configureSession` binding, `src/session` `Manager` identity), `src/tui/tui_commands.ts`/`session_commands.ts`/`dialogs.ts` (`src/session` listing, `session_lifecycle` rebind), and the pervasive `src/agent/events.ts` event-vocabulary imports that Task 6's guard must re-home.)

- [ ] **Step 6: Commit the advanced-feature slice.**

```bash
git add src/core src/tui
 git commit -m "refactor(tui): move advanced runtime features behind service"
```

(Deferred to the integrator: working rules prohibit unsolicited commits.)

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

- [x] **Step 1: Write failing architecture tests.**

Add a production guard assertion that rejects these imports from `src/tui/*.ts` and `src/cli/root_tui.ts`:

```text
src/agent/
src/agentruntime/session_runtime.ts
src/provider/
src/session/
src/dao/
```

Also assert that `src/tui/service.ts` has no local runtime implementation imports and that `TUISession` has no `new Builder`, `createAgentManager`, `createSession`, or `DecisionService` construction.

(Done, 2026-09-27: `src/architecture/guard.ts` gained `TUI_FORBIDDEN_IMPORT_ROOTS` (plus `src/agentruntime/session_lifecycle.ts`/`fork.ts`, the named command-layer bridge), `TUI_SERVICE_FORBIDDEN_IMPORT_ROOTS` (the pure port imports no runtime implementation module at all), `CLI_PRINT_FORBIDDEN_IMPORT_ROOTS`, `TUI_FORBIDDEN_NEW_CLASSES`/`TUI_FORBIDDEN_CALLS`/`TUI_ENTRY_FILES` construction bans (`src/tui/tui_session.ts`, `src/cli/root_tui.ts`, `src/cli/root_print.ts`), and `isTuiFrontendPath`/`tuiBoundaryViolations`; the checks run inside `productionViolations`. `src/tui/ownership_test.ts` asserts the real tree plus a fixture that every ban root and construction is rejected. The event-vocabulary decision is a neutral re-export module: `src/agentruntime/events.ts` re-exports the canonical `src/agent/events.ts` vocabulary and the eight TUI consumers import it instead of `src/agent/`.)

- [x] **Step 2: Run the guard test and verify it fails.**

```bash
deno test -A src/tui/ownership_test.ts src/architecture/architecture_guard_test.ts
```

Expected: FAIL while transitional imports remain.

(Observed, 2026-09-27: the guard was wired after the bridge removal in the same session, so the TUI graph went straight to green; the failing-first state was reproduced on `src/cli/root_print.ts`, which the same guard rejects with 19 violations until Task 7 migrates it.)

- [x] **Step 3: Remove transitional imports and dead compatibility fields.**

Delete private fields and branches that exist only to access Runtime internals. Keep UI-only state such as controller, input, dialogs, activity rows, and presentation flags in TUI.

(Done, 2026-09-27: `TUISession` no longer has `#runtime`/`#manager`/`#settings`/`#provider`/`#model`/`#decisions`, no `create()` factory binding, no `loadSettingsWithMeta`, no `configureSession`/`bindSession`, no `new Builder`/`new DecisionService`, and no `runtime`/`manager`/`settings`/`provider`/`model`/`decisions` getters. The provider/model binding is the service-owned string pair (`#providerName`/`#modelID`) mirrored with `setSessionConfig`; display defaults resolve from the Core `settings()` projection in `start()`. Decision answers (`answerApproval`/`answerQuestion`) go straight to the originating Core request via `service.answerDecision` (first-response-wins and the resolved DecisionRecord stay Core-owned; unknown/expired decisions are dropped silently while the panel still advances), and `TuiRun` is built without `decisions`/`sessionDir`. Session listing/switch/fork/delete/clear run through `service.listPersistedSessions`/`openSession`/`forkSession`/`deleteSession`/`createSession` (`src/tui/session_commands.ts` only formats rows; `SessionsDialog` renders service-loaded items; `dialogHost.sessionDir` and the `sessionDirectory` helper are gone), the cron store roots through the shared `config.getSessionDir`, and the persisted session identity is Core-owned: `#bindServiceSession`'s client-minted ID is replaced by `createFreshSession()` (Core mints and returns the canonical view) plus `adoptSession(view)` for switch/fork. `tui_commands.ts`/`tui_session_commands.ts` read settings documents through `service.getSettings()` instead of a private `Settings` handle, and `/fork`/`/expert switch` share the Core-owned fork without the `openSession`/`bindManager` rebind bridge. The Core gained the neutral surface this needs: `session.listPersisted` (dispatcher/parser/host), `CoreSessionListEntry`, `listPersistedSessions` on `CoreRuntimeHost`/`TUIService`/the fake/`core_service.ts`, and `CoreSessionRuntime.persistedSummary()` (ProductionCoreSessionRuntime establishes the persisted identity eagerly and projects its work directory/persisted mode into `CoreSessionView`; covered by `src/core/runtime_host_test.ts` "Core-owned session identity..." and `src/core/dispatcher_test.ts` "...session.listPersisted listings").)

- [x] **Step 4: Run the complete final verification.**

```bash
deno test -A
deno task check
deno task lint
deno fmt --check
git diff --check
```

Expected: all tests pass and the architecture guard reports no TUI runtime-owner bypass.

(Run, 2026-09-27: `deno task test` 2137 passed / 1 failed — the single failure is the production architecture guard flagging `src/cli/root_print.ts` (19 violations), which is Task 7's own scope and is re-run green after the print migration; `src/tui/ownership_test.ts` and the rest of the suite pass. The complete final verification is re-run and reported with Task 7.)

- [ ] **Step 5: Commit the final boundary.**

```bash
git add src/architecture src/tui src/cli/root_tui.ts
git commit -m "refactor(tui): enforce Core service ownership boundary"
```

(Deferred to the integrator: working rules prohibit unsolicited commits.)

---

## Completion Criteria

- `TUISession` and TUI command modules depend on `TUIService`, not concrete Runtime implementation modules.
- `createCoreClientTUIService` (Core Client transport) is the production adapter used by the TUI entrypoint; the TUI and CLI print run as clients of the single shared `opensac core`.
- CLI print (`-P`) uses the same Core Client short connection and produces the same print/NDJSON projections from canonical Core events.
- Core owns all Provider, SessionRuntime, AgentManager, Decision, Run, persistence, and advanced capability state.
- TUI still preserves prompt UX, dialogs, event rendering, approval/question handling, session switching, cancel, reconnect/replay, and error presentation.
- ACP remains Core-only and no ACP domain fallback is introduced.
- The full repository test suite, type-check, lint, format, and diff checks pass.
- The TUI service abstraction is documented in the final architecture guidance.

## Execution Order

1. Task 1: service port and fake.
2. Task 2: Core Client transport adapter.
3. Task 3: session lifecycle and prompt execution.
4. Task 4: settings, resources, attachments, skills, and capabilities.
5. Task 5: AgentManager, ESM, delegate, and transient-agent features.
6. Task 6: final ownership guard and cleanup.
7. Task 7: CLI print (`-P`) Core Client migration.

---

### Task 7: Migrate CLI print (`-P`) to the Core Client

**Files:**
- Modify: `src/cli/root_print.ts`
- Modify/create: focused print tests

**Interfaces:**
- `root_print.ts` connects through `CoreClient` (shared Core discovery/auto-start, same port as the TUI and ACP bridge) instead of constructing `Builder`/`ExecutionRuntime`.
- Print mode streams the same canonical Core events into the existing text/NDJSON projections; `-P`, `--json`, session continuation/resume, and exit codes keep their current semantics.

- [x] **Step 1: Write failing print tests** asserting print output/NDJSON projections are produced from canonical Core events through the service/client seam, and that no `Builder`/`ExecutionRuntime` construction remains in `root_print.ts`.
- [x] **Step 2: Run the focused tests and verify they fail.**
(Observed, 2026-09-27: the Task 6 guard reproduced the failing-first state for `root_print.ts` — 19 import/construction violations, including `new Builder`/`createSession`/`ExecutionRuntime` construction — before the rewrite; `src/cli/print_test.ts` then drives the new seam.)
- [x] **Step 3: Reimplement print mode over the Core Client short connection** (create/open session, `session.prompt`, subscribe/replay run events, project, close).
(Done, 2026-09-27: `runPrintAction` now discovers/auto-starts the shared `opensac core` through `CoreClient` + `createCoreClientTUIService` exactly like the TUI (`openPrintService`; tests inject the service seam via `PrintDeps.service`), creates one fresh Core-owned session per print run with `source: "cli"`/`approvalPolicy: "print"`/`questionPolicy: "unattended"` (`multiAgent` travels as a session capability, `--delegate` through `service.setDelegate`; `core_service.ts` now forwards `source`/`approvalPolicy`/`questionPolicy` on `session.create`), submits `session.prompt`, and projects the canonical run events through `coreEventToAgentEvent` into the unchanged text/NDJSON projections (`-P`, `--json`, `wrapLines`, the `Using …` banner, and the `[tool: …]`/`[running: …]`/`done|error: …` rows are byte-compatible; NDJSON lines go through the same `writeOut`/stdout writer as text). Human decisions stay Core-owned: `onDecisionRequest` answers questions empty (unattended question policy) and denies approvals so the run is never wedged, while the canonical `EVENT_TOOL_APPROVAL_REQUEST` still fails the turn with the preserved message and exit 1. `-c/--continue`/`-r/--resume` keep their current semantics (parsed but unused by `-P`; one fresh session per run) and exit codes are preserved exactly (exit 1 only for a failed turn/`runErr`; a `failed` terminal status alone still exits 0 — flagged as a pre-existing quirk for the integrator). `--workflows` has no Core surface yet (the Core assembles resources with `workflows: false`, same as the migrated ACP run) and is documented as residual rather than silently emulated. New focused tests: `src/cli/print_test.ts` (7 tests — text projection, NDJSON projection, approval failure + unattended answer, question unattended, exit-code semantics, fresh-session continuation semantics, and the no-`Builder`/`ExecutionRuntime` guard assertion).)
- [x] **Step 4: Run focused tests plus `deno task test:architecture` and verify they pass.**
(PASS, 2026-09-27: `deno test -A src/cli/print_test.ts` 7 passed; `deno task test:architecture` 11 passed (18 steps); `deno task test` 2145 passed / 0 failed; `deno task check`, `deno task lint`, `deno fmt --check`, and `git diff --check` are clean. The architecture guard reports zero TUI/CLI runtime-owner bypasses — `productionViolations` is empty, so the Task 6 expectation now holds for `src/cli/root_print.ts` too.)
- [ ] **Step 5: Commit the print migration.**

(Deferred to the integrator: working rules prohibit unsolicited commits.)

```bash
git add src/cli/root_print.ts
 git commit -m "refactor(cli): run print mode over the Core Client"
```
