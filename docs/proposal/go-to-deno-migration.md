# Go → Deno/TypeScript 1:1 migration

Source of truth: `/home/free/src/mothx` (Go, module
`github.com/startvibecoding/mothx`). Target: this repository
(`src/` mirroring the Go `internal/` + `cmd/` layout).

## Scope

The Go tree is **851 `.go` files / ~246,151 lines** across 38 `internal/`
packages plus `cmd/mothx`. A faithful 1:1 port is a large, multi-stage effort;
this document is the ordered backlog and the running status ledger.

## Translation conventions

| Go | Deno/TS |
| --- | --- |
| `package x` | `src/x/*.ts` modules |
| `XxxYyy` exported | `xxxYyy` exported function/const |
| `struct` | `interface` + plain objects, or `class` when it has methods/lifecycle |
| `error` return | `throw` typed `Error` (or `AggregateError`); `Promise` for async |
| `context.Context` | `AbortSignal` (threaded through cancellable paths) |
| `runtime.GOOS/GOARCH` | `Deno.build.os` / `Deno.build.arch` (mapped back to GOOS/GOARCH names) |
| `os.Getenv` | `Deno.env.get` |
| `path/filepath` | `@std/path` |
| `database/sql` + `uptrace/bun` | `node:sqlite` (`DatabaseSync`) behind `src/db`; DAO owns SQL |
| `modernc.org/sqlite` driver | `node:sqlite` (built into Deno 2.9) |
| `net/http` + `Deno.serve` | `Deno.serve` and standard web APIs |
| `encoding/json` | `JSON` |
| goroutines/channels | `Promise`/async + `Deno.Worker` when real parallelism is needed |
| `testing` | `Deno.test` + `@std/assert` |
| bubbletea/lipgloss TUI | Ink + React (`src/tui`) |
| `charmbracelet/x/ansi` | `string-width` / `wrap-ansi` / `strip-ansi` / `slice-ansi` |
| `GoStreamingMarkdown/gsm` (streaming Markdown) | `src/tsm` (`parser` + `renderer` + `stream`) |
| Go struct tags `json:"..."` | camelCase/`snake_case` mapping helpers in each module |

## Package backlog (dependency order)

Status: ✅ ported · 🟡 partial · ⬜ not started.

| # | Go package | LOC | TS target | Status |
| --- | --- | --- | --- | --- |
| 1 | `internal/util` | 150 | `src/util` | ✅ |
| 2 | `internal/version` | 63 | `src/version` | ✅ |
| 3 | `internal/ua` | 114 | `src/ua` | ✅ |
| 4 | `internal/platform` | 1277 | `src/platform` | ✅ |
| 5 | `internal/systeminit` | 130 | `src/systeminit` | ✅ |
| 6 | `internal/db` | 2170 | `src/db` | ✅ |
| 7 | `internal/imageproc` | 984 | `src/imageproc` | ✅ |
| 8 | `internal/sandbox` | 2255 | `src/sandbox` | ✅ |
| 9 | `internal/config` | 5331 | `src/config` | ✅ |
| 10 | `internal/skills` | 1490 | `src/skills` | ✅ |
| 11 | `internal/contextfiles` | 486 | `src/contextfiles` | ✅ |
| 12 | `internal/expert` | 2288 | `src/expert` | ✅ |
| 13 | `internal/context` | 2803 | `src/context` | ✅ |
| 14 | `internal/provider` | 17607 | `src/provider` | ✅ |
| 15 | `internal/dao` | 3908 | `src/dao` | ✅ |
| 16 | `internal/session` | 21334 | `src/session` | ✅ |
| 17 | `internal/ai` | 173 | `src/ai` | ✅ |
| 18 | `internal/tools` | 6173 | `src/tools` | ✅ |
| 19 | `internal/agent` | 20402 | `src/agent` | 🟡 |
| 20 | `internal/mcp` | 3299 | `src/mcp` | ✅ |
| 21 | `internal/workflow` | 3035 | `src/workflow` | ✅ |
| 22 | `internal/browser` | 838 | `src/browser` | ✅ |
| 23 | `internal/esm` | 3367 | `src/esm` | ✅ |
| 24 | `internal/memory` | 829 | `src/memory` | ✅ |
| 25 | `internal/cron` | 3158 | `src/cron` | ✅ |
| 26 | `internal/agentruntime` | 21399 | `src/agentruntime` | 🟡 |
| 27 | `internal/messaging` | 4546 | `src/messaging` | ✅ |
| 28 | `internal/skillhub` | 2788 | `src/skillhub` | ✅ |
| 29 | `internal/a2a` | 2388 | `src/a2a` | ✅ |
| 30 | `internal/stats` | 811 | `src/stats` | ✅ |
| 31 | `internal/debugpprof` | 187 | `src/debugpprof` | ✅ |
| 32 | `internal/doctor` | 572 | `src/doctor` | ✅ |
| 33 | `internal/update` | 319 | `src/update` | ✅ |
| 34 | `internal/architecture` | 900 | `src/architecture` | ✅ |
| 35 | `internal/acp` | 20753 | `src/acp` | 🟡 |
| 36 | `internal/serve` | 46511 | `src/serve` | 🟡 |
| 37 | `internal/tui` | 33096 | `src/tui` | ⬜ |
| 38 | `cmd/mothx` | 5493 | `src/cli` + `src/main.ts` | ⬜ |

Public SDK surface (`sdk/`, `src/bootstrap/`, `examples/`) mirrors the Go
`bootstrap` + `example/` trees and must not import `src/`.

The top-level public `agent` package (`sdk/agent/`) and the `bootstrap` provider
bridge (`src/bootstrap/`) are ported (see *Known hard parts*); the remaining
`bootstrap` builder registration and `examples/` land with backlog #19.

Backlog #19 (`internal/agent`, 9760 non-test LOC) is in progress. The
front-end-neutral foundation is ported to `src/agent`: `events.ts` (the internal
`Event`/`EventType`/`TaskStatus` vocabulary, whose numeric codes intentionally
differ from the public SDK and are mapped by `bridge.ts`), `provider.ts` (the
package-local provider contract, retained for 1:1 fidelity), `max_tokens.ts`,
`tool_launch.ts` (the ordered parallel start chain), `parallel.ts`
(`boundedParallel`, async deviation), `iteration_budget.ts` (policy + per-run
budget handle), `memberdef.ts`, `mailbox.ts` (the session-level member
completion queue), `followup.ts` (`composeFollowUps`), `router.ts`,
`run_context.ts` (the `RunContext` value bag replacing Go `context.Context`),
and `external_tool_adapter.ts` (public `ExternalTool` → internal `Tool`). A
companion `src/platform` fix adds the missing embedded Windows BusyBox helpers
(`ensureWindowsBusybox`/`windowsBusyboxPath`) that `system_prompt.ts` imports.
A later run added `compaction.ts` (`compactionSettingsFromConfig`),
`eventloop.ts` (`EventHandler`/`eventHandlerFunc`/`consumeEvents`, with Go's
`<-chan Event` mapped to an `AsyncIterable<Event>`), `agent_approval.ts` (the
`needsApproval` decision logic and bash allow/deny helpers exposed as functions
over a minimal `ApprovalConfig` view until the `Agent` struct lands),
`iteration_budget_tool.ts` (the stateless `ExtendBudgetTool`, reading the
per-run budget from the tool context via a new generic `ToolContext.values`
value bag plus `toolContextWithIterationBudget`/`iterationBudgetFromToolContext`), and
`subagent_wait.ts` (`SubAgentWaitTool` + `resolveSubAgentWaitTimeoutMS` over a
narrow manager interface). 43 translated/focused tests pass, plus 29 for this
batch (72 in `src/agent`).
A later run added the stateless helpers of the two remaining core files so they
are ready when the `Agent` struct lands: `agent_context.ts` (the request-size
estimators `estimateChatRequestTokens`/`estimateGuardRequestTokens`/
`estimateProviderUsage`/`completeProviderUsage`, the image-request admission
budget `providerImageRequestBudget`/`encodedImagePayloadBytes`/
`containsImageContent`/`toolResultImages`, `repairDanglingToolCalls`, the
context-guard `isContextGuardToolResult`/`contextGuardToolResult`,
`clampMaxTokensToContext`, the prompt-cache `selectCacheMarkers`/
`applyCacheMarkers`, and the content-rejection helpers
`contentRejectionPlaceholder`/`stripImagesFromMessage`/`lastUserTurnIndex` plus
`streamRecoveryRetryDelay`/`waitForStreamRecoveryRetry`) and `agent_support.ts`
(the `AgentContext` type and `cloneAgentContext`/`cloneMessages`/
`cloneMessagesWithoutUsage`/`cloneMessage`/`cloneContentBlock`,
`normalizeToolCallArguments`, `retryCompatibilityStatus` with a faithful
`goDurationString`, `buildOutputRecoveryMessage`/`buildStreamRecoveryMessage`,
`isOutputTruncationReason`, `replayTextContent`, `usageStatsProviderName`,
`isReadOnlyToolName`/`isSideEffectingToolName`,
`toolExecutionResultSummary`/`parseToolExecutionResultSummary`, and
`toolExecutionContext` over the `ToolContext`/`ExecutionTimeoutProvider`
contract). The `cache_test.go`/`max_tokens_test.go` clamp cases and the
`repairDanglingToolCalls` table were translated; 36 focused tests were added
(108 in `src/agent`; full suite 870). Remaining #19 work is the core loop
(`agent.go` ~2916 lines, `agent_context.go` ~1230 lines), the approval/question
*coordination* (`RequestToolApproval`/`RequestQuestion` and handlers on the
`Agent`), sub-agents (`subagent*.go`, `subagent_tools.go`), `factory.go`,
`manager.go`, `bridge.go`, then the `bootstrap` `agent.setBuilderFunc`
registration, `examples/`, and the translated `agent_test.go`/loop tests.
A later run added the remaining standalone helpers from `agent.go`
(`imageGenerationToolDefinition`, `configuredWebSearchToolDefinition`,
`openAIResponsesWebSearchToolDefinition` in `agent_support.ts`, each with its
Go test translated) and the stateless helpers from `subagent.go` /
`subagent_tools.go` / `manager.go` in `subagent_support.ts` (`subAgentToolNames`,
`resolveMemberMode`/`modeWithinCapability`/`restrictMemberTools`,
`buildSubAgentTask`, `SubAgentPolicy` + `defaultSubAgentPolicy` +
`validateSubAgentPolicy`, and the `isTerminalManagedState`/`appendUniqueAgentID`/
`removeAgentID` bookkeeping helpers). The `Agent` struct, all `Agent`-bound
`agent_context.go` methods, the sub-agent tools that call `AgentManager`, and
`factory.go`/`manager.go` themselves still require the core loop.

A later run landed the first slice of the core `Agent` instance model in
`src/agent/agent.ts`: the run-scoped context helpers
(`contextWithAgentID`/`contextWithEventChan`/`contextWithParentRunContext`/
`contextWithParentMode` and their extractors over the `RunContext` value bag),
the `Config`/`AgentLoopConfig` types with every callback context
(`ShouldStopAfterTurnContext`/`PrepareNextTurnContext`/`TurnUpdate`/
`BeforeToolCallContext`/`BeforeToolExecuteContext`/`ToolCallBlockResult`/
`AfterToolCallContext`/`ToolCallResult`), the `Agent` class, and the
constructors `newAgent`/`newAgentWithLoopConfig` (compaction normalization,
`ForcedMode` precedence, tool-execution mode/concurrency resolution, and the
one-time `buildFrozenPrompt`). It also ports the Agent-bound accessors from
`agent_context.go` that do not need the loop: `getMessages`/`getHistoryState`/
`setMessages`/`getContext`/`setContext`/`getContextUsage`/`setForceCompact`,
`loadHistoryMessages`/`loadHistoryState`, `setConversationTurn`, `abort`/
`aborted`, `callbackSnapshot`/`agentEndEvent`, `isToolRegisteredForRun`,
`maxToolConcurrency`, `escalatedMaxTokens`, and the image-admission gate
(`supportsImages`/`gateToolResultImages`/`validateImageRequestBudget`). 24
focused tests were translated from `coverage_test.go`, `max_tokens_test.go`,
`parallel_test.go`, and the image cases of `agent_test.go`. Remaining #19 work
is the core loop (`Agent.Run`/`RunWithUserMessage`/`RunWithMessages`/
`RunWithLoadedHistory`, `loop`, `sendEvent`/`emit`/`emitRunFinished`, the
`eventSink`), the request-assembly and compaction/recovery methods of
`agent_context.go`, the tool-execution/approval/durable-claim paths,
`factory.go`/`manager.go`/`subagent*.go`, `bridge.ts` `AgentAdapter`, the
`bootstrap` builder registration, `examples/`, and the translated
`agent_test.go`/loop tests.

A later run ported the request-assembly and compaction-decision methods of
`agent_context.go` onto the `Agent` class in `src/agent/agent.ts`:
`buildSessionContextMessage` (the dynamic `[session context]` message),
`outputReserveTokens`/`requestTokenBudget`, `buildRequestMessages` (with
`repairDanglingToolCalls`), `replaceLargestToolResultForContext` (the context
guard that omits the largest compactable tool result), `maxTokensForRequest`
(clamping the output limit to the context window), `previousCompactionSummary`
(the persisted compaction summary with the `## Goal` fallback), `canCompact`
and `shouldAutoCompact` (over `context.hasCompactableMessages` /
`shouldCompactPercent`), and `shouldCompact` (forced-then-auto). 10 focused
tests were translated from `agent_test.go`'s force-compact cases plus focused
request-assembly tests (171 in `src/agent`). Remaining #19 work is the core loop
(`Agent.Run`/`RunWithUserMessage`/`RunWithMessages`/`RunWithLoadedHistory`,
`loop`, `sendEvent`/`emit`/`emitRunFinished`, the `eventSink`),
`prepareRequestMessages`/`compact`/`compactIfNeeded`/`tryRecoverContextOverflow`
(require the loop's event channel and the sub-agent summarizer),
`truncateHistoryForOverflow`/`stripRefusedImages`/`tryRecoverContentRejection`/
`tryRetryStreamTimeout`/`tryContinueStreamFailure`, the
tool-execution/approval/durable-claim paths, `factory.go`/`manager.go`/
`subagent*.go`, `bridge.ts` `AgentAdapter`, the `bootstrap` builder
registration, `examples/`, and the translated `agent_test.go`/loop tests.

A later run ported the Agent-bound event pipeline and the approval/question
*coordination* that the earlier runs deferred (the standalone decision logic was
already in `agent_approval.ts`). `src/agent/agent.ts` now owns an exported
`EventSink` type (`(ev: Event) => boolean`, the TS projection of Go's
`chan<- Event`), the context-aware `sendEvent` (delivers unless the run context
is aborted, otherwise counts the drop for `logDroppedEvents`), `emit`, and the
`Agent` methods `needsApproval`/`requestApproval`/`requestToolApproval`/
`handleApprovalResponse`/`requestQuestion`/`handleQuestionResponse`/
`deliverQuestionAnswer`/`askQuestion`. Go's blocking `select { responseCh,
a.abort, ctx.Done }` becomes a promise raced against the agent abort signal and
the run-context signal via a private `#raceCancellation`; approval/question IDs
still embed the agent ID and the per-instance counters stay per agent. This run
also repaired the working tree: a prior aborted loop-port attempt had left
`agent.ts` importing ~110 loop-only symbols it never used (a hard `deno check`
error on a wrong `Provider` import plus 115 `deno lint` `no-unused-vars`
errors). The unused imports were removed and `Provider` now comes from
`src/provider/provider.ts`. `src/agent/agent_coordination_test.ts` translates
`agent_approval_test.go` (5 cases) and `send_event_test.go` (3 cases) plus a
`needsApproval` method case, adapting the channel-blocking assertions to the
async sink model; 9 tests pass, full suite 1120. Remaining #19 work is the core
loop (`Agent.Run`/`RunWithUserMessage`/`RunWithMessages`/`RunWithLoadedHistory`,
`loop`, `emitRunFinished`, `injectFollowUpMessages`, the `eventSink`/`EventChannel`
wiring), the request-assembly and compaction/recovery methods of
`agent_context.go`, the tool-execution/approval/durable-claim paths,
`factory.go`/`manager.go`/`subagent*.go`, `bridge.ts` `AgentAdapter`, the
`bootstrap` builder registration, `examples/`, and the translated
`agent_test.go`/loop tests.

A later run (this one) completed the Agent Core construction and lifecycle
layer of backlog #19 that the earlier slices deferred. `bridge.ts` now exports
`AgentAdapter`/`newAgentAdapter`, the TS projection of the Go `AgentAdapter`
that wraps the internal `Agent` and satisfies the public `sdk/agent.Agent`/
`QuestionHandler` interface; Go's `WrapEventChan` maps to a lazy async generator
applying `eventToPublic` to each internal event. `src/agent/manager.ts` ports
`manager.go`: the `AgentManager` (`agents`/`parentOf`/`children`/`statuses`/
`cancels`/`listeners` maps, the team `members`/`mailbox`/`expertID` fields,
`newAgentManager`, `setMemberContext`/`setMemberWaitEnabled`, `create` with
parent validation and the Decision-5 nested-sub-agent rejection,
`register`/`get`/`destroy`/`detachChild`/`finish` with recursive child
cancellation and retained terminal statuses, `markRunning`/`markDone`/
`markIncomplete`/`markError`/`markCanceled` with sticky terminal states and
listener fan-out, `status`/`statusesList`/`list`/`getChildren`/`parent`/
`count`/`hasRunning`, and `updateRuntimeConfig`); Go's `sync.RWMutex` is
dropped (Deno is single-threaded), `context.CancelFunc` maps to `() => void`,
`time.Time` maps to `Date`, and the `(value, ok)` pair returns stay tuples.
`src/agent/factory.ts` ports `factory.go`: the `AgentFactory`/`AgentOptions`/
`AgentFactoryOptions` types, `createAgent` (per-agent Registry with mode-based
sandbox selection, sub-agent tool removal for children, mailbox steering/follow
-up wiring, and the `BeforeToolCall` composition), `newAgentFactory`/
`newAgentFactoryWithOptions`, `withParentRuntimeConfig`/`withRuntimeConfig`/
`resolveAgentMode`, `createFromPublicOptions`, `buildFromPublicBuilder`, and the
module-level `setBuilderFunc(buildFromPublicBuilder)` that mirrors Go's
`init()`; `src/bootstrap/mod.ts` now imports `../agent/factory.ts` so the public
`Builder.build()` resolves, mirroring Go's `bootstrap` blank import of
`internal/agent`. `src/agent/subagent.ts` ports `subagent.go`/`subagent_tools.go`:
the `SubAgentSpawnTool`/`DelegateSubAgentTool`/`SubAgentStatusTool`/
`SubAgentSendTool`/`SubAgentAnswerTool`/`SubAgentDestroyTool`, `registerSubAgent
Tools`/`registerDelegateSubAgentTool`, `ChildEventMeta` + `forwardChildAgent
Event`/`forwardMemberQuestion`/`sendParentEvent`, `lastAssistantResponse`, the
`memberNotifier`, and `normalizeSubAgentRunError`; Go's goroutine-per-spawn maps
to a fire-and-forget async task, `<-chan agentpkg.Event` maps to `for await`
over the public `Agent.run` stream, and `context.WithTimeout` maps to a derived
`AbortSignal` carrying timeout/parent-cancellation flags. `agent.ts` also gains
the `ToolContext` reader helpers (`agentIDFromToolContext`/`eventSinkFromTool
Context`/`parentRunContextFromToolContext`/`parentModeFromToolContext`) that
project the Go context-value reads. New translated tests:
`manager_test.ts` (17 cases from `manager_test.go`), `subagent_test.ts` (15 from
`subagent_test.go`/`subagent_tools_test.go`), and `factory_test.ts` (4: the two
parent-runtime-config inheritance cases, workflow-prompt isolation, and
provider-name propagation), sharing `agent_testutil.ts`. Full suite is 1170
passed / 0 failed, architecture 8/8, lint clean (498 files), check clean.
Remaining #19 work is the background Responses tool-call paths
(`buildBackgroundChatParams`/`BuildBackgroundContinuationParams`/
`BuildBackgroundReplayParams`/`ResponsesStateFallbackError`/
`ExecuteBackgroundToolCall*`/`workDirForAgent` in `agent.go`), the
`examples/` (simple_agent, custom_provider), and the remaining translated
`agent_test.go`/loop/terminal-contract cases.

A later run began backlog #26 (`internal/agentruntime`) by porting the
front-end-neutral foundation slice that the architecture's "one
source-of-truth resolver" and "one decision model" invariants depend on, and
flipped the ledger row to partial (🟡). `src/agentruntime/policy.ts`+`source.ts`
ports `policy.go`+`source.go`: the `RuntimeSource`/`Source` vocabularies and
their mode constants, the `ExecutionPolicy`/`Policy` class with
`hasForcedMode`/`forcedMode`/`resolveMode`, `ModeResolver`,
`resolveIterationBudget` (delegating to the ported
`normalizeIterationBudgetPolicy`), `sourceFromChannelType`/
`sourceFromSessionHeader`/`sourceWaitsForMembers`, `isValidMode`,
`resolveUnattendedMode`, and the `SourceResolutionInput`/`SourceResolution`/
`SourceConflictError`/`resolveSource`/`resolveSourceFromSession`/
`policyForSource`/`resolvePolicy`/`resolvePolicyFromSession` precedence rules.
`src/agentruntime/decision.ts` ports `decision.go` (the `DecisionKind`
vocabulary, `DecisionRequest`/`DecisionResolution`, and the `DecisionService`
with register/bind/resolve/resolveWith/rehydrate/clearRun/clearRunWithValue
and first-response-wins semantics; Go's `sync.Mutex` is dropped because Deno is
single-threaded, and the `(DecisionRequest, error)` return throws instead).
`src/agentruntime/decision_record.ts` ports `decision_record.go`
(`DecisionRecord` + the request/resolution constructors, with an explicit
`reviveDecisionRecordDates` because session event data is pre-decoded in the
port). `decision_replay.ts` ports `decision_replay.go`
(`replayDecisions`/`replayDecisionsAt`/`expiredDecisions`).
`decision_events.ts` ports `decision_events.go` (the decision status constants,
the canonical `decisionEventEnvelope`/`decisionEventFields`, `newDecisionRecord`,
`DecisionTransition`, `buildDecisionEvent`/`recordDecisionEvent`/
`decodeDecisionEvent`, and `loadDecisionRecords`/`loadRunDecisionRecords`; the
Go `context.Context`-carrying `*Context` variants are dropped because the DAO
layer is synchronous). `src/agentruntime/run_event.ts` ports `run_event.go`
(`RunEvent`/`RunEventSink`/`RunEventSinkFunc`/`RunEventProjector`,
`withAssistantEntryData`, and the `SessionRunEventSink`), deferring
`withRunAttemptData` (needs `DurableRun`) and `withTerminalErrorInfo` (needs
`ErrorInfo`) to the `ExecutionRuntime`/`error_info` slice. Deliberate
deviations: `json.RawMessage` maps to decoded `unknown`, `time.Time` maps to
`Date`, Go's `(resolution, mode, error)` multiple return maps to an
`ExecutionPolicyResult` value object so the partial conflict resolution is
preserved, and the decision constants keep Go's snake_case status strings
because they are persisted wire values. New translated tests:
`source_test.ts` (14, from `source_test.go`/`source_contract_test.go`/
`policy_test.go`, deferring the Go `SessionRuntime` close case),
`decision_test.ts` (9, from the record/replay/resolver/contract/rehydrate
tests), `decision_events_test.ts` (4, including the durable round trip and the
session/run ledger load), and `run_event_test.ts` (3). The same slice also ports
the dependency-light read/projection layer: `run_state.ts` (the `RunState`
vocabulary + `isTerminalRunState` from `execution.go`), `run_queries.ts`
(`getDurableRun`/`getActiveDurableRun`/`listLatestDurableRunsBySessions`/
`annotateDurableRunError`), `run_replay.ts` (`RunReplay` + `replayRunEvents`/
`runStateFromEvent`/`replayRunEventsJSON`), `delivery_events.ts`,
`delivery_replay.ts` (`DeliveryRecord` + `replayDeliveries`/
`replayDeliveriesFromRunEvents`/`newDeliveryReconciledEvent`),
`idempotency.ts` (`idempotencyKeyFingerprint` via `node:crypto` SHA-256, the
submission-table lookup, and the schema-33 legacy event-scan bridge),
`session_directories.ts` (`normalizeAdditionalDirectories`, with an explicit
`cleanPath` because `@std/path.normalize` preserves a trailing slash unlike
`filepath.Clean`), and `fork.ts` (`fork`/`forkWithExpert` delegating to
`session.forkSession`). New translated/focused tests for the layer:
`run_queries_test.ts` (2), `run_replay_test.ts` (3),
`delivery_replay_test.ts` (2), `idempotency_test.ts` (3), and
`session_directories_test.ts` (2). 42 tests pass in `src/agentruntime`; full
suite 1220 passed / 0 failed, architecture 8/8, lint clean (525 files), check
clean, fmt clean. Remaining #26 work is the `SessionRuntime`/`Builder` resource
assembly, the `ExecutionRuntime`/`RunStore` durable lifecycle
(`execution*.go`, `durable_ops.go`), `error_info.go`, `input*.go`
input/materializer contracts, the delivery coordinator/store
(`delivery_coordinator.go`), `run_recovery`/`recovery_coordinator`,
`registry`/`tool_policy`/`tool_fence`, `expert`/`knowledge*` orchestration,
`storage_reconcile`, `maintenance_cron`, the MCP lifecycle, and coordinated
shutdown; when it lands, the workflow `AgentHost`'s `AgentManager.create` call
site must move behind `SessionRuntime`.

A later run continued #26 with the front-end-neutral failure, attachment, and
delivery slice that the durable terminal transaction and every adapter
projection depend on. `src/agentruntime/error_info.ts` ports `error_info.go`:
the `FailureClass`/`RunPhase`/`RetryMode`/`SideEffectState` vocabularies,
`ErrorInfo`/`RetryInfo`/`ErrorClassificationOptions`, `classifyError` (provider
cancellation/timeout/context-overflow/content-rejection/retry classification),
`applyErrorDefaults`/`retryModeForSafety`/`retryableErrorCode`, the bounded
`diagnosticMessage` redactor, and `displayErrorMessage`. Go's
`errors.Is(err, context.Canceled)`/`context.DeadlineExceeded` map to
`AbortError`/`TimeoutError` named errors (Deno has no `context`), and the
`net.Error` branch falls back to Go's own message heuristics.
`src/agentruntime/attachment.ts` ports the type slice of `input.go`
(`AttachmentKind` + image/file/audio/video constants, `SessionAttachment`,
`AttachmentPolicy`/`defaultAttachmentPolicy`, `validatePathComponent`,
`sanitizeAttachmentFilename`, `parseAttachmentTimestamp`); the
`AttachmentService` intake/DAO/storage half stays with the `SessionRuntime`
slice because it needs the session database boundary and `SessionRuntime`
ownership. `src/agentruntime/delivery.ts` ports `delivery.go`
(`DeliveryCapability`, `DeliveryIntentPlan`/`OrderedDeliveryOperationPlan`/
`DeliveryPlan`, `deliveryOperationText`, and the deterministic `planDelivery`
caption/upload/send/fallback sequence with SHA-256 stable IDs and payload
digests). `src/agentruntime/delivery_coordinator.ts` ports
`delivery_coordinator.go`: the `DeliveryCoordinator` claim/complete/progress/
`reconcileDue`/`retryExhausted` fence over the existing session delivery store,
`deliveryFailureRetryable`, and the wall-clock `DefaultDeliveryRetryWindowMs`
retry budget. Go's `(DeliveryResult, error)` executor return maps to a
`DeliveryExecutorOutcome` value object so a provider checkpoint survives
alongside an error; `reconcileDue` is async because transports do network I/O.
`run_event.ts` gains the previously deferred `withRunAttemptData` (typed on the
canonical `SessionRun`) and `withTerminalErrorInfo`. New translated/focused
tests: `error_info_test.ts` (4), `delivery_test.ts` (4), and
`delivery_coordinator_test.ts` (6). 14 new tests pass; full suite 1234 passed /
0 failed, architecture 8/8, lint clean (532 files), check clean, fmt clean.
Remaining #26 work is the `SessionRuntime`/`Builder` resource assembly, the
`ExecutionRuntime`/`RunStore` durable lifecycle (`execution*.go`,
`durable_ops.go`), the `AttachmentService`/`input_materializer.go` input
contract, `run_recovery`/`recovery_coordinator`, `registry`/`tool_policy`/
`tool_fence`, `expert`/`knowledge*` orchestration, `storage_reconcile`,
`maintenance_cron`, the MCP lifecycle, and coordinated shutdown; when it lands,
the workflow `AgentHost`'s `AgentManager.create` call site must move behind
`SessionRuntime`.

A later run continued #26 with the Runtime-owned input materializer slice.
`src/agentruntime/input_materializer.ts` ports `input_materializer.go`: the
`InputIngress`/`InputStream` handoff, `PreparedInput`, the canonical
`InputSubmission` contract (and the `RunInput` alias), `InputResource`,
`InputPolicy`/`defaultInputPolicy`, and the `InputMaterializer`
(`Prepare` with project-relative `.mothx/tmp/inputs` staging, HMAC item-key
idempotency, limit enforcement, media-type sniffing plus an image-header
fallback for extensionless WebP, image-dimension/pixel validation,
`Discard`/`Delete`/`Cleanup` lifecycle, `Get`/`getByItemKey`, and the
deterministic `buildManifest`). The `SessionRuntime`-bound methods
(`AcceptInput`/`PrepareInput`/`AttachPreparedInput`/`DiscardInput`/
`CleanupInputResources`/`BuildUserMessage`/`AcceptProviderAttachment`) and the
artifact collector remain for the `SessionRuntime` slice.
`src/agentruntime/knowledge_context.ts` ports the knowledge-capsule vocabulary
(`KnowledgeBaseReference`/`KnowledgeCitation`/`KnowledgeCapsule` and the bounded
`formatKnowledgeCapsules`); `PrepareKnowledgeContext` waits on the
knowledge-base service. Deviations: `context.Context` maps to an optional
`AbortSignal`, `[]byte` to `Uint8Array`, `time.Time` to `Date`, and SHA-256/HMAC
to `node:crypto`. `input_materializer_test.ts` translates 7 focused cases
(project resource/manifest, image canonicalization, extensionless WebP,
concurrent dedup, stable HMAC reference fallback, lifecycle events/draft
cleanup, oversized/invalid rejection). Full suite 1298 passed / 0 failed,
architecture 8/8, lint/check/fmt clean. Remaining #26 work is the
`SessionRuntime`/`Builder` resource assembly, the `ExecutionRuntime`/`RunStore`
durable lifecycle (`execution*.go`, `durable_ops.go`), the artifact collector
and `AcceptProviderAttachment`, `run_recovery`/`recovery_coordinator`,
`registry`/`tool_fence`, `expert`/`knowledge*` orchestration, the MCP
lifecycle, and coordinated shutdown.

A later run continued #26 with the Runtime-owned persistence and orphan-recovery
slice that the `ExecutionRuntime` and every adapter's startup path depend on.
`src/agentruntime/run_store.ts` ports `run_store.go`: the `DurableRun` row and
the `DurableRunStore`/`DurableRunMetadataStore`/`DurableRunUsageStore`/
`DurableIntentStore`/`DurableIntentEventStore`/`DurableConversationTurnStore`/
`DurableConversationTurnFinisher`/`DurableConversationTurnEventFinisher`/
`DurableTerminalPersistenceStore`/`DurableRunEventStore` interfaces, and the
`RunStore` (`leaseLost`, `executionBinding`, `retainExecutionLease`,
`prepareExistingExecution`, `create`/`update`/`finish`/`markTerminalizing`,
`updateErrorInfo`/`updateProgress`/`updateUsage`, the atomic
`createIntentAndRun{,WithEvent,WithEventAndTurn}` and
`createRunWithEvent{,AndTurn}` admissions, `finishConversationTurn`/
`finishRunAndConversationTurn`, `getIntent`, and the exported
`sessionRunEventFromRuntime`/`durableRunStatus` projections). `json.RawMessage`
maps to decoded `unknown`, `time.Time` maps to `Date`, and Go's multiple
`(binding, ok, error)` return maps to a value object plus typed throws.
`src/agentruntime/run_recovery.ts` ports `run_recovery.go`:
`RecoveryAction`/`RecoveryFailLocal`/`RecoveryKeepRemote`,
`RunRecoveryPolicy`, `RunRecoveryResult`, `DefaultRunRecoveryPolicy`,
`RecoverOrphanedRuns`/`RecoverOrphanedSessionRun`/`StopOrphanedSessionRun{,Context,
ContextForRun}`, the fenced `recoverOrphanedRun` (dual facts re-read, exact
purpose=recovery binding validation, policy/`beforeFail`, decision-resolution
events, terminal convergence, retryable-failure persistence), and
`defaultRunRecoveryAction` (verified remote `responses_background` retention
only). Go's goroutine worker pool maps to a bounded asynchronous pool
(`recoveryWorkerLimit`) so a slow adapter callback cannot block other Sessions,
and `context.Context` maps to an optional `AbortSignal`
(`AbortSignal.timeout` `TimeoutError` for attempt deadlines).
`src/agentruntime/recovery_coordinator.ts` ports `recovery_coordinator.go`:
the `RecoveryCoordinator` (mandatory synchronous startup scan, tick-or-wake
loop, `scanNow`/`wake`/idempotent `start`/coordinated `stop`, per-database
process registry, `wakeRecoveryCoordinators`). New translated/focused tests:
`run_recovery_test.ts` (9 cases: local/remote split, bounded parallel scan with
preserved scan order, slow-attempt non-blocking with attempt-deadline, admission
recovery, live-lease skip, default policy, verified-remote retention, durable
retryable failure) and `recovery_coordinator_test.ts` (startup scan + wake
re-convergence + idempotent start/stop). `run_recovery.ts` uses a
`RunRecovery`-owned `failRunRecoveryAttempt`; the `InspectSessionExecution`
assertions and raw-SQL lease fixtures are deferred to the execution-snapshot
slice. Full suite 1308 passed / 0 failed (98 in `src/agentruntime`),
architecture 8/8, lint/check clean. Remaining #26 work is the `SessionRuntime`/`Builder` resource assembly,
the `ExecutionRuntime` durable lifecycle (`execution*.go`, `durable_ops.go`),
the artifact collector and `AcceptProviderAttachment`, `registry`/`tool_fence`,
`expert`/`knowledge*` orchestration, the MCP lifecycle, and coordinated
shutdown.

A later run continued #26 by porting the `ExecutionRuntime` durable lifecycle
and the session execution-snapshot/stop matrix that every adapter's run
projection and stop path depend on. `src/agentruntime/execution.ts` merges
`execution.go`+`execution_events.go`+`execution_persistence.go`+
`execution_observation.go`+`execution_snapshot.go` into one class (Go splits
the methods across files; TypeScript requires one class body): the `RunState`
lifecycle (`begin`/`beginWithEvent`/`waitForApproval`/`waitForQuestion`/
`resume`/`cancel`/`wait`/`finish`/`finishWithState`/`finishWithEvent`/
`shutdown`/`shutdownContext`), the durable transitions
(`beginDurable`/`beginIntentDurable`/`beginRetryDurable`/`reattachDurable`/
`reattachDurableRun`/`updateDurable`/`recordUsage`/`cancelDurable`/
`finishDurable`/`finishDurableWithRetry`/`finishDurableLocked` with the
lease-preserving terminal-retry loop), the Agent-event observation contract
(`recordFailure`/`recordErrorInfo`/`observeAgentEvent`, retry-progress
persistence, error-fact tracking, `AgentEventObservation`), the local
execution registry plus `inspectSessionExecution`/`SessionExecutionState`/
`SessionExecutionSnapshot`/`SessionRunSummary`, and the exported
`enrichErrorInfo`/`terminalErrorInfoFor`/`isRemoteResponseTerminal`/
`registeredLocalExecution` helpers. `src/agentruntime/durable_ops.ts` ports
`durable_ops.go` (`createDurableRun`/`updateDurableRun`/`finishDurableRun`/
`recoverDurableRun`); `src/agentruntime/execution_admission.ts` ports
`execution_admission.go` (`acquireExecutionAdmission`/`acquireSessionMutation`
with lease-first orphan reconciliation); `src/agentruntime/execution_stop.ts`
ports `execution_stop.go` (the `SessionStopCode` vocabulary and the canonical
`requestSessionStop` matrix over local/remote/orphan/reserved states). Go's
`sync.Mutex`/`TryLock` is dropped because Deno's single-threaded event loop runs
the synchronous store/DAO methods without interleaving, `chan struct{}` maps to
a small `Done` handle, `context.Context` maps to `AbortSignal`, and errors
throw. `error_info.ts` now exports `applyErrorDefaults`/`retryModeForSafety`
and `run_recovery.ts` exports `defaultRunRecoveryAction` for reuse. New
translated tests: `execution_test.ts` (17 cases: exclusive begin/finish, cancel
semantics, wait/resume, explicit terminal states, event begin/finish, durable
lifecycle/atomic admission/intent retry chain, create-failure compensation,
retry+terminal observation with credential redaction, shutdown terminal
persistence/idempotence, bound-loop shutdown). Full suite 1325 passed / 0 failed
(115 in `src/agentruntime`), architecture 8/8, lint/fmt/check clean. Remaining
#26 work is the `SessionRuntime`/`Builder` resource assembly, the artifact
collector and `AcceptProviderAttachment`, `registry`/`tool_fence`,
`expert`/`knowledge*` orchestration, the MCP lifecycle, and coordinated
shutdown.

A later run continued #26 with the Runtime-owned knowledge-base orchestration
slice (the Desktop knowledge-base feature boundary in AGENTS.md).
`src/agentruntime/knowledgebase.ts` ports `knowledgebase.go` plus every
`KnowledgeBaseService` method from `knowledge_index_job.go` /
`knowledge_indexer.go` / `knowledge_librarian.go` (TypeScript requires one
class body per module): `KnowledgeBaseIndexPolicy`/`DefaultKnowledgeBaseIndex
Policy`, the provider-factory contract and its `provider/factory` default, the
constructors `newKnowledgeBaseService`/`...WithSettings`/`...WithProvider
Factory`, `setSettings`/`currentSettings`, the durable `index`/`indexDurable`/
`indexDurableWithProgress` lifecycle (admission lease, canonical durable Run
begin/finish via `ExecutionRuntime`+`RunStore`+`SessionRunEventSink`, manifest
reuse, incremental graph reuse, snapshot commit), the deterministic
`indexWithRun`, the `filepath.WalkDir`-equivalent `scanFileManifest`/`build
Graph`/`indexFile`/`readIndexableKnowledgeFile`, `query`, the background
`startIndex`/`indexJob`/`indexProgress`, `resolveKnowledgeIndexer`, the
`prepareKnowledgeContext` graph-capsule resolver with `makeKnowledgeCapsule`,
and the knowledge-base helpers (ignored-directory/allowed-file/media-type/
title/SHA-256/chunk/marker/label). `src/agentruntime/knowledge_index_job.ts`
ports `knowledge_index_job.go` (`KnowledgeIndexProgress`/phases, the
`KnowledgeIndexJob` progress/wait/finish lifecycle); `knowledge_indexer.ts`
ports the deterministic `knowledge_indexer.go` helpers (bounded prompt, strict
response parser, evidence-verified co-mention projection);
`knowledge_librarian.ts` ports the deterministic `knowledge_librarian.go` half
(the dedicated-session identity/open helper, role instructions, prompt, bounded
capsule); `knowledge_cron.ts` ports `knowledge_cron.go`
(`KnowledgeBaseCronJobPrefix`, the ID pair, and `RunKnowledgeBaseCronJob`);
`knowledge_context.ts` gains the byte-bounded `truncateKnowledgeText`.
Deviations: `context.Context` maps to an optional `AbortSignal`; `[]byte` maps
to `Uint8Array`; `time.Time` maps to `Date`; SHA-256 uses `node:crypto`;
`filepath.WalkDir` maps to a sorted recursive `Deno.readDirSync` walk;
`mime.TypeByExtension` maps to a fixed extension table; `mime`/`os`/`filepath`
follow the established Deno mappings. Named migration bridge (owner #26,
removed when the `SessionRuntime` slice lands): the model Indexer/Librarian
enrichment paths (`enrichGraphWithIndexer`, `LibrarianCapsule`/`runLibrarian`,
`WithKnowledgeContext`/`prepareKnowledgeContextWithLibrarian`) need a bound
`SessionRuntime` to construct and run an Agent, so `enrichGraphWithIndexer`
throws when a configured indexer binding is present instead of silently
skipping the model step; no production caller wires a provider factory yet, so
the deterministic scan/index path is the only reachable path today. New
translated tests: `knowledgebase_test.ts` (7 deterministic scan/graph/query/
Chinese-evidence/capsule/settings cases), `knowledge_index_job_test.ts` (2), and
`knowledge_cron_test.ts` (3). 13 new tests pass; full suite 1338 passed / 0
failed, architecture 8/8, lint/fmt/check clean. Remaining #26 work is the
`SessionRuntime`/`Builder` resource assembly, the artifact collector and
`AcceptProviderAttachment`, `registry`/`tool_fence`, the `expert` orchestration,
the MCP lifecycle, and coordinated shutdown; the deferred knowledge enrichment
paths land with the `SessionRuntime` slice.

A later run continued #26 with the standard Knowledge MCP adapter and the
front-end-neutral persisted session lifecycle. `src/agentruntime/
knowledge_mcp.ts` ports `knowledge_mcp.go`: the `KnowledgeMCPHandler`
(implementing the ported stdio `ServerHandler`), `newKnowledgeMCPHandler`
(via the `KnowledgeMCPHandler.create` static factory), `listTools`/`callTool`,
and the bounded, cited, snapshot-backed `search_knowledge_base` result (byte-
bounded excerpt/result budgets over `truncateKnowledgeText`, the
`knowledgeBaseId`/`query`/`limit` allowlist validation, and the explicit
`knowledgeBaseId` authorization check). Deviations: Go's `context.Context` maps
to the `AbortSignal` the stdio server threads through `ServerHandler`; the Go
`json.Decoder` + `DisallowUnknownFields` strict decode is reproduced over the
already-decoded argument object; `len(string)` (Go bytes) maps to a UTF-8 byte
count. `src/agentruntime/session_lifecycle.ts` ports `session_lifecycle.go`:
`CreateSession` (`createSession`, local vs bound channel), `OpenSession`
(`openSession`, exact ID), `DeleteSession` (`deleteSession`, now async because
`AcquireSessionMutation`/`acquireSessionMutation` is async and lease-first),
`DeleteSessionWithMutation` (`deleteSessionWithMutation`), and
`OpenSessionForWorkDir` (`openSessionForWorkDir`); Go's `defer guard.Release()`
maps to `try/finally`. New translated/focused tests: `knowledge_mcp_test.ts`
(2: the bounded cited-evidence handler case and the standard-stdio-tool case
driven in-process through `serveStdio` with in-memory streams instead of the Go
subprocess helper) and `session_lifecycle_test.ts` (7: local/bound creation,
exact-ID and workdir-scoped open, lease-guarded and caller-guard deletion, and
the required-argument errors). 9 new tests pass; full suite 1347 passed / 0
failed (was 1338/0), architecture 8/8, lint/fmt/check clean. Remaining #26 work
is the `SessionRuntime`/`Builder` resource assembly (`session_runtime.go`,
`agent_build.go`, `agent_manager.go`), the artifact collector and
`AcceptProviderAttachment` (`artifact.go`/`attach.go`), `registry`/
`tool_fence`, the `expert` orchestration, the remaining MCP lifecycle
(`ConnectMCP`/`ConnectConfiguredMCP`/`CloseMCPClients`), and coordinated
shutdown.

A later run completed backlog #25 (`internal/cron`) by porting the shared
`Scheduler` and the scheduler-bound half of the maintenance projection.
`src/cron/scheduler.ts` ports `scheduler.go`: the `Scheduler` (store/manager/
job-handler/maintenance policy/interval/session-dir fields, the in-memory
claim set, the tick-or-immediate `loop`, `checkAndRun` over `isDue`/
`isStaleRunning`, `claimJob` over an atomic `DueJobClaimer` or the single-
scheduler fallback, `executeJob`/`executeJobContext` with the Runtime-owned
maintenance dispatch, the optional adapter `JobHandler`, the A2A target path,
and the local-agent path that acquires the shared execution admission, resolves
the cron source policy, opens the bound session, begins a canonical durable
`ExecutionRuntime` run (`"cron_" + generateID()`, started/finished events with
cron-job metadata), runs the sub-agent, and finishes the run), `completeJob`
(next-run/one-shot projection), `updateJob`, `RunNow` (the explicit manual
override that reuses the claim path and surfaces `ErrJobAlreadyRunning`), and
`executeA2AJob`). It also ports the scheduler half of `maintenance.go`
(`SetMaintenancePolicy`/`maintenancePolicy`, the `ensureMaintenanceJob`
projection over the shared store, and `normalizeMaintenanceSchedule` with the
Runtime-default fallback). Deviations: `time.Time` maps to `Date` (`null` for
the zero time), `context.Context` maps to an `AbortSignal`, goroutines map to
tracked `Promise`s awaited by `stop()`, the scheduler-detached run context uses
`AbortSignal.timeout(runningLeaseTimeoutMs)` instead of `context.WithoutCancel`,
Go's `(value, error)` returns throw typed errors, and `ErrJobAlreadyRunning` is
a typed `Error` subclass. New translated tests: `scheduler_test.ts` (25 cases:
lifecycle start/stop/concurrent/default-interval, the completion observer, the
`isDue` table, `updateJob` field preservation, the manager-less one-shot
finalization, the disabled/running skip, the adapter handler lifecycle, the
`NormalizeJobSchedule` table, and the `RunNow` success/error paths) plus the
maintenance projection and end-to-end cases (single projection across two
schedulers on one store, the settings switch removing the projection, the
cadence override preserving run history, the invalid-cadence fallback, the
Runtime-not-agent reconciliation that reclaims an aged artifact directory, and
the unknown-maintenance-job refusal). The two full-agent integration cases
(`TestSchedulerLocalJobWaitsForSessionRuntimeLock`,
`TestSchedulerBoundChannelJobUsesForcedRuntimePolicy`) remain deferred to the
`SessionRuntime` slice because they build a real provider/AgentFactory. Full
suite 1372 passed / 0 failed (was 1347/0), architecture 8/8, lint/check/fmt
clean. Remaining backlog is #19's `examples/` and loop cases, #22 `browser`,
#26's `SessionRuntime`/`Builder` remainder, and #35–#38 (`acp`, `serve`, `tui`,
`cmd/mothx`).

A later run continued #26 with the Runtime-owned Agent-construction boundary
that every adapter's `BuildAgent`/`NewAgentManager` path depends on.
`src/agentruntime/session_source.ts` ports the Manager-bound source resolvers
from `session_runtime.go` (`resolveManagerSource`/`resolveManagerPolicy`, over
the session header/persisted binding, with Go's `(resolution, mode, error)`
return mapped to a `SessionPolicyResolution` value object). `source.ts` now
exports `validateSourceCandidates` so the Manager-bound resolver validates the
same candidates as the adapter-neutral one. `src/agentruntime/tool_fence.ts`
ports `tool_fence.go`: `beforeToolExecuteForRuntime` (the Runtime ownership fence
installed for every built Agent, including managed children, that blocks a
side-effecting tool whose fenced execution lease no longer proves ownership,
allowing an expired-but-still-owned lease and blocking a fenced epoch takeover)
and `blockToolExecutionFence`; Go's `*SessionRuntime` receiver maps to a narrow
`ToolFenceRuntime` view, and `context.Context.Err()` maps to the `AbortSignal`
on the `ToolContext`. `src/agentruntime/agent_manager.ts` ports
`agent_manager.go`: `newAgentManager` (the one shared `AgentFactory`/
`AgentManager` construction path, with the session-manager-authoritative
settings copy, team-forced multi-agent capability, the source-fenced
`beforeToolCall`/`beforeToolExecute`/`resolveMode`/`beforeToolCallForSession`
hooks, and the session-mailbox `setMemberContext`/`setMemberWaitEnabled`
wiring) plus `AgentManagerOptions`/`AgentManagerRuntime`/
`AgentManagerExpertBinding`; the Go `*SessionRuntime` receiver maps to the
narrow `AgentManagerRuntime` view so the constructor lands before the
`SessionRuntime` slice with no import cycle. `mod.ts` re-exports the three
modules. New translated/focused tests: `tool_fence_test.ts` (2: the fenced
ownership follow case translated from `tool_fence_test.go` against a real
session database, plus the unbound/non-side-effecting allow case),
`session_source_test.ts` (5: persisted-binding precedence, no-manager fallback,
conflicting-current `SourceConflictError`, forced channel mode, default mode),
and `agent_manager_test.ts` (1: the shared-dependency guards from
`agent_manager_test.go`). The remaining #26 `SessionRuntime`/`Builder` resource
assembly, `ExecutionRuntime`-bound `resolvedExecutionPolicy`/`expertState`
methods, artifact collector/`AcceptProviderAttachment`, MCP lifecycle, expert
orchestration, and coordinated shutdown still land in the `SessionRuntime`
slice; `agent_manager.go`'s `TestAgentManagerAppliesBoundSessionPolicyWithoutParent`
integration case remains deferred until a real `SessionRuntime` exists. Full
suite 1380 passed / 0 failed (was 1372/0), architecture 8/8, lint/check/fmt
clean.

A later run completed the remaining #26 knowledge-enrichment item now that the
`SessionRuntime` resource assembly is ported. `knowledgebase.ts` gains the
model-backed paths of `knowledge_indexer.go` and `knowledge_librarian.go`:
`enrichGraphWithIndexer` (builds a read-only transient Agent through
`attachSessionResources`, runs the bounded `indexerPrompt`, observes canonical
execution events without staging the model's raw JSON as a transcript entry,
then persists only the evidence-verified `co_mentions` edges) and
`librarianCapsule`/`runLibrarian` (opens the dedicated Librarian session,
acquires the fenced execution admission, begins a canonical durable Run, builds
the Librarian Agent with `auxiliaryRole`, and returns the bounded capsule), plus
the free `prepareKnowledgeContextWithLibrarian`/`withKnowledgeContext` input
entry points. `runIndexBody` is now async and threads the index manager through
to the enrichment step, so a configured provider factory reaches both roles. The
migration bridge that threw when a configured indexer binding was present is
gone. New translated tests: the verified-co-mention indexer case and the
dedicated-Librarian durable-Run case from `knowledgebase_test.go` (using a
deterministic indexer provider and a mock librarian provider); 2 new tests pass
(161 in `src/agentruntime`). The same run fixed a `src/session/input_resources.ts`
fidelity bug: lifecycle-event timestamps were truncated to millisecond precision,
so Go's `ORDER BY timestamp ASC, id ASC` could reorder two events created in the
same millisecond; `appendInputResourceEventTx` now emits an RFC3339Nano-shaped
timestamp with a monotonic sub-millisecond fraction. A verification pass over the
consolidated `src/agentruntime/execution.ts` against the split Go
`execution*_test.go` files found the durable/lifecycle/event/observation cases
covered (all of `execution_test.go` except
`ShutdownReleasesLifecycleLockOnConcurrentTerminalization`, plus
`execution_events_test.go`, `execution_observation_test.go`, and every
`execution_persistence_test.go` case). Gaps remaining for a later run: the
translated `execution_snapshot_test.go` cases (`inspectSessionExecution`
local/external/orphaned/reserved/detached and reattach-recovery promotion) and
`execution_admission_test.go` (orphan recovery, live-owner non-displacement,
verified-remote retention), both needing raw lease fixtures. The
`workflow/agent_host.ts` `AgentManager.create` call site is already 1:1 with Go
(`agent_host.go` uses `h.Manager.Create` on the manager it is given), so it
already follows the sanctioned `NewAgentManager` construction path and needs no
change. Full suite 1406 passed / 0 failed, architecture 8/8, lint/fmt/check
clean. Remaining backlog is #19's `examples/` and loop cases, #22 `browser`, and
#35–#38 (`acp`, `serve`, `tui`, `cmd/mothx`). Note for #19 `examples/`: a
functional example must blank-import
the builder-registration entry (`src/bootstrap/`), but the architecture guard
(`public_sdk_boundary_test.ts`) scans `examples/` and rejects any `src/` import,
so a public bootstrap entry (or a guard exemption) must be decided before the
examples can land without weakening the boundary.

## Known hard parts (require design decisions)

A later run completed backlog #32 (`internal/doctor`): `src/doctor/doctor.ts`
was already present in full (all Go checks translated), so this run added
`src/doctor/mod.ts` and `src/doctor/doctor_test.go`'s four translated cases
(`RunReportsMissingProviderKeyWithoutLeakingConfiguredValue`,
`RunUsesProjectSettingsForRequestedCWD`,
`ValidateProviderReportsMissingModelWhenNoModelCanBeSelected`,
`RunNeverSerializesAPIKey`) using a `MOTHX_DIR` env helper, and flipped the
ledger row to ported. The doctor package depends only on the already-ported
`src/config`, `src/mcp`, `src/platform`, `src/provider/factory`, `src/skills`,
`src/version`, and the `src/serve/config.ts` path helper, so it is independent
of the pending #19/#26 runtime work.

- **`provider` core vs subproviders.** `src/provider` ports the protocol-neutral
  core: `types`, `base`, `provider`, `registry`, `vendor` (+ all 43 `vendor_*.ts`
  adapters registered in Go `init()` byte order via `vendors.ts`), `retry`,
  `discover`, `http_client`, `idle_timeout`, `attachments`, `context_overflow`,
  `content_rejection`, `hosted_tools`, `image_coordinates`, `debug`, `mock`, and
  `toolcall_id`, with the Go tests translated to `Deno.test`. The protocol
  subproviders are ported 1:1 next to the core:
  - `src/provider/anthropic/` (`provider.ts`, `register.ts`, `mod.ts`) — the
    Anthropic Messages API, ported with its Go tests (32 passing): streaming
    retry with visible-output guarding, cache_control, tool_choice/parallel
    tool use, thinking formats (anthropic/adaptive/deepseek/xiaomi), sampling
    suppression, tool-result grouping, and usage/cache accounting.
  - `src/provider/google/` (`provider.ts`, `register.ts`, `mod.ts`) — the
    Gemini and Vertex generative APIs, ported with its Go tests (19 passing):
    streaming text/think/tool-call/usage, media resolution, cached content,
    Vertex API-key vs OAuth endpoints/headers, and function-call ID handling.
  - `src/provider/openai/` (`provider.ts` chat completions, `responses.ts`,
    `responses_codec.ts`, `responses_config.ts`, `think_split.ts`,
    `attachments.ts`, `hosted_registry.ts`, `register.ts`, `mod.ts`) — the
    OpenAI Chat Completions and Responses APIs, ported with their Go tests.
    Chat: streaming retry with visible-output guarding, `max_tokens` →
    `max_completion_tokens` fallback, thinking formats
    (openai/deepseek/kimi/doubao-seed/qwen/xiaomi) with sampling suppression,
    Kimi tool-result normalization, consecutive tool-image grouping, image
    detail/history limits, cache/usage accounting. Responses: request building
    (state modes, prompt cache, structured output, tool control, hosted tools,
    native replay items, custom tools), the SSE codec/normalizer (canonical
    redacted archive, hosted item lifecycle, attachment extraction), capability
    resolution/validation, and remote-MCP URL egress checks. 39 chat/convert/
    thinking/retry/cache tests, 21 codec/think-split/attachment tests, and 26
    Responses API/stream tests pass (86 total).
  - `src/provider/factory/` (`factory.ts`, `mod.ts`) — provider/model creation
    from settings for the anthropic/openai/google protocols, model conversion,
    and qualified-model parsing/sorting; 9 translated tests pass.
  - `src/provider/openai/responses_runtime.ts` (`ResponsesRunManager`) — the
    durable background Responses run manager, ported with its Go tests (3
    passing): `start`/`continue`/`get`/`cancel`/`recover` over the Runtime-owned
    `src/session/response_store.ts` persistence, the retry/idempotency
    `doJSON` loop (configured `RetryConfig` bounds, stable `Idempotency-Key`
    that overrides a configured header, exponential `retryDelay`), the
    abort-aware `waitForBackgroundRetry`, `applyResponsesRemoteState`, the
    hosted-tool policy-exceeded check, and the terminal-response archiver that
    stores a sanitized turn summary (usage + attachments) plus per-item
    canonical archives. `Provider.newResponsesRunManager(sessionDir)` mirrors
    the Go method. This completes backlog #14.
  Deliberate deviations: `json.RawMessage` maps to `unknown` (decoded JSON) with
  invalid bytes carried in `InvalidArguments`; `context.Context` maps to
  `params.abort`/`AbortSignal`; `Provider.Chat` returns `AsyncIterable`;
  `net/http.Client` maps to a small `HttpClient` wrapper over `fetch` +
  `Deno.createHttpClient` (proxy/HTTP-version options, timeout via
  `AbortSignal.timeout`); the idle-timeout wrapper operates on
  `ReadableStream` and raises `StreamTimeoutError`; `time.Time` maps to `Date`.
  Wire structs keep the Go JSON tag keys as TS property names (camelCase when
  the Go tags are camelCase, e.g. Google; snake_case when they are snake_case,
  e.g. Anthropic), so serialization is a direct `JSON.stringify`.
- **`context` (token accounting + compaction).** Ported 1:1, including the
  embedded DeepSeek V3 byte-level BPE tokenizer (`deepseek_tokenizer.ts`), whose
  counts match the Go expectations exactly (CJK, added tokens, tool calls). The
  tokenizer JSON is read at first use via `new URL("./tokenizerdata/...",
  import.meta.url)` and `Deno.readTextFileSync`, so the same path works in dev
  and in the `deno compile --include src/context/tokenizerdata` binary.
  Deliberate deviations: `json.RawMessage` tool-call arguments map to decoded
  `unknown` and are re-serialized for size/prompt accounting
  (`invalidArguments` is preferred when present); `context.Context` maps to an
  optional `AbortSignal`; Go's goroutine fan-out over oversized tool results
  maps to a bounded async worker pool (`maxParallelToolCompactions`). 50
  translated `Deno.test` cases pass.

- **`bun` ORM → DAO.** Go DAOs use `bun.IDB`, `bun.NewSelect/NewInsert`,
  `bun.BaseModel`, and `bun.In`. There is no TS equivalent; `src/dao` was
  rewritten to build SQL strings over `src/db`'s `DB` handle. Every DAO
  (`attachments`, `bindings`, `conversation_turn`, `cron`, `delivery`, `esm`,
  `esm_guidance`, `fork`, `input_resources`, `knowledge_bases`, `projects`,
  `recovery`, `response`, `run`, `runtime_lease`, `runtime_submission`,
  `session`, `stats`) and the `Database`/`Tx`/`Executor` wrapper are ported; a
  shared `ErrNoRows` sentinel replaces `sql.ErrNoRows` and `bun.In` maps to an
  `inList` helper. `src/dao/knowledge_bases.ts` also owns the FTS mirror
  rewrite (`KnowledgeFTSIndexText`) and query builder. 10 translated tests
  pass (cron CRUD/claim, attachment references/listing, channel-tool
  generations, runtime-lease fencing, run/project projections, and the
  knowledge-FTS bigram round trip). One required `src/db` fidelity fix:
  `node:sqlite` enables foreign-key enforcement by default, so
  `applyPragmas` now explicitly sets `PRAGMA foreign_keys(0)` unless the
  caller opts in, restoring the Go canonical-session-database policy.
- **`session` schema/migrations foundation.** To make the DAO tests runnable
  before the rest of package #16 exists, `src/session/schema.ts` (current
  schema + `ensureCurrentSchema`), `src/session/migrations.ts` (all 43
  migrations + the per-knowledge-base store schema and
  `ensureKnowledgeBaseSchema`), `src/session/run_status.ts` (the canonical
  Run status sets), `src/session/entry.ts` (the session entry types and
  `generateID`), and `src/session/lock_registry.ts` + `src/session/identity_lock.ts`
  (the process-local per-key/identity mutex registry with ref-counted
  eviction) are ported over `src/db`. On top of those, this run added
  `src/session/root_db.ts` (the `rootDBPath`/`openRootDB`/
  `openExistingSessionDB`/`openStandaloneDB`/`closeDatabases` helpers and
  `parseSessionTimestamp` split out of the not-yet-ported Manager),
  `src/session/database.ts` (`openBunDatabase`, `rootDatabasePath`,
  `queryRootDatabase`/`writeRootDatabase`, and the recovery/index-repair
  projections, now merging peer-rebuild notices),
  `src/session/artifacts.ts` (attachment replay projections),
  `src/session/decision_events.ts` (the durable decision-ledger vocabulary),
  `src/session/projects.ts` (projects + session metadata, including the
  explicit ON DELETE SET NULL detach), `src/session/runtime_lease_status.ts`
  (the read-only active-lease maintenance preflight), `src/session/input_resources.ts`
  (resource lifecycle events + `bindInputResourcesToRunTx`),
  `src/session/bindings.ts` (channel bindings and channel-tool selections;
  the `Manager`-returning rotate/create helpers and `Manager.SetSessionBinding`
  remain with `session.go`), and `src/session/runtime_submission.ts`
  (durable admission identities and the typed reserve/conflict result). A later
  run added the advisory-bus and database-maintenance slice:
  `src/session/runtime_identity.ts` (the per-process runtime owner identity),
  `src/session/runtime_lease_bus.ts` (the host-only UDP wake-up bus over
  `node:dgram`; Go's `x/sys` SO_REUSEADDR/SO_BROADCAST options map to the
  `reuseAddr`/`setBroadcast` socket options, and cross-process broadcast is
  covered by a subprocess helper), `src/session/database_reset.ts` (the
  recoverable sessions.db reset with sidecar archiving, rollback, and the
  left-behind report; `DatabaseMoveError` carries the restored files so the
  rollback contract stays testable), and
  `src/session/database_recovery_notice.ts` (the peer-rebuild hook wired into
  `ensureCurrentSchema`, retiring a replaced cached connection and merging peer
  notices into `takeDatabaseRecoveries`). A later run added the Session runtime
  lease subsystem: `src/session/runtime_lock.ts` (fenced owner/epoch/token
  `session_runtime_leases` acquire/release/bind/validate, admission/mutation/
  fork/recovery acquisition modes, the one-per-directory batched heartbeat
  scheduler over `setInterval`, and the `RuntimeLeaseGuard`/`RuntimeLeaseGroup`
  handles). Go's `context.Context` is dropped (the DAO layer is synchronous),
  `<-chan struct{}` loss signals map to `AbortSignal`, and the process-local
  non-blocking mutex maps to a new `CountedMutex.tryLock`. 12 translated tests
  cover acquisition, fencing tombstones, admission modes, epoch-bump reclaim,
  batch renew/displace/retire, and transient-renewal availability (renewal
  failures never lose a live lease; renewal resumes after recovery). A later
  run also ported `src/session/esm_guidance.ts` (Runtime-owned ESM guidance
  rows fenced by the lease inside their transaction), with its translated
  lifecycle test. A later run ported the transcript-replay core and the
  boundary/store surfaces: `src/session/replay.ts`
  (`buildReplayState`/`messageContentOverrides`/`applyCompactionEntry` and the
  sequenced variant, `cloneMessage`/`cloneContentBlock`,
  `latestCompactionLocked`/`lastSummarizedEntryIDLocked`, `getEntryMetadata`),
  `src/session/conversation_turn.ts` (durable turn/start/turn/end boundaries
  and `startConversationTurnTx`/`endConversationTurn`/`listConversationTurns`),
  and `src/session/store.ts` (the `Store` interface + `MemoryStore`), plus
  `src/session/session_events.ts` (persisted capabilities, the run/capability
  event ledgers, and the cursor-paged sequenced message replay over the session
  DAO). 27 new translated tests cover replay overrides/compaction/cloning, turn
  admission/idempotence/reopen/not-open, the in-memory store contract, and the
  capability/event/sequenced projections. A later run ported the durable
  Run/delivery persistence slice: `src/session/run_store.ts` (the `SessionRun`
  record; save/create/insert-with-event/turn-bound variants; the terminal
  `finishSessionRunAndConversationTurn` that closes the Run, turn, assistant
  entry, terminal event, and delivery plan in one transaction;
  get/active/list/latest/orphaned reads; attempt selection; fenced status and
  error/progress/usage updates; `allowedRunPredecessors`),
  `src/session/run_user_message.ts` (deterministic user/assistant/terminal IDs,
  the assistant-message fingerprint via `node:crypto` SHA-256, and the
  idempotent user/assistant entry admission helpers), and
  `src/session/delivery_store.ts` (the run-level delivery outbox:
  `DeliveryIntent`/`DeliveryOperation`/`DeliveryPlan`,
  create/get/claim/update/progress/requeue/reopen operations, transient-failure
  scans, failure listing, and the intent aggregate refresh). `normalizedRunJSON`
  moved to a shared `src/session/run_json.ts`; `markRuntimeLeaseBound` is now
  exported from `src/session/runtime_lock.ts`. 17 new translated tests cover
  Run admission/idempotence/rollback, terminal turn handling, the single-pool
  list path, error annotation, and delivery claim fencing, dependency
  propagation, transient reopen/recovery, and permanent-failure refusal. A later
  run ported the recovery/intent slice: `src/session/run_recovery.ts`
  (`SessionRunRecovery`/`SessionRunRecoveryState`; the fenced
  `beginSessionRunRecovery`/`markSessionRunRecovery{Failed,Detached,Complete}`
  dispositions; the atomic `convergeSessionRunRecovery` that records pending
  Decision resolutions, closes every open ConversationTurn, writes the terminal
  Run row/event, and completes the recovery record under one purpose=recovery
  lease revalidation; `getSessionRunRecovery`), and
  `src/session/execution_intent.ts` (`ExecutionIntent`; `saveExecutionIntent`;
  the atomic `createExecutionIntentAndSessionRun{,Event,EventWithTurn}` that
  admits the immutable intent, Run row, started event, conversation turn,
  input-resource bindings, submission reservation, and lease bind in one
  transaction; `getExecutionIntent`). `normalizeTurnStatus` is now exported from
  `conversation_turn.ts` and `sessionRunRecord` from `run_store.ts`. The
  `context.Context`-carrying *Context variants are dropped (the DAO layer is
  synchronous). 2 translated recovery tests plus 3 focused intent tests pass. A
  later run ported `src/session/fork.ts` (`forkSession`: the idempotent,
  lease-fenced two-phase session fork that resolves a session/message boundary,
  remaps entry/turn identities, copies capabilities/project metadata, and
  allocates the child title; `ForkOptions`/`ForkResult`/`ForkKind` and the
  exported `Fork*` sentinel error classes) with `src/session/session_errors.ts`
  (`SessionModifiedError`). 6 translated fork tests cover session/message
  boundaries, idempotent retry, open-turn/pending-decision rejection, the
  legacy completed-run boundary, and the atomic execution-admission fixture. A
  later run ported `src/session/response_store.ts` (the durable Responses
  runtime store: `ResponseTurn`/`ResponseItemArchive` summaries and sanitized
  native-item archives, `ToolExecutionRecord` cross-protocol idempotency with
  atomic claim/publish/reclaim/confirm-recovery/abandon, `ResponseRun`
  background-run state, and the compare-and-swap `ResponseSessionState` remote
  lineage; `archiveJSON`/`redactArchiveValue` preserve numeric usage counters
  while redacting credential-bearing keys and enforce the 128 KiB archive
  bound). Every write revalidates the fenced runtime lease, and the DAO's
  `nullzero` primary keys are reproduced by inserting `NULL` when the id is
  unset. 4 translated tests cover sanitized turn/item storage and upsert,
  replay-item ordering, historical function-call dedup by provider call
  identity, numeric-usage redaction, and the CAS lineage. A later run ported
  `src/session/execution_facts.ts` (`RuntimeLeasePurpose`,
  `RuntimeLeaseSnapshot`, `SessionExecutionFacts`, and
  `readSessionExecutionFacts`, the single-transaction durable Run/lease/
  recovery/remote-run snapshot over the session DAO clock), exporting
  `readSessionRunRecoveryTx`, `sessionRunFromRecord`, and
  `responseRunFromRecord` for reuse, with 4 translated tests covering the
  canonical run+lease facts, the released tombstone, a missing session, and the
  canonical non-terminal status set. A later run ported the knowledge-base
  orchestration slice: `src/session/knowledge_database.ts`
  (`knowledgeBaseDatabasePath`/`normalizeKnowledgeBaseDatabaseID`,
  `openKnowledgeBaseDatabase` with foreign-key enforcement enabled, and the
  `query`/`read`/`writeKnowledgeBaseDatabase` transaction wrappers plus
  `listKnowledgeBaseDatabaseIDs`/`deleteKnowledgeBaseDatabase`; the per-base
  file lives in `knowledge-bases/<id>.db` beside sessions.db and is never
  attached to the session database) and `src/session/knowledge_bases.ts` (the
  `KnowledgeBaseSpec`/`KnowledgeBase`/`KnowledgeSnapshot`/`KnowledgeFile`/
  `KnowledgeChunk`/`KnowledgeNode`/`KnowledgeEdge`/`KnowledgeEvidence` domain
  types; `create`/`list`/`get`/`update`/`deleteKnowledgeBase`;
  `storeKnowledgeGraphSnapshot` with atomic activation and active-only
  retention; `getKnowledgeSnapshot`; `reuseKnowledgeSnapshotIfFilesMatch`;
  `prepareKnowledgeGraphReusePlan` + `appendKnowledgeFileGraph` for unchanged
  per-file subgraph reuse; `queryKnowledgeGraph` over the bounded
  `ActiveGraphProjection`; and `migrateLegacyKnowledgeBaseStorage`, the
  idempotent shared-store → dedicated-store migration). Five translated tests
  cover the dedicated-database lifecycle, active-only retention, configuration
  edit invalidation/pruning, legacy migration, and the reuse/clone identity
  isolation, plus the v1→v2 FTS bigram migration test. `memory_store.go` is
  already covered by the `MemoryStore` implementation in `store.ts`. A final
  run ported the SQLite-backed `Manager` itself (`src/session/manager.ts`):
  `newManager`/`newSubAgentManager`/`openSession`/`continueRecent`/
  `openByPathOrID`/`openByID`/`openByIDExact`, the `init`/`initWithID`/
  `initWithBinding` family with the channel handle-file layout and the
  duplicate-ID rejection (`SessionIDExistsError` in `session_errors.ts`), the
  append family (`appendMessage`/`appendMessages` batched into
  `maxEntriesPerTransaction=64` chunks/`appendModelChange`/`appendModeChange`/
  `appendThinkingLevelChange`/`appendAdditionalDirectories`/`appendCompaction`
  with the summary-version chain/`appendContentOverride`/`appendSessionInfo`/
  `appendSessionTitle`), the replay getters, `load`/`reload`, the durable
  conversation-turn methods, `recordUsage`, the fenced `writeEntry`/`writeEntries`
  transaction with the optimistic leaf check, the listing/detail projection
  (`listForDir`/`listAll`/`countWithMessages`/`countAll`/`listForDirDetailed`/
  `listAllDetailed` and `withLimit`/`withOffset`/`withMessagesOnly`/`withSearch`),
  `deleteSession`/`deleteSessionWithMutation` with the child-table cascade and
  the outside-directory/shared-DB guards, the `setSessionBinding`/
  `setExpertBinding`/`setWorkDir`/`getExpertId` Manager methods, and the
  `rotateBoundSession`/`createBound` helpers. Backlog #16 is complete; 49
  translated tests cover construction/init, the append family, replay and
  compaction, listing/detail, open/reload, sub-agent table isolation, deletion,
  content overrides, additional directories, expert/work-dir bindings, and
  channel-binding rotation. `src/architecture` guards move to #34.
- **`architecture` (static guards).** Ported to `src/architecture`:
  `guard.ts` (the dependency-free source scanner: `walkSourceFiles`,
  `importSpecifiers`, `stringLiterals` skipping comments and template bodies,
  the shared ownership predicates, `productionViolations`,
  `publicSdkInternalImports`, and `legacyTestBoundaryViolations` +
  `legacyTestAllowlist`/`legacyTestExemptDirs`) and `mod.ts`. The four Go guard
  tests are translated: `architecture_guard_test.ts` (whole-repo production
  scan plus the fixture table `production architecture guard detects canonical
  run bypasses`: legacy canonical Run persistence/query, direct `RunStore`
  `create`/`update`/`finish`, legacy lease/delivery APIs, direct SQL handles,
  direct `new Agent`, and every foreign-key enforcement spelling),
  `input_contract_guard_test.ts` (adapter entrypoints use `.acceptInput`/
  `.buildUserMessage`/`beginArtifactCollection`/`runWithUserMessage`; entries
  for not-yet-ported adapter modules are pending rather than failing),
  `public_sdk_boundary_test.ts` (`sdk/` and `examples/` never import `src/`),
  and `test_hygiene_guard_test.ts` (adapter tests use the canonical run
  boundaries; owner packages and the guard are exempt). Deviation: the Go
  guards parse `go/ast`; the Deno guards are source-level so fixtures scan
  without `deno info`, while the whole-repo tests call the same functions
  against the real tree. `deno task test:architecture` now passes (8 tests / 22
  steps). This completes backlog #34.
- **`ai` (title generation).** `src/ai/title/title.ts` ports the
  provider-neutral `Generator`/`Fallback`/`Normalize` over the common provider
  interface. `Generate` maps Go's `<-chan StreamEvent` to `for await` over
  `AsyncIterable`, returns a `Promise<string>`, and falls back to the first
  user message when the provider errors or the model returns no text. One
  faithful quirk is preserved: Go's `Normalize` cutset string literal is
  over-escaped, so at runtime it actually trims a literal backslash and the
  letter `t` in addition to space, quotes, backtick, and `#`; the port
  reproduces that exact behavior. 4 translated tests pass.
  reproduces that exact behavior. 4 translated tests pass.
- **`tools` (registry + standard tools).** Ported 1:1 to `src/tools`:
  `tool.ts` (the `Tool` contract, `ToolResult`/`FileDiff`/`InsertResult`/
  `TaskPlan`, the tool Registry with path resolution, mode filtering, snippets/
  guidelines, and the `RegistryConfig`/`newRegistry`
  `/newRegistryWithConfig` constructors), `io_helpers.ts` (the atomic write,
  `BuildFileDiff`, unified-diff hunks, and line-range formatting),
  `read`/`ls`/`write`/`edit`/`insert`/`plan`/`find`/`grep`/`bash`/`jobs`/
  `kill`/`question`/`skill_ref`/`a2a_dispatch`/`image_generation`, the
  `file_lock.ts` in-process write lock, and `jobmanager.ts` background jobs.
  Deviations: `context.Context` maps to a `ToolContext` carrying an
  `AbortSignal`, the stable operation ID, and the interactive `QuestionAsker`
  (the last two were Go `context.WithValue` values); `sync.RWMutex` is dropped
  (Deno is single-threaded); `os/exec` maps to `Deno.Command` with the parent
  signal plus a manual timeout timer; and there is no `SysProcAttr.Setsid`, so
  cancellation kills the direct child rather than the process group. The two
  external Go SDKs are replaced with native equivalents, registered as
  deliberate deviations: `find` uses a basename glob walk with smart-case, and
  `grep` uses a per-line regex search with a literal fallback, both reusing the
  1:1-port of go-ripgrep's `globset`/`ignore` packages for `.gitignore`,
  `.ignore`, `.rgignore`, and hidden-file handling. The `insert` tool keeps the
  32 MiB in-memory limit and the `Deno.FsFile` streaming path for larger files.
  46 translated tests cover the registry, every tool, the diff/atomic-write
  helpers, globset/ignore, the file lock, and the job manager. This completes
  backlog #18.
- **`memory` (persistent memory.md).** Ported 1:1 to `src/memory`:
  `store.ts` (the `Store` with `resolve`/`read`/`readSection`/`add`/`update`/
  `delete`/`writeAll`, the explicit → project → global discovery order, the
  default Markdown template, and the `sectionBounds`/`extractSection`/
  `addToSection`/`replaceInSection`/`deleteFromSection` section helpers) and
  `tool.ts` (the model-facing `memory` tool with read/add/update/delete).
  Deviations: `os` maps to `Deno.*Sync`, `sync.Mutex` is dropped (single-
  threaded), and the Go tool's JSON schema property `new` is kept verbatim.
  10 translated tests pass. This completes backlog #24.
- **`stats` (usage statistics).** Ported 1:1 to `src/stats`:
  `stats.ts` (the `StatsEntry`/`Aggregate`/`Summary`/`Query`/`RecentPage`
  types and the `DB` wrapper over the shared sessions connection and
  `dao.StatsDAO`; `Open`/`OpenDefault`/`Close`, `Summary`/`TimeSeries`/
  `ByProvider`/`ByModel`/`Recent`/`RecentFiltered`), `server.ts` (the path
  router + JSON endpoints and `ParseQueryParams`, with `net/http` mapped to
  `Deno.serve`/`Request`/`Response`), and `assets.ts` (`go:embed` of
  `dashboard.html`/`mothx.png`/`mothx-small.ico` mapped to `Deno.readTextFileSync`
  /`readFileSync` over `import.meta.url`, matching the tokenizer/busybox embed
  pattern and the `deno compile --include` entries already in `deno.json`).
  The Go tests' raw `INSERT`s map to `StatsDAO.insert` over the shared
  connection. 11 translated tests pass (dashboard contracts, summary,
  day/1h time series, by-provider/by-model, recent/recent-filtered, schema
  idempotence, and shared-connection reuse). This completes backlog #30.
- **`debugpprof` (debug server).** Ported to `src/debugpprof/pprof.ts`: the
  once-per-process local-only start, the `VIBECODING_PPROF_ADDR` override with
  the `127.0.0.1:6060` default, and the `/debug/vars` endpoint rendering the
  `src/db` SQLite contention metrics under `mothx_sqlite`. Deviations: Go's
  `net/http` + `expvar` + `net/http/pprof` map to `Deno.serve`/`Request`/
  `Response`; the Go CPU/heap pprof profiles and execution traces are
  Go-runtime specific and return 501 rather than fabricating a profile (the
  index and `/debug/vars` keep the same contract). 5 translated tests pass.
  This completes backlog #31.
- **`update` (npm update detection).** Ported 1:1 to `src/update`:
  `semver.ts` (a faithful port of the `golang.org/x/mod/semver` parse/
  `isValid`/`canonical`/`compare` subset, including the `vMAJOR`/`vMAJOR.MINOR`
  shorthands and the prerelease ordering rules) and `update.ts` (`Notice`,
  `CheckInBackground`, `refreshCache`, `fetchLatest`, the 24h cache at
  `<config>/update-check.json`, the `VIBECODING_NPM_REGISTRY`/
  `VIBECODING_NO_UPDATE_CHECK` env contract, and injectable `fetchLatestVersion`
  /`now`). Deviations: `net/http` maps to `fetch` with `AbortSignal.timeout`,
  `time.Time` maps to `Date` (ISO strings in the cache), and the background
  check is a fire-and-forget `void`ed promise. 7 translated tests pass. This
  completes backlog #33.
- **`mcp` (client + stdio server).** Ported 1:1 to `src/mcp`:
  `rpc.ts` (shared `RPCRequest`/`RPCError`/`mcpProtocolVersion`/
  `mcpMaxResponseBytes` and the raw-id key helpers), `config.ts`
  (`loadConfiguredServers`/`isTemplateServer`), `server.ts`
  (`ServerTool`/`ServerContent`/`ServerToolResult`/`ServerHandler` and
  `serveStdio`, the reusable stdio MCP protocol server for domain packages such
  as the knowledge MCP), and `mcp.ts` (the `Client` with the stdio, streamable
  HTTP and legacy HTTP+SSE transports, `connectServers`/`closeClients`, the
  command/env resolution helpers, inbound ping/sampling handling, the
  text/json/image/audio/blob content projection with per-call provider-aware
  image preprocessing and the 4-image cap, and the `mcp_*` tool/resource/prompt
  projections registered into the shared `tools.Registry`). Deliberate
  deviations: `context.Context` maps to `AbortSignal` (timeouts via
  `AbortSignal.timeout`), goroutines/channels map to Promises plus async stream
  readers, `*exec.Cmd`/`io.WriteCloser` map to `Deno.ChildProcess` and its stdin
  writer, `net/http.Client` maps to `fetch`, the configured environment maps to
  a `Record<string,string>` (Deno's `Deno.Command` shape), and build-time image
  preprocessing is async so the projection helpers and tool `execute` return
  Promises. `json.RawMessage` ids are compared by a type-aware key so a string
  `"1"` never matches the numeric request id `1` (matching Go's raw-byte
  comparison). The Go tests are translated: config/server/unit/table tests plus
  real stdio shell-fixture handshakes, `Deno.serve`-backed streamable-HTTP and
  legacy-SSE integration flows, and the `sanitizeToolName` property test; 36
  tests pass. This completes backlog #20.
- **`esm` (Enable Supervisor Mode).** Ported 1:1 to `src/esm`:
  `state.ts` (the `Status`/`Phase` vocabularies, `Objective`, and the
  `hasObjective`/`canAutoRun`/`isUnfinishedStatus`/`isRunnableStatus` helpers),
  `report.ts` (the worker/audit/recovery report types, the tolerant
  balanced-brace `extractJSONObject` + `parseWorkerReport`/`parseAuditReport`/
  `parseRecoveryReport` with the `missing_work` alias merge, and
  `trimStringSlice`), `store.ts` (the SQLite-backed `Store`: create/edit/clear,
  pause/resume, usage accounting, the model-controlled complete/blocked
  transitions with the three-consecutive-run blocked audit and the
  completion-candidate lifecycle, the repeated-rejection/recovery streaks and
  `finishRun` streak reset, plus the guidance `add`/`pending`/`consume` methods
  over the Runtime-owned `session_esm_guidance` rows), `guidance.ts`
  (`formatGuidanceSuffix`), `prompt.ts` (the steering/continuation prompts and
  the isolated worker/critic/audit/recovery task prompts with XML escaping),
  `evidence.ts` (the shared `EvidenceTracker` and `finalAssistantResponse`),
  `steering.ts` (`SteeringSource`, one emission per persisted objective
  version), `tools.ts` (`get_esm`/`update_esm` and `formatObjective`),
  `supervisor.ts` (`applyWorkerResult`/`applyReviewResult`, the shared
  `invalidWorkerCandidateReason`/`invalidSupervisorPassReason` tool-backed
  evidence checks, and the report formatters), and `runtime_core.ts` (the
  `Supervisor`, `RoleRequest`/`RuntimeAdapter`/`RuntimeEvent` contract, the
  `RoleContext` deadline policy, and the role-incomplete classification).
  Deliberate deviations: `context.Context` maps to an optional `AbortSignal`
  plus the `RoleScope` deadline policy (`context.Canceled`/`DeadlineExceeded`
  map to exported sentinels and DOMException AbortError/TimeoutError); Store
  methods are synchronous and throw the exported sentinel errors instead of
  returning `(objective, error)` pairs; the `Supervisor.run` result is a
  `{ objective, error }` value object because TypeScript cannot return a tuple
  after a throw; `time.Time` maps to `Date` (RFC3339 ISO strings in the durable
  columns). The Go tests are translated: report parsing/aliases/dedup, the
  prompt/guidance contracts, the evidence tracker, steering emission, every
  Store lifecycle transition, the Supervisor worker/critic/audit/recovery
  flows, cross-adapter persistence, and a deterministic property test over the
  report parsers (now covered by `deno task fuzz`). 42 tests pass. This
  completes backlog #23.
- **`skillhub` (marketplace clients + safe install).** Ported 1:1 to
  `src/skillhub`: `types.ts` (the `Market`/`MarketInfo`/`MarketCapabilities`,
  `SearchQuery`/`UserSkillsQuery`/`SearchPage`, `SkillId`/`SkillSummary`/
  `SkillDetail`/`SkillFile`/`Category`/`DownloadMeta`/`InstalledState`, and the
  `MarketClient` interface with optional `showcase`/`fileContent` methods),
  `http.ts` (the injectable `HttpClient` fetch seam replacing Go's
  `*http.Client`/`RoundTripper`, `getJSON`/`getWithStatus`/`decodeJSON`/
  `endpoint`/`statusText` and the bounded-body readers), `client_helpers.ts`
  (`boundedLimit`/`filterSkills`/`download`), `cache.ts` (the cloned-value
  TTL `MemoryCache`), `clawhub.ts` (the ClawHub.ai client with the
  `AMBIGUOUS_SKILL_SLUG` 409 owner-resolution retry, cached owners, both
  envelope/root detail shapes, the flexible timestamp/version/tag decoders,
  and file-content fallback), `skillhubcn.ts` (the SkillHub.cn client with
  search/list/user/browse/detail/files/evaluation/showcase/categories and the
  primary+CDN download fallback), `factory.ts` (`clientsForSettings` + the
  bearer-token transport), `local.ts` (the `LocalIndex` scan over global and
  project dirs, metadata read, and update detection), `install.ts` (the atomic
  `Install`: owner/version checks, size-bounded download, safe zip extraction,
  staging rename, metadata write, and backup-on-replace), `zip.ts` (a
  dependency-free ZIP reader/writer: central-directory parsing, stored and
  `deflate-raw` entries via `Decompression/CompressionStream`, and a
test-archive builder), and `service.ts` (the caching `Service` with
  markets/search/categories/detail/official/install/uninstall/showcase/
  fileContent/installSkillSet and the target-dir/skill-dir confinement
  checks). Deliberate deviations: Go's `*http.Client`/`RoundTripper` maps to an
  injectable fetch function so network behavior can be substituted in tests
  (real localhost `Deno.serve` fixtures and fake clients); `archive/zip` maps
  to the local `zip.ts`; `errors.New` sentinels map to typed `Error` classes
  (`InvalidArchiveError`/`LocalSkillExistsError`); `time.Time` maps to `Date`
  (ISO strings in metadata); `sync.Mutex` is dropped (single-threaded); the
  generic `memoryCache[T]` maps to per-kind `Map`s. The Go tests are
  translated: SkillHub/ClawHub search/detail/browse/categories parsing, the
  ambiguous-slug resolution/caching/helpful-error/end-to-end install flows,
  install validation/traversal/local-skill/update/owner-rejection,
  local-index update detection, service official aggregation/caching/detail
  enrichment, the configured bearer-token client fixture, and the file-content
  fixture. 26 tests pass. This completes backlog #28.
- **`messaging` (channel platform adapters).** Ported 1:1 to `src/messaging`:
  `platform.ts` (the `Platform`/`Readiness`/`StatusCallbackSetter` interfaces,
  `MessageHandler`/`MessageResponse`, the `OutboundText`/`OutboundAttachment`
  staging callbacks, the `DurableDeliveryExecutor` contract,
  `InboundMessage`/`PlatformAttachment`/`AttachmentStream` and the attachment
  kind constants) and `progress.ts` (`ProgressBuffer`/`newProgressBuffer`). The
  WeChat iLink adapter is `src/messaging/wechat/` (`types.ts`, `crypto.ts`,
  `protocol.ts`, `auth.ts`, `media.ts`, `media_send.ts`, `wechat.ts`), and the
  Feishu/Lark adapter is `src/messaging/feishu/` (`types.ts`, `frame.ts`,
  `api.ts`, `ws.ts`, `feishu.ts`). Deliberate deviations: `context.Context`
  maps to `AbortSignal`; `io.Reader` maps to `Uint8Array`/`ReadableStream`;
  `time.Time` maps to `Date`; `sync.Mutex` is dropped (single-threaded); the Go
  `*http.Client`/`RoundTripper` maps to an injectable `FetchLike` seam on
  `Client` (the wechat tests substitute a fake or a real `Deno.serve`
  localhost fixture); the official Feishu `oapi-sdk-go/v3` is replaced by the
  local raw-HTTP `api.ts` and a `Deno` WebSocket `ws.ts` with a small
  hand-rolled pbbp2 protobuf frame codec (`frame.ts`); `errors.New` sentinels
  map to typed `Error` classes. `src/messaging/mod.ts` exports only the core
  `platform`/`progress`; WeChat and Feishu live in their own subpackages
  (mirroring the Go layout). The Go tests are translated: WeChat protocol
  lifecycle/cursor, timeout-is-empty-poll, semver/long-poll helpers, chunking,
  reply queuing, inbound media download/decrypt (image/file/voice/video/quoted),
  the locked-CDN outbound media contract, truncated-ciphertext rejection, the
  `Start` health/cursor-persistence flow, and the Tencent 2.4.6 fixture
  manifest/wire/AES-key/upload contracts (fixtures copied to
  `src/messaging/wechat/testdata/tencent-2.4.6/`); plus the Feishu
  inbound/filter/readiness/stop tests. 21 tests pass. This completes backlog
  #27.
- **`a2a` (Agent-to-Agent protocol server/client).** Ported 1:1 to `src/a2a`:
  `task.ts` (the `Task`/`Message`/`MessagePart`/`Artifact`/`TaskError`/
  `TaskEvent` wire DTOs with Go's `json` tags preserved, `newTaskID`, and the
  deep-copying `TaskStore` with `create`/`get`/`update`/`setState`/`cancel`/
  `finish`), `config.ts` (`Config`/`AgentCardCfg`, `defaultConfig`,
  `configPath`/`projectConfigPath`, `getListenAddr`/`getWorkDir`,
  `saveConfig`/`initA2AConfig`), `agent_card.ts` (`AgentCard`/`Capabilities`/
  `Skill`, `defaultAgentCard`, `handleAgentCard`), `handler.ts` (the JSON-RPC
  2.0 `message/send`/`task/get`/`task/cancel` handler with sync and SSE
  responses, run registration/cancellation, and the `EventQueue` subscriber),
  `server.ts` (the `Deno.serve` server with Agent Card, JSON-RPC, REST-style
  and SSE routes plus constant-time bearer auth), `client.ts` (the JSON-RPC and
  SSE client over `fetch`), `master.ts` (`a2a-list.json` agent registry and
  `A2AManager.dispatch`), and `executor.ts` (`DefaultExecutor` converting agent
  events into A2A task events). Deliberate deviations: `net/http` servers map
  to `Deno.serve` + `Request`/`Response` routing (the `mux.ServeHTTP` seam is
  `Server.handleRequest`); `http.Flusher` maps to a streaming `ReadableStream`;
  `context.Context` maps to `AbortSignal`; `time.Time` maps to RFC3339 strings;
  `sync.RWMutex` is dropped (single-threaded); `crypto/subtle` maps to a manual
  constant-time compare; and `AgentFactory.CreateForA2A` returns a narrow
  `A2AAgent` (`id()` + `run()` yielding an `AsyncIterable<Event>`) until the
  core agent loop lands (#19), which keeps the executor fully ported while
  protocol-compatible. The Go tests are translated (config/card/task-store,
  handler send/get/cancel/errors/method/auth, subscribe/broadcast, and the
  client JSON-RPC/Agent-Card/error/auth fixtures over an ephemeral
  `Deno.serve`): 25 tests pass, full suite 1085. This completes backlog #29.
- **Public SDK (`agent`) + bootstrap.** Ported 1:1 to `sdk/agent/` (the public
  SDK boundary, which must not import `src/`): `types.ts` (the `Agent` /
  `QuestionHandler` interfaces, `AgentConfigView`, `ContextUsage`,
  `AgentContext`, `Role`, `Message`/`ContentBlock`/`FileContent`/
  `ToolCallBlock`/`ImageContent`/`CacheControl`/`ToolDefinition`/`Usage`/
  `Attachment`/`CostBreakdown`, the `EventType` and `TaskStatus` vocabularies
  with their terminal classifiers, the `Event`/`ToolImage`/`FileDiff`/`TaskPlan`
  shapes, and the `newUserMessage`/`newAssistantMessage`/
  `newAssistantTextMessage`/`newToolResultMessage`/
  `newToolResultMessageWithContents`/`newSystemInjectedUserMessage` constructors
  plus `totalInputTokens`/`billableInputTokens`/`calculateCost`), `provider.ts`
  (`Provider`/`ChatParams`/`ThinkingLevel`/`StreamEventType`/`StreamEvent`/
  `HostedItem`/`ModelInfo`/`ModelCompat`, `BaseProvider`, `vendorFromBaseURL`,
  `boolPtr`), `builder.ts` (the fluent `Builder` with
  `newBuilder`/`setBuilderFunc`/`setResolveProviderFunc`/`BuilderConfig` and the
  `defaultMaxToolConcurrency` default), `external_tool.ts` (`ExternalTool`,
  `ExternalToolResult`, `ExternalToolPromptInfo`), and `image_coordinates.ts`
  (`mapPointToOriginal`/`mapRectToOriginal`/`mapNormalizedPointToOriginal`/
  `mapNormalizedRectToOriginal`). `MapPointToOriginal` and
  `MapNormalizedRectToOriginal` are translated from the Go tests, and the pure
  helpers (usage/`cost`, task-status classification, builder defaults and
  validation, `vendorFromBaseURL`, constructors) have focused tests: 15 pass.
  `src/bootstrap/` ports the Go `bootstrap` package: `provider_bridge.ts`
  (`ProviderAdapter` wrapping an internal provider as a public
  `sdk/agent.Provider`, with public↔internal `Message`/`ContentBlock`/
  `ToolCallBlock`/`ToolDefinition`/`Usage`/`Attachment`/`StreamEvent` conversion,
  `streamEventTypeToPublic`, `streamRetryMaxAttempts`, and the
  `registerProviderBridge` hook that wires `Builder.withProviderByName` to the
  shared `src/provider` registry) and `mod.ts` (blank-imports the
  anthropic/google/openai factories and re-exports the bridge). The Go
  `bootstrap.go` `internal/agent` import that registers `agent.setBuilderFunc`
  is intentionally deferred to backlog #19, so `Builder.build()` currently
  throws the standard "internal builder is not registered" error until
  `src/agent` lands. Three translated bridge tests pass (model-id preservation,
  retry-metadata preservation, tool/usage/hosted-item event-type mapping); the
  two Go builder-integration tests move to #19. This unblocks backlog #19,
  which imports the public `agent` package.
- **Image codecs (`imageproc`).** Resolved: `npm:imagescript` provides
  PNG/JPEG/GIF decode plus PNG/JPEG encode, `resize`, and `crop`; WebP decode
  uses `npm:@jsquash/webp` (WASM) whose pixels are handed to imagescript. There
  is therefore no WebP gap, and `src/imageproc` mirrors the Go geometry, limits,
  and MIME selection. Two deviations: the read path is **async** (the Go codec
  API is sync), and the resampling kernel is imagescript's rather than
  `x/image/draw` CatmullRom, so encoded bytes are not bit-identical (the Go
  tests only assert geometry/limits/MIME). The WASM asset must be bundled for
  `deno compile`.
- **TUI (`bubbletea`/`lipgloss` → Ink + React).** Framework decided: **Ink
  (`npm:ink@^5`) + React 18 (`npm:react@^18`)**, JSX with the classic
  (`React.createElement`) runtime. Not a mechanical port; the Elm
  Model/Update/View runtime maps to function components + hooks (`tea.Cmd` →
  Promise/effect, `tea.Msg` → state), `tea.KeyMsg` → Ink `useInput`, and
  lipgloss → Ink `<Box>` (Yoga flexbox) + `<Text>` + `chalk`. Completed
  transcript blocks go to terminal scrollback via Ink's `<Static>`; only the
  active streaming region stays in the managed view. Keep canonical events from
  `src/agent` and re-render. The earlier mouse/wheel sub-decision is resolved:
  completed transcript blocks are committed to the terminal's own scrollback via
  Ink's `<Static>` in **inline mode (never the alternate screen)**, so the
  terminal handles selection, copy, and wheel scrolling natively. The Go TUI's
  in-app `tea.MouseMsg` wheel scroll is therefore not ported; the managed view
  only holds the active streaming region, which stays small. Residual edge:
  a single active block taller than the viewport cannot be wheel-scrolled until
  it completes into scrollback (use paging keys, or let it finish).
  Status: toolchain validated (`src/tui/app.tsx` + `tui_test.ts` render under
  Deno 2.9), and the scrollback/streaming skeleton is in place
  (`markdown.ts` wraps `src/tsm`; `transcript.tsx` commits completed blocks to
  `<Static>`/scrollback exactly once and renders only the active block live).
  The remaining transcript/input/agent wiring is blocked on the unported
  `src/agent` and `src/agentruntime`.
- **Streaming Markdown (`GoStreamingMarkdown/gsm` → `src/tsm`).** Ported as a
  standalone zero-dependency library (`node`/`parser`/`renderer`/`stream`,
  mirroring the Go `parser`+`renderer`+`gsm` packages). It is the Ink-independent
  renderer the TUI calls per streamed chunk; it is not one of the 38 backlog
  packages. Validated by **differential testing** against the real Go library:
  byte-identical for well-formed Markdown, for CJK/emoji content, and for all
  pure-ASCII inputs. One deliberate deviation: Go's inline parser reads the
  escaped character as a *byte* (`string(byte)`), so `\本` renders `æ`; this port
  operates on code points and renders `本` correctly.
- **WebSocket / SSE / Feishu SDK.** `gorilla/websocket`, `oapi-sdk-go` map to
  `Deno.upgradeWebSocket`, manual SSE, and raw HTTP respectively.
- **`goja` (JS engine in `workflow`).** Replace with Deno's own V8 sandbox
  (`new Worker` + restricted imports) rather than embedding a JS engine.
- **Vendored assets.** `src/platform/busybox_assets/` and
  `src/context/tokenizerdata/` must be copied from the Go tree and embedded with
  `deno compile --include`. Go's `go:embed` of built-in skills is replaced by a
  generated inlined module (`src/skills/builtin_content.ts`) served through an
  in-memory `SkillFS`; regenerate it when `src/skills/builtin/` changes. The same
  pattern applies to the built-in expert seed bundles: `src/expert/builtin/`
  (copied from the Go `experts/` package) is inlined into
  `src/expert/builtin_content.ts` and served through an in-memory `ExpertFS`; the
  two seed packages are `software-company` and `frontend-developer`.
- **`workflow` (JavaScript DSL orchestration).** Ported to `src/workflow`:
  `types.ts` (the `AgentTask`/`AgentResult`/`PhaseState`/`WorkflowLog`/`RunState`/
  `ProgressEvent` wire DTOs with Go's camelCase `json` tags preserved, plus the
  injectable `Host`/`Store` interfaces), `active.ts` (`ActiveRegistry`),
  `store.ts` (`FileStore`, atomic `makeTempFile`+`rename`, date revival on
  load), `js.ts` + `js_worker.js` (the JavaScript DSL evaluator),
  `runner.ts` (the async `Runner`/`WorkflowRuntime`, `resolveJsValue`, result
  lookup, deterministic fan-in text, iteration logs), `skill.ts`
  (`EnsureProjectSkill` plus the bundled skill and nine progressive references),
  and `tools.ts` (`LintTool`/`StatusTool`/`CancelTool` and `RunTool` metadata,
  parameters, guidelines, and `executionTimeout`). Deliberate deviations: goja
  maps to a Deno Worker (loaded as text via a `text` import and started from a
  `data:` URL, so it needs no bundle entry and works in the compiled binary)
  that is terminated on abort or when the wall-clock evaluation budget expires,
  because Deno has no interruptible in-process VM; `context.Context` maps to
  `AbortSignal`; goroutines/channels map to async/`Promise` with a small async
  semaphore; `errors.Join` maps to an `AggregateError` whose message joins the
  errors; `time.Time` maps to `Date`; `sync.RWMutex` is dropped. 26 translated
  `Deno.test` cases pass (js/runner/semantics/store/skill/lint/cancel); full
  suite 1111. Remaining #21 work is `AgentHost` and `workflow_run`'s `execute`
  plus the `RegisterTools` run registration, which depend on the not-yet-ported
  Agent Core (`internal/agent`, backlog #19); the run tool's metadata surface is
  already ported so it is stable. This migrates backlog #21 to partial (🟡).

A later run completed backlog #19's background Responses request paths and
backlog #21. `src/agent/agent.ts` now ports `agent.go`'s detached
Responses/background surface: the exported `workDirForAgent` helper, the
`Agent` methods `buildBackgroundChatParams`/`buildBackgroundContinuation
Params`/`buildBackgroundReplayParams`/`responsesStateFallbackError`, and the
`executeBackgroundToolCall`/`executeBackgroundToolCallRecovering`/
`executeBackgroundToolCallOrdered` entry points. Go's `<-chan Event` return maps
to the same `EventChannel`/`AsyncIterable<Event>` projection used by the run
entry points, `context.Context` maps to the `RunContext` value bag plus an
`AbortSignal`, and `BuildBackgroundReplayParams` reads the durable session's
`getReplayState()` so replay includes the failed continuation.
`src/workflow/agent_host.ts` ports `agent_host.go`: the `AgentHost` Host
implementation that creates a worker through `AgentManager.create`, forwards
approval/child events to the parent sink, maps the two Go `context.Context`s to
one combined `AbortSignal`, and applies the terminal status to the manager;
`workflowAgentID`/`buildTaskPrompt` are ported verbatim. `src/workflow/tools.ts`
now implements `workflow_run`'s `execute` (tool-context parent identity/event
sink/mode extraction, the `AgentHost` + `Runner` wiring, progress-to-parent
event projection, and the `runToolResult`/`summarizeResults` serialization),
and `registerWorkflowTools` types its manager as `AgentManager`. Note: the
workflow AgentHost creates workers through `AgentManager`, exactly as the Go
package binds to `internal/agent`; when backlog #26 (`src/agentruntime`) lands
this call site must move behind `SessionRuntime`, and it is the only new
non-`src/agent` `AgentManager.create` caller, so this is a named migration
bridge. New translated tests: `agent_background_test.ts` (4, from
`agent_test.go`'s background-params case and `tool_launch_test.go`'s ordered
background release) and `agent_host_test.ts` (4, from `integration_test.go` plus
an empty-source guard). Full suite 1178 passed / 0 failed, architecture 8/8,
lint clean, check clean. Remaining #19 work is only the `examples/`
(`simple_agent`, `custom_provider`, which need a public-bootstrap-import design
decision because the architecture guard forbids `examples/` importing `src/`)
and any remaining translated `agent_test.go` terminal-contract cases.

A later run continued #26 (`internal/agentruntime`) by porting the
Runtime-owned attachment store and artifact reconciliation slice that the
artifact/attachment lifecycle invariants depend on. `src/agentruntime/input.ts`
ports the `AttachmentService` half of `input.go`: `ArtifactIngress`/
`ArtifactStream`, `acceptArtifact` (size-limited, SHA-256-hashed private-store
intake with image sniffing), `Get`/`Open` (integrity-checked, expiry-aware reads),
`CleanupExpired`, `storagePath`, and `SetStatus`. `AcceptProviderAttachment` and
the artifact collector stay with the `SessionRuntime` slice because they need a
bound runtime. `src/agentruntime/media_type.ts` ports the `net/http/sniff.go`
subset behind `detectAttachmentMediaType`/`detectContentType` (the WHATWG MIME
sniffing signature table, 512-byte window, `application/octet-stream` fallback).
`src/agentruntime/storage_reconcile.ts` ports `storage_reconcile.go`: the
fails-closed `ReconcileArtifactStorage` pass over `artifacts/`, the
16-hex-directory/layout validation that leaves foreign or symlinked entries
alone, the retention-plus-grace `ArtifactReclaimFloor`, the
`reconcileAttachmentStorage` service wrapper, and the once-per-interval
`reconcileArtifactStorageOpportunistic` intake hook (with an exported
`artifactReconcileThrottle` test seam). Deviations: `context.Context` maps to an
optional `AbortSignal`; `[]byte` maps to `Uint8Array`; `io.ReadCloser` maps to
`Deno.FsFile`; `time.Time` maps to `Date` (RFC3339 strings in the durable
columns); `sync/atomic` maps to module state (single-threaded); the Go
`(*AttachmentService) ReconcileStorage` method maps to a standalone function
because TS classes cannot be split across modules. New translated/focused tests:
`input_test.ts` (5, from `input_test.go`'s artifact open/tamper/cleanup cases),
`storage_reconcile_test.ts` (5, from `storage_reconcile_test.go`), and
`media_type_test.ts` (2). The same run also ports `session_options.go` to
`src/agentruntime/session_options.ts` (`SessionConfigOption`/
`SessionConfigOptionChoice`, the `ConfigOption*` identifiers, `ProviderCatalog`/
`SessionModelBinding`, `sessionConfigOptions`/`sessionConfigOptionsWithProviders`,
`providerDisplayName`, and `validateThinkingLevel`), with `session_options_test.ts`
(4 focused cases). 16 new tests pass; full suite 1254 passed / 0 failed,
architecture 8/8, lint clean (542 files), check clean, fmt clean. Remaining #26
work is the `SessionRuntime`/`Builder` resource assembly, the
`ExecutionRuntime`/`RunStore` durable lifecycle (`execution*.go`,
`durable_ops.go`), the `input_materializer.go` input contract, the artifact
collector/`AcceptProviderAttachment`, `run_recovery`/`recovery_coordinator`,
`registry`/`tool_fence`, `expert`/`knowledge*` orchestration,
`storage_reconcile` service wiring, `maintenance_cron`, the MCP lifecycle, and
coordinated shutdown.

A later run began backlog #25 (`internal/cron`) by porting its dependency-free
foundation and the Runtime-owned maintenance executor that the shared scheduler
dispatches to, and flipped the ledger row to partial (🟡).
`src/agentruntime/maintenance_cron.ts` ports `maintenance_cron.go`: the
`MaintenancePolicy` intent (`DefaultMaintenancePolicy`,
`MaintenancePolicyFromSettings` delegating to the config settings helpers), the
`MaintenanceCronJobPrefix` namespace and the stable storage-reconcile identity
(`MaintenanceStorageReconcileJobID`/`MaintenanceStorageReconcileSchedule`/
`MaintenanceStorageReconcileJobName`), `IsMaintenanceCronJobID`, and the
`RunMaintenanceCronJob` executor that always claims a namespaced ID (refusing an
unknown one loudly rather than letting its prompt run as a model turn) and
reclaims aged attachment storage through the ported `ReconcileArtifactStorage`.
`src/cron/` ports the foundation: `cron.ts` (`CronJob`, the `CronStore`
interface, `newCronID`, the 24h `runningLeaseTimeoutMs`, and a `DueJobClaimer`
seam), `schedule.ts` (`parseSchedule` with the `@every`/named/5-field grammar and
`normalizeJobSchedule`), `session_store.ts` (the session-scoped `CronStore`
adapter), `sqlite_store.ts` (the DAO-backed `SQLiteCronStore` with atomic
`claimDue`), `tool.ts` (the model-facing `cron` tool), and `maintenance.ts`
(`userVisibleJobs`/`isMissingCronJobError`). Deliberate deviations: `time.Time`
maps to `Date | null` (stored as an empty string for Go's zero time),
`(next, isOneShot, error)` maps to a `ScheduleResult` value object plus a throw,
`RunMaintenanceCronJob` is async because `ReconcileArtifactStorage` is async,
and calendar arithmetic uses local-time components to match production's
`time.Now()`. New translated tests: `schedule_test.ts` (8),
`store_test.ts` (14), `tool_test.ts` (10), and
`maintenance_cron_test.ts` (5). 37 new tests pass; full suite 1291 passed / 0
failed, architecture 8/8, lint clean, check clean, fmt clean. Remaining #25 work
is the `Scheduler` itself (`scheduler.go`), which binds to the durable Runtime
(`ExecutionRuntime`/`RunStore`, `AcquireExecutionAdmission`,
`ResolvePolicyFromSession`, the A2A job path) and owns the scheduler-bound
maintenance projection (`SetMaintenancePolicy`/`ensureMaintenanceJob`); it lands
with backlog #26.

A later run completed backlog #22 (`internal/browser`) by porting the mothx
`browser` tool together with the slice of the external vibe-browser SDK it
depends on, and flipped the ledger row to ported (✅). The vibe-browser source
authority is the pinned module `github.com/startvibecoding/vibe-browser@v0.1.5`
(the local checkout tracks a newer commit lacking `HTMLOptions`, so the v0.1.5
module cache was used). `src/browser/protocol.ts` ports
`pkg/protocol/types.go` (`Request`/`Response`, the option buckets
`NavigationOptions`/`ClickOptions`/`FillOptions`/`ScreenshotOptions`/
`SnapshotOptions`/`WaitOptions`/`HTMLOptions` + `DefaultHTMLMaxBytes`,
`BrowserType` + constants, `LaunchOptions`/`Geolocation`/`SessionInfo`/
`TabInfo`/`NetworkRequest`/`Cookie`/`StorageEntry`/`NodeRef`/`ActionResult`;
`json.RawMessage` maps to decoded values and `time.Time` to `Date`).
`src/browser/cdp.ts` ports `pkg/cdp/client.go`: the WebSocket CDP client with
`send`/`sendToSession`, an event queue surfaced through `nextEvent`, and
`close`/`isConnected`; `gorilla/websocket` maps to the global `WebSocket`,
`Events() <-chan` maps to the promise queue, and `sync.Mutex`/`atomic.Int64`
are dropped. `src/browser/chrome.ts` ports the launch/discovery subset of
`internal/chrome/launcher.go` (`findBrowser` with per-OS candidate tables,
`discoverCdpUrl` with the `/json/version` and `/json/list` fallbacks,
`autoConnectCdp`, `launch` + the `Process` killer, `listTargets`,
`getBrowserVersion`), with `os/exec` mapped to `Deno.Command` and `net/http` to
`fetch`. `src/browser/ops.ts` ports the full high-level automation surface of
`pkg/browser/browser.go` (navigation/waits, mouse and keyboard input, coordinate
actions, element reads, `getHtmlWithOptions`/`truncateHtml`/
`runeAlignedPrefix`, screenshots, accessibility `snapshot`/`formatAxTree`
including the contenteditable "editor" role and the interactive-filter empty
marker, DOM node resolution, viewport/geolocation/offline/headers, cookies,
and tabs). `src/browser/client.ts` ports `pkg/client/client.go`: the `Options`
shape, direct mode (`Client.open` via CDP or launch-and-connect, wiring the
process killer as a `setProcessKiller` callback), daemon mode (`Client.connect`
plus the Unix-socket JSON-RPC `#daemonSend`/`#daemonCall`, mirroring every
action name the Go client uses), `getSocketDir`, `isDaemonRunning`, `parsePid`,
and `isProcessAlive` (with a Linux `/proc` fallback because Deno exposes no
portable signal-0 probe). `src/browser/tool.ts` ports `internal/browser/
browser.go`: the same action matrix, parameter helpers, `clientOptions`,
`htmlOptionsFromParams`, `cookieFromParams`, screenshot image-policy
processing through `src/imageproc`, and the `publish_artifact`-free text/image
tool results; `cacheRegistry`-style `BrowserTool` holds the injected registry
and lazily-created client. `registerTool`/`removeTool`/`isToolRegistered`/
`ToolName`/`SkillName` are exported from `src/browser/mod.ts` so the future
`SessionRuntime` slice can depend on this package without growing a second
browser path. Deliberate deviations: `context.Context` maps to `AbortSignal`
(threaded through the client and tool context), `panic`-based `requireString`
throws, `[]byte` maps to `Uint8Array` with `atob`/`btoa` helpers, `sync.Mutex`
is dropped, and the full `internal/chrome` profile/DevToolsActivePort helpers
plus `pkg/daemon`/`pkg/mcp` are intentionally out of scope (they are not
reachable from the mothx `browser` tool). New translated/focused tests:
`browser_test.ts` (10, from `browser_test.go`'s skill-discovery, register/
remove, screenshot-processing, client-option, HTML-option, and cookie cases
plus focused `truncateHtml`/`runeAlignedPrefix`/`formatAxTree` coverage). 10
new tests pass; architecture 8/8, lint clean, check clean, fmt clean. Remaining
backlog is #19's `examples/` and loop cases and the #26 `SessionRuntime`/
`Builder` remainder (whose `session_runtime.go` imports `internal/browser`,
now satisfied by `src/browser`), which unblocks #35-#38.


A later run landed the bulk of the remaining #26 (`internal/agentruntime`)
`SessionRuntime`/`Builder` resource assembly — the shared runtime state that
unblocks every adapter (#35–#38) — plus the Runtime-owned input path, artifact
collector, MCP lifecycle, expert orchestration, and coordinated shutdown.
`src/agentruntime/session_runtime.ts` declares the whole `SessionRuntime` class
(Go splits its methods across `session_runtime.go`, `agent_build.go`,
`artifact.go`, `expert.go`, and `registry.go`; TypeScript requires one class
body per module) together with the `Builder` and the standalone resource
loaders: `setExecution`/`setDecisions`, the idempotent `shutdown`/`close`, the
source/mode `resolvePolicy`/`resolvedExecutionPolicy`, `bindSession`/
`unbindSession`, `configureSession`/`configSnapshot`/`resolvedProviderModel`,
the capability and directory surface (`configureCapabilities`/
`setCapabilityOption`/`setAdditionalDirectories`/`reloadAdditionalDirectories`),
the config-option surface (`configOptions`/`reloadPersistedConfig`/
`setConfigOption`/`providerByName`), the expert methods
(`expertState`/`listExperts`/`inspectExpert`/`expertConfigOption`/
`teamExpertActive`/`refreshExpertBinding`/`setExpert`/`prepareExpertResources`/
`prepareBoundSessionResources`/`prepareResourcesForBundle`/
`publishPreparedExpertResources{,Locked}`), the resource lifecycle
(`applyRegistryHooks`/`refreshResources`/`rehydrateBoundResources`/
`synchronizeCoreTools{,Locked}`), the Runtime-owned input path (`acceptInput`/
`prepareInput`/`attachPreparedInput`/`discardInput`/`cleanupInputResources`/
`buildUserMessage`/`acceptProviderAttachment`), the artifact path
(`beginArtifactCollection`), the MCP lifecycle (`connectMCP`/
`connectConfiguredMCP`), and Agent construction (`buildAgent`/
`buildTransientAgent`/`buildAgent` with `composeBeforeToolExecute`), plus
`loadContextResources{,WithExpert}`, `activeSkillsContext`,
`subAgentToolsEnabled`, and `sandboxOptionsFromSettings`. `expert.ts` ports the
standalone half of `expert.go` (`ExpertBinding`, `newExpertBinding`,
`composeExpertIdentity`/`composeExpertRoster`, `projectExpertBuild`,
`composeSteering`, `listExperts`/`inspectExpert`/`expertConfigOption`/
`sessionHasTeamExpert`, and `ErrExpertSwitchRequiresFork` as a typed error).
`registry.ts` ports `registry.go` (`BuildRegistry`, `RegistryPolicy`,
`RegistryMutator`, `MCPPolicy`, `DefaultPlanToolPolicy`, `CloseMCPClients`).
`artifact.ts` ports `artifact.go` (`ArtifactCollector` with observer/close/
register, `PublishArtifactTool`, `classifyArtifact`). `attach.ts` ports
`attach.go` (`AttachedResources` + `AttachSessionResources`). Deviations:
`sync.RWMutex` is dropped (Deno is single-threaded); `time.Time` maps to `Date`;
`context.Context` maps to an optional `AbortSignal`; `filepath` maps to
`@std/path` + `Deno.realPathSync`/`Deno.statSync`; `[]byte`/`io.ReadCloser` map
to `Uint8Array`/`ReadableStream`; the resource-assembly loaders are async
because `ensureProjectSkill` and Deno filesystem APIs are async; Go's
`(*SessionRuntime)` resolver view maps to structural interfaces
(`ToolFenceRuntime`/`AgentManagerRuntime`/`ArtifactRuntime`) so
`session_runtime.ts` has no import cycle with `tool_fence.ts`/`agent_manager.ts`;
and Go's multiple `(value, error)` returns throw typed errors. New translated
tests: `session_runtime_test.ts` (14: the artifact-disabled default and closed-
runtime rejection, observer persistence and observer-panic containment,
`AttachSessionResources` identity/ownership, lazy `BindSession` identity,
failed-preparation identity preservation, closed-runtime rejection,
`BuildRegistry` adapter policy, the expert config-option binding/fork/unbind
rules, model/mode/thinking config persistence, `AcceptInput`/`BuildUserMessage`
canonical materialization, and `AttachPreparedInput` unavailability). Full
suite 1404 passed / 0 failed, architecture 8/8, lint/check/fmt clean. Remaining
#26 work is the `WithKnowledgeContext`/`prepareKnowledgeContextWithLibrarian`
librarian capsule path on `SessionRuntime` (the deterministic
`prepareKnowledgeContext` fallback already exists; the model enrichment bridge
still throws when a configured indexer binding is present), and a verification
pass over the consolidated `execution.ts` against the split Go
`execution_events`/`observation`/`persistence`/`snapshot` tests. With the
SessionRuntime slice landed, `workflow/agent_host.ts`'s `AgentManager.create`
call site can now move behind `SessionRuntime` and backlog #35–#38 are
unblocked.

A later run closed the #26 verification gap and began backlog #35
(`internal/acp`), flipping its ledger row to partial (🟡). The previously
deferred execution-snapshot and admission test files are now translated against
real session databases: `src/agentruntime/execution_snapshot_test.ts` ports
`execution_snapshot_test.go` (`inspectSessionExecution` local lifecycle,
raw-lease external/legacy-unbound/mismatched/orphaned distinctions, the mutation
reservation projection, the canonical-remote requirement for the detached state,
and the reattach-recovery lease promotion that registers a local execution) and
`src/agentruntime/execution_admission_test.ts` ports `execution_admission_test.go`
(orphan reconciliation before the guard is returned, live-owner
non-displacement with the waiting-admission `TimeoutError`, and verified-remote
retention as a `DetachedRemoteExecutionError`); raw `session_runtime_leases`
fixtures are allowed in tests per the DAO/DB rule. For #35, `src/acp/protocol.ts`
ports the ACP wire vocabulary (`contentBlock`, the strict-union
`ToolCallContent` whose `toJSON` reproduces the Go `MarshalJSON` diff/text split,
`toolCallLocation`, `planEntry`, `usageCost`, `sessionUpdate`, and the
`requestQuestion` payload), and `src/acp/projection.ts` ports the pure,
server-independent projection helpers: `acpStructuredRPCError`, `acpRunStatus`,
`acpEventName`/`acpToolKind`/`acpHostedStatus`, `textToolContent`,
`acpPlanEntries`/`acpPlanMeta`, `acpStreamMessageID`/`acpStreamFallbackMessageID`
(the SHA-256 fallback), `acpRetryEvent`/`acpRetryMessage` (via the shared
`goDurationString`), `toolCallLocations`, `formatACPPlan`/`planStatusMarker`,
`encodeSessionCursor`/`decodeSessionCursor` (raw-URL base64),
`sameStringSlice`, `parseJSONRawToMap`, `extractSamplingPrompt`/
`extractSamplingInput`, `requestQuestionPayloadFor`/`questionProjectionFor`,
`artifactSessionUpdate`, `acpByteSize`, `acpToolImageContents`, and
`acpOptionalProjectID`. `src/acp/mod.ts` re-exports both modules. Deviations:
`json.RawMessage` maps to decoded `unknown`, `nil` slices to empty arrays, and
Go's `(value, error)` returns throw. New tests: the
`acpRunStatusProjectionMapsCanonicalStatuses`, image-limit, and
`extractSamplingInput`/`parseJSONRawToMap` cases from `acp_phase1_test.go` and
`acp_mcp_test.go` plus focused coverage for the remaining helpers (23 in
`src/acp`). Full suite 1437 passed / 0 failed (was 1406/0), architecture 8/8,
lint/check/fmt clean. Remaining #35 work is the ACP server itself (the stdio
JSON-RPC loop, `handleInitialize`/`handlePrompt`/`handleAgentEvent`, sessions,
decisions, artifacts, MCP sampling, and the `mothx/manage/*` extensions in
`acp.go`/`extensions.go`/`manage*.go`), which can now bind to the landed
`SessionRuntime`. Remaining backlog is #35's server + management extensions,
#36 `serve`, #37 `tui`, and #38 `cmd/mothx`→`src/cli`+`src/main.ts`; #19's
`examples/` stays blocked on the public-bootstrap/guard decision and #22's
remaining gaps (daemon/mcp/full chrome helpers) are out of scope for the mothx
`browser` tool.

A later run continued #35 (`internal/acp`) with the front-end-neutral protocol,
input, and transport layer the ACP server binds to. `src/acp/metadata.ts` ports
the request-metadata vocabulary (`editorContext`/`workspaceSpec`/
`requestMeta`), the namespace-precedence accessors (`requestWorkspace`/
`requestParentSessionID`/`requestEditorContext`/`requestSurface`),
`sessionModes`, `formatEditorContext`, and the byte-faithful `utf8Length`/
`utf8Prefix` helpers (Go's `len(string)`/`value[:n]` semantics).
`src/acp/input.ts` ports the prompt/input conversion that keeps the
"one input path" invariant: `promptToText`/`promptToRunInput` for text-only
callers, `promptToIngresses` (every declared block — text/image/audio/
resource/resource_link — normalized into the Runtime `InputIngress` contract),
`resolveACPResourcePath` (scheme/host/regular-file/workspace-confinement
checks), `localACPIngress`, `encodedACPIngress`, `acpAttachmentKind`, and the
raw-block-free `acpPromptRequestSnapshot`. `src/acp/wire.ts` ports the stdio
JSON-RPC transport: `ACPRPCRequest` with verbatim raw-id capture, an
`ACPLineReader` over an async byte source, `readRequest` (oversize/blank/parse
errors), `validRPCID` (the scalar domain, rejecting objects/arrays/booleans/
fractional and exponent forms), `writeMessage`/`writeACPResponse`/
`acpErrorEnvelope` with raw-id echo, the `session/update`/extension/reverse
notification writers, `ACPRequestIDCounter`, and the JSON top-level raw-field
scanner. `src/acp/support.ts` ports the deterministic server-support helpers:
`ACPStartupError` + `startupErrorFromDoctor`/`doctorStartupMessage`/
`classifyACPStartupError`/`isStartupError`/`writeACPStartupError` (secret-free),
the transcript cursors/paging (`encodeTranscriptCursor`/
`decodeTranscriptCursor`/`transcriptPageSize`/`transcriptPage`),
`replayMessageID`/`messageUpdates` (the persisted-transcript session updates),
the tool-title projection + `ToolTitleRegistry`, `normalizeStopReason`,
`acpConfigValue`, and the `elicitationRequestForQuestion`/`questionAnswer`
projections. `src/acp/extensions.ts` ports the pure additive extension
projections (`acpProjectResult`, `sessionListLastRun`, `formatRFC3339`,
`isZeroTime`). Deviations: `json.RawMessage` maps to raw JSON text for ids (and
to decoded `unknown` elsewhere), `time.Duration` to milliseconds,
`io.Writer` to an `ACPMessageSink`, and Go's `(value, error)` returns throw.
New translated/focused tests: `input_test.ts` (9, from `acp_artifact_test.go`
and `acp_mcp_test.go`), `metadata_test.ts` (3), `wire_test.ts` (8, from
`acp_mcp_test.go`'s oversize/valid-id cases), `support_test.ts` (8), and
`extensions_test.ts` (3). 30 new tests pass; full suite 1467 passed / 0 failed
(was 1437/0), architecture 8/8,
lint/check/fmt clean. Remaining #35 work is the ACP server itself (the stdio
loop that binds `readRequest`/`writeACPResponse` and dispatches to
`handleInitialize`/`handlePrompt`/`handleAgentEvent`, the session lifecycle,
decisions, artifacts, MCP sampling, and the `mothx/manage/*` extensions in
`acp.go`/`extensions.go`/`manage*.go`). Remaining backlog is #35's server +
management extensions, #36 `serve`, #37 `tui`, and #38 `cmd/mothx`→`src/cli`+
`src/main.ts`; #19's `examples/` stays blocked on the public-bootstrap/guard
decision and #22's remaining gaps (daemon/mcp/full chrome helpers) are out of
scope for the mothx `browser` tool.

A later run continued #35 (`internal/acp`) with the ACP server shell and the
server-bound half of the Phase 1 additive extensions. `src/acp/server.ts`
declares the `AcpServer` class (Go's `server` struct) and the per-session
`ACPSessionRuntime`/`ACPCacheUsage` state carriers together with every
server-bound method of this slice: the transport/notification glue
(`writeMessage`/`writeResponse`/`deliverResponse`/`deletePending`,
`notify`/`notifySessionInfo`/`notifyExtension`/`notifyRequest`,
`nextRequestID`/`readRequest`), the shared helpers (`artifactEnabled`/
`applyACPArtifactSetting`, `effectivePermissionTimeoutMs`/
`effectiveQuestionTimeoutMs`, `productVersion`/`acpInitialized`/`sessionRuntime`/
`sessionConfigOptions`/`mustJSON`, `resolveWorkspace`,
`setSessionAdditionalDirectories`/`withSessionMutationLease`), `handleInitialize`
(the negotiated workspace window, typed client capabilities, the full feature
list, and the session/prompt/MCP capabilities) and `handleDoctor`, plus the
§4.1–§4.8 extensions: `notifyRunStatus`/`notifyExternalRunStatus`/
`sessionListLastRun` (run status), `handleSetSessionMeta`/`notifySessionMetaInfo`/
`sessionListMetadata` and the `mothx/projects/*` handlers (session metadata and
projects), `handleWorkspaceExtend` (grow-only workspace window), the
`scheduleDecisionDeadline`/`emitDecisionDeadline` reminders,
`observeSubagentEvent`/`emitSubagentEvent`/`clearSubagentProjections`, and
`handleAttachmentList`/`attachmentService`/`replayGeneratedArtifacts`/
`attachmentFetchRPCError`. `src/acp/mod.ts` re-exports the new module.
Deviations: Go's `sync.Mutex`/`sync.Once` are dropped (Deno is single-threaded);
`io.Writer`/`*bufio.Reader` map to a synchronous `AcpServerSink` and the ported
`ACPLineReader`; `json.RawMessage` ids are carried as their raw JSON text;
`time.Duration` maps to milliseconds and `time.Time` to `Date`; the mutable Go
package vars `decisionDeadlineFirstNoticeCap`/`decisionDeadlineFinalNotice` are
projected as the exported mutable `acpDecisionDeadlineMarks` object because ESM
importers cannot reassign an imported `let`; `(value, error)` returns throw.
New translated/focused tests: `server_test.ts` (20: run-status/`session_event`,
`setSessionMeta` validation, project handler errors plus a create/list/rename/
delete round trip, workspace-extend validation/merge/dedup/cap and symlink
normalization, the three decision-deadline mark cases, subagent started/single-
terminal projection, attachment-list validation, the Phase 1 feature keys,
standard session lifecycle capabilities, typed client capabilities, duplicate-
`initialize` rejection, doctor without a session/cwd fallback/configured run
version/shared-response match, and relative-cwd rejection). 20 new tests pass
(73 in `src/acp`); full suite 1487 passed / 0 failed, architecture 8/8,
lint/check/fmt clean. Remaining #35 work is the stdio dispatch loop (`Run`), the
prompt run (`handlePrompt`/`handleCancel`/`handleCancelRequest` and the
admission/provider/tool-registry wiring), the agent-event projection
(`handleAgentEvent` with `emitUsageUpdate`/`streamMessageID`/`advanceStream
Segment`/`markTerminalNotified` and the `acpFailureInfo`/`acpFailureRPCError`
terminal contract), the session lifecycle handlers (`session/new`/`load`/
`resume`/`fork`/`close`/`delete`/`setTitle`/`setWorkDir`/history paging and the
`sessionRuntime`/`openSessionRuntime` wiring), MCP sampling, and the
`mothx/manage/*` plane (`manage.go`, `manage_serve.go`, `manage_knowledge
_bases.go`, `manage_skillhub*.go`, `manage_application.go`, `manage_experts.go`,
`manage_env.go`). Remaining backlog is #35's remainder, #36 `serve`, #37 `tui`,
and #38 `cmd/mothx`→`src/cli`+`src/main.ts`.

A later run continued #35 (`internal/acp`) with the session catalog and
lifecycle-mutation handlers. `src/acp/server.ts` gains `handleListSessions`
(`session/list`, scoped to the negotiated workspace roots),
`handleListAllSessions` + `filterGlobalSessionList` + `writeSessionList`
(`mothx/session/listAll`, with the `all`/`project`/`ungrouped` scopes, the
`query` search over id/title/cwd/project, offset cursor pagination, and the
additive `_meta` projection of `messageCount`/`pinned`/`projectId`/`lastRun`),
`handleSessionHistory` (the read-only transcript page over canonical session
messages), `handleCloseSession`/`closeSessionRuntime`/
`shutdownSessionRuntime`/`shutdownAllSessionRuntimes`/`sessionCascadeIDs`
(`session/close` cascading over persisted fork descendants via the shared
`session_runtime_leases` mutation boundary), `handleDeleteSession`
(`mothx/session/delete` + `session/delete` with grouped `acquireMutations` and
per-target `deleteSessionWithMutation`), `handleSetSessionTitle` and
`handleSetSessionWorkDir` (idle-session `setWorkDir` guarded by the canonical
durable run and the in-memory execution). It also ports the shared durable
decision plumbing the prompt/load slices reuse — `sessionRunID`,
`loadPersistedDecisionRecords`, `replayPendingDecisionRequests`,
`rehydrateSessionDecisions`, `registerDecision`, `resolveDecision`,
`clearSessionDecisions`/`clearSessionDecisionsForRuntime`, and
`persistDecisionRecord`/`persistDecisionRecordWithDeadline` — plus the
`acpFailureInfo`/`acpFailureRPCError` structured terminal contract and
`SessionProviderMismatchError`. `ACPSessionRuntime` gains `execution`,
`decisions`, and `closeResources`; `AcpServer` gains `providerName`/`m` and
replaces the raw `toolTitles` map with the ported `ToolTitleRegistry`. New
translated/focused tests: `session_lifecycle_test.ts` (11: workspace-scoped
listing and `_meta`, outside-window and invalid-cursor rejection, `listAll`
scope validation and query filtering, `setTitle` persistence + notification,
`setWorkDir` same-cwd/active-run/workspace/foreign-cwd branches, `session/close`
runtime shutdown + guard, `delete` active/idle/missing branches, transcript
history paging, the decision-ledger persist/replay/terminalize round trip, and
the failure-envelope projection). 11 new tests pass (84 in `src/acp`); full
suite 1498 passed / 0 failed (was 1487/0), architecture 8/8, lint/check/fmt
clean. Remaining #35 work is the stdio dispatch loop (`Run`) and its method
switch, the prompt run (`handlePrompt`/`handleCancel`/`handleCancelRequest` and
the admission/provider/tool-registry wiring plus `newToolRegistry`/
`configureSessionBindings`/`configureSessionCapabilities`/
`registerTeamExpertTools`), `session/new`/`load`/`resume`/`fork` with
`openSessionRuntime`/`installSessionRuntime` and the provider catalog,
`session/set_config_option`/`set_mode`, the agent-event projection
(`handleAgentEvent` with `emitUsageUpdate`/`streamMessageID`/
`advanceStreamSegment`/`markTerminalNotified`), MCP sampling, and the
`mothx/manage/*` plane (`manage.go`, `manage_serve.go`,
`manage_knowledge_bases.go`, `manage_skillhub*.go`, `manage_application.go`,
`manage_experts.go`, `manage_env.go`). Remaining backlog is #35's remainder,
#36 `serve`, #37 `tui`, and #38 `cmd/mothx`→`src/cli`+`src/main.ts`; #19's
`examples/` stays blocked on the public-bootstrap/guard decision.

A later run continued #35 (`internal/acp`) with the session-establishing slice
and the MCP callbacks it needs. `src/acp/server.ts` gains the provider catalog
and per-session resource assembly (`providerFor`, `newToolRegistry`,
`registerTeamExpertTools`, `refreshSessionExpertTools`,
`configureSessionBindings`, `configureSessionCapabilities`,
`newSessionExecution`, `openSessionRuntime`, `installSessionRuntime`), the
session lifecycle handlers (`handleNewSession`,
`handleDraftConfigOptions`, `handleLoadSession`, `handleResumeSession`,
`handleForkSession`/`completeForkSession` and the
`sessionOpenResult` projection that reproduces Go's `omitempty` result),
`handleSetConfigOption` with the `thought_level`/`web-search` aliases and the
expert refresh, `handleSetMode`, the available-command catalog
(`availableCommands`/`availableCommandsFor`/`notifyAvailableCommands`/
`notifyAvailableCommandsFor`) with the Desktop
`/<skill>`/`/skill <name>`/`/skill:<name>` recognition in
`activateSkillPrompt`, the transcript projection helpers (`emitMessage`,
`projectInitialTranscript`), and the MCP callbacks
(`buildMCPCallbacks`, `handleMCPNotification`, the sampled-completion
`handleMCPSamplingCreateMessage` with `extractSamplingInput`/`parseJSONMap`).
The module also ports the request decoders
(`decodeNewSessionRequest`/`decodeLoadSessionRequest`/
`decodeResumeSessionRequest`/`decodeForkSessionRequest`/
`decodeSetConfigOptionRequest`/`decodeSetModeRequest`/
`decodeDraftConfigOptionsRequest`) and the
`persistedSessionUsage`/`runtimeModelOf`/`createACPProvider`/
`safeDeleteSession`/`parseBoolean` helpers. Deviations: handlers that open a
runtime are async because `AttachSessionResources`/`ConnectConfiguredMCP` are
async, `withSessionMutationLeaseAsync` is the async sibling of the existing
lease helper, `activateSkillPrompt` is async (its Runtime refresh is async),
`ProviderCatalog` iteration uses the insertion-ordered object, a missing
`requestId` falls back to the raw request-id text as Go does with `string(ID)`,
and the `retry-*`/subagent fields stay in their own slices. New
translated/focused tests: `session_open_test.ts` (25 cases: session/new modes and
validation, load/resume/fork success and their cwd/provider guards, set_mode
and set_config_option validation plus the success paths, draft-config-options,
the available-command catalog and skill recognition, the MCP notification
projection/dedup, and sampling admission). 25 new tests pass (109 in
`src/acp`); full suite 1523 passed / 0 failed, architecture 8/8, lint/check/fmt
clean. Remaining #35 work is the stdio dispatch loop (`Run`) and its method
switch, the prompt run (`handlePrompt`/`handleCancel`/`handleCancelRequest` and
the admission/provider/tool-registry wiring), the agent-event projection
(`handleAgentEvent` with `emitUsageUpdate`/`streamMessageID`/
`advanceStreamSegment`/`markTerminalNotified`), and the `mothx/manage/*` plane
(`manage.go`, `manage_serve.go`, `manage_knowledge_bases.go`,
`manage_skillhub*.go`, `manage_application.go`, `manage_experts.go`,
`manage_env.go`). Remaining backlog is #35's remainder, #36 `serve`, #37 `tui`,
and #38 `cmd/mothx`→`src/cli`+`src/main.ts`; #19's `examples/` stays blocked on
the public-bootstrap/guard decision.

A later run continued #35 (`internal/acp`) with the agent-event projection and
the prompt admission/cancellation fence. `src/acp/server.ts` gains the single
adaptor projection of the canonical Agent event vocabulary
(`handleAgentEvent`: hosted-item updates, streamed text/thought chunks,
tool-call/execution start/update/end with structured diff and image content,
plan updates, cumulative usage, the structured terminal contract for
`EventError`/`EventRunFinished` with the cancelled/incomplete classification,
retry/status/compaction/turn extension events, and the child-agent split that
routes child lifecycle through the additive subagent projection without
mutating parent run facts) plus its state helpers
(`emitUsageUpdate`/`streamMessageID`/`advanceStreamSegment`/
`markTerminalNotified`, the module-level `usageContext`/`goSprint` helpers, and
a null-tolerant `runtimeModelOf`). It also ports the prompt-admission fence
(`acquirePromptAdmission`, mapping any admission failure to the typed
`ACPActiveSessionRunError` and rejecting a locally active run) and the cancel
paths (`handleCancel` over the session `execution`/`cancel` handles,
`handleCancelRequest` matching the admitted `promptID` and releasing any
pending reverse request with a cancelled outcome, and the
`decodeCancelRequest` decoder). `ACPSessionRuntime` gains the `activeModel`
and `cancel` state carriers. Deviations: Go's `context.Canceled` maps to a
`DOMException("AbortError")` fed to `classifyError`, Go's `fmt.Sprint` of the
tool-update partial result is approximated by the local `goSprint`, and
`acquirePromptAdmission` is async because the shared admission path is async.
New translated/focused tests: `agent_event_test.ts` (13: tool-result image
projection, the tool-boundary message-ID split, plan/status/retry/hosted-item
projections, structured diffs with the explicit null `oldText`, shared stream
IDs, the cumulative usage/cache baseline from persisted history, and the
terminal/single-terminal/child-terminal contract) and `cancel_test.ts` (6: the
matching-prompt cancel, pending-request release, invalid/unknown session
errors, the session cancel handle, and the admission fence/reacquire). 19 new
tests pass (128 in `src/acp`); full suite 1542 passed / 0 failed (was 1523/0),
architecture 8/8, lint/check/fmt clean. Remaining #35 work is the stdio
dispatch loop (`Run`) and its method switch, the prompt run (`handlePrompt`
with the admission/provider/tool-registry/durable-claim wiring), and the
`mothx/manage/*` plane (`manage.go`, `manage_serve.go`,
`manage_knowledge_bases.go`, `manage_skillhub*.go`, `manage_application.go`,
`manage_experts.go`, `manage_env.go`). Remaining backlog is #35's remainder,
#36 `serve`, #37 `tui`, and #38 `cmd/mothx`→`src/cli`+`src/main.ts`; #19's
`examples/` stays blocked on the public-bootstrap/guard decision.

A later run continued #35 (`internal/acp`) with the prompt run and the Agent
approval/question projection. `src/acp/server.ts` gains `handlePrompt`: the
`session/prompt` decoder (`decodePromptRequest`, including the additive
`knowledgeBaseRefs` input contract), the workspace/lineage validation, the
`promptToIngresses` normalization into the Runtime input contract, the
`/systeminit` expansion, the shared `ResolvePolicy` run source/mode
resolution, the prompt-admission fence, the durable-claim admission
(`beginIntentDurable` over an `ExecutionIntent` + canonical `DurableRun` +
`started` event), the artifact collector observer (`artifactSessionUpdate`
notifications), the per-session run state carriers, the `Runtime`
`buildAgent` construction, and the background canonical event loop: it feeds
every event to `ExecutionRuntime.observeAgentEvent`, projects it through
`handleAgentEvent`, routes child events away from the parent terminal facts,
maps `EventRunFinished`/`EventDone`/`EventError` to the ACP `stopReason` and
run state, and terminalizes with `finishDurableWithRetry` plus the additive
`run_status` event. The module also ports the approval/question reverse
requests: `requestQuestion` (standard-form elicitation when advertised,
otherwise the pre-v1 extension; shared pending store and DecisionService),
`requestPermission`/`requestPermissionContext` (the `allow-once` decision),
`handleQuestion` (the wait/resume fence), `manageKnowledgeBaseRPCError`, the
module-level `esmSteeringMessages` (the persisted ESM objective steering
source), and the `racePendingRequest`/`makeDurableRun`/`makeRunEvent`
helpers. `ACPSessionRuntime` gains the `agent`/`activeThinking` carriers, and
the shared approval-handler contract is widened to
`boolean | Promise<boolean>` in `src/agent/agent.ts`,
`src/agentruntime/session_runtime.ts`, and `src/agent/factory.ts` so an
adapter whose approval round trip is asynchronous can await it (Go's blocking
handler ran on the run goroutine). New translated/focused tests:
`prompt_test.ts` (13: ESM steering injects-once/absent, question selection,
non-option answer, `$/cancel_request` release, run-abort cancellation,
permission allow/deny/timeout, malformed-params and unknown-session
rejection, empty-prompt rejection, the completed-turn stream with cleanup,
the second-concurrent-prompt fence, and the missing-terminal-stream failure).
13 new tests pass (141 in `src/acp`); full suite 1555 passed / 0 failed (was
1542/0), architecture 8/8, lint/fmt/check clean. Remaining #35 work is the
stdio dispatch loop (`Run`) and its method switch (including the `initialize`
gate, `mothx/manage/*` routing, lease/database watch subscriptions, recovery
coordinator startup, and provider/sandbox/skills bootstrap) and the
`mothx/manage/*` plane (`manage.go`, `manage_serve.go`,
`manage_knowledge_bases.go`, `manage_skillhub*.go`, `manage_application.go`,
`manage_experts.go`, `manage_env.go`). Remaining backlog is #35's remainder,
#36 `serve`, #37 `tui`, and #38 `cmd/mothx`→`src/cli`+`src/main.ts`; #19's
`examples/` stays blocked on the public-bootstrap/guard decision.

A later run continued #35 (`internal/acp`) with the first slice of the
`mothx/manage/*` management plane. `src/acp/manage.ts` ports the shared,
`internal/serve`-independent manage helpers from `manage.go`
(`manageSettings`/`manageWorkDir`, the `manageSecretUsable`/`manageMaskSecret`/
`manageRedactSecrets` secret-safety projections now using the shared
`config.resolveKey`/`resolveImageGenerationToken`, `manageRawGlobalSettings`/
`manageMergeRawObject` over the shared `config.globalSettingsPath`/
`saveGlobalSettingsPatch` boundary, the `manageDecodeOptionalString`/
`manageDecodeOptionalBool`/`manageDecodeWhitelist` validators, and the
`manageAllowedModes` vocabulary) together with the `handleManageRequest`
router. It also ports three management families end to end:
`mothx/manage/env/*` (`manage_env.go`: the sorted, value-free env view and the
atomic set/unset patch with the `env_field_not_allowed`/`env_field_invalid`/
`env_name_invalid`/`env_name_duplicate`/`env_name_conflict`/`env_save_failed`
error contract), `mothx/manage/experts/*` (`manage_experts.go`: the default
global / explicit project scope resolution through the shared
`expert.Manager`, with the `expert_invalid_request` projection), and
`mothx/manage/application/*` (`manage_application.go`: the secret-safe
Runtime-owned settings view and the whitelisted section patch that merges
through `config.saveGlobalSettingsPatch`, including the per-field
`application_field_invalid`/`application_section_not_allowed` validation).
`src/acp/mod.ts` re-exports the module, and `acpStructuredRPCError`'s optional
`extra` argument now accepts `null` (matching the Go nil map) so the handlers
can project a dataless structured error. Deviations: `json.RawMessage` params
and values are already-decoded JSON, so the whitelist/validators inspect typed
values rather than raw bytes, and Go's `*mcp.RPCError` returns become thrown
`RPCError`s projected by the handlers. A named migration bridge (owner #35,
removal condition: the `manage.go` / `manage_serve.go` / `manage_skillhub*.go`
/ `manage_knowledge_bases.go` slices land) routes the recognized-but-unported
families to the structured `manage_method_unavailable` error while truly
unknown methods keep `manage_method_not_found`. New translated/focused tests:
`manage_test.ts` (15: the env view/patch/rejection/secret-leak cases from
`manage_env_test.go`, the global/project expert CRUD and builtin-scope
rejection from `manage_experts_test.go`, the application view/patch/validation
cases from `acp_manage_test.go`, the router's unported/unknown families, and
the advertised manage feature keys). 15 new tests pass (156 in `src/acp`); full
suite 1570 passed / 0 failed (was 1555/0), architecture 8/8, lint/check/fmt
clean. Remaining #35 work is the stdio dispatch loop (`Run`) and its method
switch, the settings/providers/skills/mcp/cron/stats/memory/deliveries manage
families (`manage.go`), the serve/channels config families
(`manage_serve.go`), the SkillHub families (`manage_skillhub*.go`), and the
knowledge-base families (`manage_knowledge_bases.go`). Remaining backlog is
#35's remainder, #36 `serve`, #37 `tui`, and #38 `cmd/mothx`→`src/cli`+
`src/main.ts`; #19's `examples/` stays blocked on the public-bootstrap/guard
decision.

A later run continued #35 (`internal/acp`) with the settings and providers
management families of the `mothx/manage/*` plane. `src/acp/manage.ts` gains
the shared settings/providers helpers and handlers from `manage.go`:
`manageSettingsPatchFields`/`manageAllowedThinkingLevels`, `manageMaskedKey`,
the secret-safe provider projections (`manageProjectModelConfig` /
`manageProjectProviderConfig`, `manageProviderViews`, `manageProviderConfigs`),
`manageSettingsView`, and the `mothx/manage/settings/get` / `settings/patch`
handlers (the strict whitelist patch merging scalars and the
`providers`/`sandbox`/`webSearch` objects at the raw-object level through
`config.saveGlobalSettingsPatch`, with the `settings_field_not_allowed` /
`settings_field_invalid` / `settings_save_failed` contract). It also ports the
`mothx/manage/providers/*` family: `providers/list` (the factory-resolved
provider catalog plus `providerConfigs` and the shared model catalog via
`providerfactory.resolvedModels`/`sortProviderIDs`), `providers/save` (create /
update / rename with the `provider_field_not_allowed` /
`provider_save_failed` / `provider_not_found` contract and secret-header
preservation), `providers/delete` (`provider_default_in_use` /
`provider_not_custom`), `providers/discover` (the provider-owned
`provider.discoverModels` draft path, `provider_discovery_failed`), and
`providers/test` (the 1-token ping through `providerfactory.create`, with
`provider_not_found` / `provider_test_failed` and redacted errors).
`src/serve/config.ts` gains the first partial #36 slice the settings view needs:
a memory-focused `loadConfig`/`memoryEnabled` reading the global then project
`serve.json` memory section with the channels default enabled, so
`manageMemoryEnabled` no longer needs the unported serve runtime. The router now
dispatches the settings/providers families (async discovery/test fire-and-forget
the same way the Go blocking handlers return) and `isUnportedManageMethod` drops
them. New translated tests in `manage_test.ts` (6: settings get masking,
settings patch whitelist round-trip and rejection table, providers catalog,
providers save/delete/discover with an in-process `Deno.serve` `/v1/models`
stub, and the providers test structured paths) replace the former
settings/get-unavailable router assertion with the still-unported
`mothx/manage/skills/list`. 6 new tests pass (162 in `src/acp`); full suite 1576
passed / 0 failed (was 1570/0), architecture 8/8, lint/check/fmt clean.
Remaining #35 work is the stdio dispatch loop (`Run`) and its method switch, the
remaining `manage.go` families (skills, mcp, cron, stats, memory, deliveries),
the serve/channels config families (`manage_serve.go` + the #36 serve Config
schema), the SkillHub families (`manage_skillhub*.go`), and the knowledge-base
families (`manage_knowledge_bases.go`). Remaining backlog is #35's remainder,
#36 `serve`, #37 `tui`, and #38 `cmd/mothx`→`src/cli`+`src/main.ts`; #19's
`examples/` stays blocked on the public-bootstrap/guard decision.

A later run continued #35 (`internal/acp`) with the remaining
`internal/serve`-independent `manage.go` families. `src/acp/manage.ts` gains
`mothx/manage/skills/list` + `skills/set` (the shared `skills.Manager` built
through `newManagerWithProjectDirs(getGlobalSkillsDir(settings), projectSkillDirs(cwd))`,
with the `skills_unavailable`/`skill_not_found` contract, the sparse
`settings.skills.disabled` patch that drops the section when empty, and the
live `skillsMgr.setDisabledSkills` re-apply), `mothx/manage/mcp/list` +
`mcp/set` (the complete local mcp.json projection including env/headers, the
global/project scope resolver over the active session work dir, the
`mcp_field_not_allowed`/`mcp_server_invalid`/`mcp_scope_invalid` contract, and
the transport-normalize-then-validate replace/merge flow),
`mothx/manage/stats/summary` + `stats/timeseries` (the shared
`stats.parseQueryParams` mapping with the RFC3339 additive fallback and
`stats_group_invalid`/`stats_time_invalid` validation, the missing-database
empty projection, and the `listAllDetailed` session count),
`mothx/manage/memory/get` + `memory/put` (the serve-config explicit
`memory.path` fallback to the global `memory.md`, the 1 MiB `memory_too_large`
cap, and the updated-at projection), and `mothx/manage/deliveries/list` +
`deliveries/retry` (the session outbox projection with the canonical
`deliveryFailureRetryable` flag and the
`delivery_not_found`/`delivery_not_reopenable`/`delivery_not_retryable`
operator fences). `manageStatsQuery` is exported for the translated unit case.
The router dispatches the five families and `isUnportedManageMethod` drops
them. New translated tests in `manage_test.ts` (10: skills list/set round trip,
mcp list/set/project-scope, the stats query mapping table, memory round
trip/limit and serve-config path, and the deliveries list/retry/refusal matrix
backed by a real session delivery outbox) add a documented
`legacyTestAllowlist` entry for `src/acp/manage_test.ts` because the delivery
plan validates that its Run belongs to the session, so the fixture seeds one
completed Run exactly like the Go `manage_delivery_test.go`. 10 new tests pass
(172 in `src/acp`); full suite 1586 passed / 0 failed (was 1576/0),
architecture 8/8, lint/check/fmt clean. Remaining #35 work is the stdio
dispatch loop (`Run`) and its method switch, the `cron` family (blocked on the
knowledge-base schedule sync + agent-manager construction in
`ensureManageCron`), the serve/channels config families (`manage_serve.go` +
the #36 serve Config schema), the SkillHub families (`manage_skillhub*.go`),
and the knowledge-base families (`manage_knowledge_bases.go`). Remaining
backlog is #35's remainder, #36 `serve`, #37 `tui`, and #38
`cmd/mothx`→`src/cli`+`src/main.ts`; #19's `examples/` stays blocked on the
public-bootstrap/guard decision.


A later run completed the remaining Phase 3 `mothx/manage/*` families of #35
(`internal/acp`): the knowledge-base, cron, serve, and channels planes.

`src/acp/manage_knowledge_bases.ts` (new) ports `manage_knowledge_bases.go`
plus the knowledge-schedule projection and the in-process cron runtime from
`manage.go`: the process-wide cached `KnowledgeBaseService` getter, the
`knowledge-bases/list|get|create|update|delete|scan|status|query|mcp/apply`
handlers, the `normalizeKnowledgeBaseSchedule` hourly/daily/weekly/monthly +
raw-cron vocabulary, the namespaced `knowledge-base-index:<id>` cron
projection (`syncKnowledgeBaseSchedule*`, `removeKnowledgeBaseSchedule`,
`syncAllKnowledgeBaseSchedulesWithStore`), `ensureManageCron` (shared
`SQLiteCronStore` + canonical `newAgentManager` construction +
`newSchedulerWithSessionDir` with the Runtime knowledge-job handler and
maintenance policy + offline reconciliation), the `cron/list|create|update|
remove|run` handlers, the `cron_completed` session-event observer, and the
canonical `knowledge-<id>` stdio MCP quick-add (`knowledge-mcp serve
--knowledge-base`, derived from `Deno.execPath()` with the `mothx`
fallback). `AcpServer` gains the `cronScheduler`/`cronStore`/`cronAgentMgr`/
`knowledgeService` fields (Go's mutex guards drop on the single-threaded event
loop). Deviations: scans stay background jobs admitted through
`service.startIndex`; `MOTHX_ACP_CRON_INTERVAL` parses Go-duration syntax.

`src/serve/config.ts` is extended from the doctor/memory-only slice to the
full `serve.Config` schema (port of `serve/config.go`, `config_schema.go`,
`config_mapping.go`): typed sections (api/features/channels/webUI/cron/memory/
security/hooks/agent), the legacy top-level overlay, snake_case + camelCase
channel/agent wire compatibility, `normalize`, canonical camelCase
serialization (`serializeConfig`, the Go custom `MarshalJSON`), and
`loadConfig`/`loadConfigFrom`/`saveServeConfig`; the memory-focused
`loadConfig`/`memoryEnabled`/`defaultConfig` surface is preserved.

`src/acp/manage_serve.ts` (new) ports `manage_serve.go`: the secret-free
`serve/get` view and strict whitelist `serve/patch` (api/features/webUI/cron/
memory/security/agent/lobsterMode, linked feature toggles, bounded ints/floats,
mode/thinking/log-level/tool-visibility/system-prompt vocabulary, nested
session/toolVisibility validation), plus `channels/get` + `channels/patch`
with write-only credential flags (`credentialConfigured`, `appIDConfigured`,
`appSecretConfigured`), the set/clear mutual-exclusion fence, and the
credential-free saved projection. The router in `manage.ts` dispatches every
remaining family; `isUnportedManageMethod`/`manage_method_unavailable` is
removed (all recognized methods now route; unknown methods keep
`manage_method_not_found`).

Tests: new `manage_knowledge_bases_test.ts` (6: schedule normalization,
cron-store create/update/delete projection, MCP quick-add/disable/missing
matrix, CRUD + scan-admission + validation matrix, query clamps, cron
prerequisite structured errors) and `manage_serve_test.ts` (5: secret-free
GET, patch round-trip that preserves auth tokens, the 15-case unsafe/invalid
rejection table, api.session projection/validation, channels credential-safe
view + patch + clear-fence). The router-unavailable test in
`manage_test.ts` becomes the unknown-method assertion. 191 tests pass in
`src/acp` (was 172); full suite 1605 passed / 0 failed, architecture 8/8,
lint/check/fmt clean. Remaining #35 work is only the stdio dispatch loop
(`Run`, deferred `stopManageCron`) and its method switch; #36 `serve` now has
its config layer but keeps the HTTP runtime pending; #37 `tui` and #38
`cmd/mothx`→`src/cli`+`src/main.ts` remain; #19 `examples/` stays blocked on
the public-bootstrap/guard decision.


A follow-up run completed the last Go-side slice of #35: the stdio dispatch
loop and startup assembly (`internal/acp/acp.go` `Run`).

`src/acp/run.ts` (new) ports `Run`, `resolveACPModelSelection`,
`resolveACPProviderSelection`, the request method switch, and the previously
unported `handleAttachmentFetch`. `runACP(options, transport)` performs the
documented startup order: cwd stat preflight (`cwd_invalid`
`ACPStartupError`), `loadSettingsFor` preflight (`config_invalid`), the
`HARBOR_ACP_REQUESTED_MODEL` qualified override with fail-closed provider/model
conflict checks, doctor `validateProvider` projected through
`startupErrorFromDoctor` so the host sees the same code/fix/message as the Go
`MOTHX_ACP_ERROR` line, the lease-first `RecoveryCoordinator` start (bounded
abort on unwind), `subscribeRuntimeLeaseNotifications` →
`notifyExternalRunStatus`, `watchDatabaseRebuilds`, the complete provider
catalog via `createWithOptions` (unusable providers logged and skipped),
sandbox manager (`settings.sandbox` → `sandboxSettingsOptions`, strict/standard
`Level`, `Level.None` when disabled, fallback warning), shared
`loadContextResources`, the process-wide `SessionRuntime`
(`SourceACP`), the optional canonical `newAgentManager` (multiAgent/delegate/
workflows), lazy `ensureManageCron` schedule reconciliation, and LIFO cleanup
(stopManageCron → shutdownAllSessionRuntimes → database watch → lease watch →
recovery coordinator).

The dispatch loop ports the framing rules verbatim: newline JSON over
`ACPLineReader(Deno.stdin.readable)` + synchronous stdout sink, blank-line
tolerance (`EmptyMessageError`), `-32700` parse errors with null id,
`validRPCID`/jsonrpc 2.0 gate (invalid booleans/objects/arrays echoed with null
id), initialize-first `-32600`, raw-id reverse-response delivery
(`deliverResponse`), EOF shutdown, the full ACP/extension method switch
(session/new|load|resume|fork|prompt|cancel|close, mothx session history/meta/
title/workdir/projects/workspace/attachment/list, list/listAll,
set_config_option/set_mode, `$/cancel_request`, mothx/doctor), `mothx/manage/*`
delegation to `handleManageRequest`, and `-32601` for unknown methods. The
missing `mothx/attachment/fetch` extension now streams the Runtime-owned
`AttachmentService.Open` bytes as base64 with a 10 MiB fetch bound, integrity
expiry/not-found classification (`attachment_not_found`/`attachment_expired`/
`attachment_too_large`/`attachment_unavailable`); `run.ts` is re-exported
from `src/acp/mod.ts`.

Tests: new `src/acp/run_test.ts` (8): qualified override adoption + conflict
matrix + unqualified rejection, settings default fallback, the framing/gate
table (initialize-first, wrong jsonrpc, blank line, parse error, invalid
boolean id, unknown manage/method codes, notifications), raw-id reverse
delivery, attachment/fetch parameter and unavailable structured errors, and a
real `runACP` startup rejection asserting the classified `MOTHX_ACP_ERROR`
line for an unconfigured provider with zero JSON-RPC output. Full suite 1613
passed / 0 failed (was 1605; +8), architecture 8/8, lint/check/fmt clean.
#35's production surface is now fully ported; remaining work is the
subprocess-style integration tests (they spawn the compiled `mothx acp`
binary, which lands with the #38 `acp` CLI command wiring into `src/cli` +
`src/main.ts`). #36 `serve` keeps its HTTP runtime pending; #37 `tui` and #38
`cmd/mothx` follow; #19 `examples/` stays blocked on the
public-bootstrap/guard decision.

### Ledger entry — `cmd/mothx` → `src/cli` + `src/main.ts` (backlog #38, ACP/doctor/knowledge-mcp slice)

The Deno process entry point now exists: thin `src/main.ts` wrapper over the
Cliffy tree in `src/cli/command.ts` (`newRootCommand`, `newACPCommand`, plus
`doctor` and `knowledge-mcp serve`), with `src/cli/options.ts` owning the
shared `CLIOptions` surface (root session/provider/capability flags and the
ACP `--permission-timeout`/`--question-timeout` Go-duration flags).
`parseGoDurationMs` accepts the `ns/us/µs/ms/s/m/h` subset (decimal allowed)
and `resolveACPTimeout` keeps Go's flag-wins-over-`MOTHX_ACP_*_TIMEOUT`
resolution, falling through invalid/zero values; `acpRunOptions` maps flags
into the #35 `RunOptions` contract, and startup errors exit 1 after printing
the classified `MOTHX_ACP_ERROR` line via the shared `isStartupError` guard.
`src/cli/doctor.ts` projects the existing diagnostics in human/JSON form
(port of `main_doctor.go`), and `src/cli/knowledge_mcp.ts` serves the
Runtime-owned `KnowledgeMCPHandler` over stdio with session-dir defaulting
and SIGINT/SIGTERM/EOF lifetime. `serve`/`a2a`/`stats`/`cron`/`speedtest` and
the interactive root action stay registered as explicit pending commands
(slices #36/#37) so the Go CLI surface and help output remain stable; no
adapter-local runtime logic was added.

Tests: `src/cli/cli_test.ts` (8) covers duration parsing, flag/env timeout
precedence, flag→RunOptions mapping, doctor JSON/human projection, command
tree registration, pending-command slice hints, and the
`knowledge-mcp serve` empty-list guard. `src/cli/run_process_test.ts` (4)
spawns `deno run -A src/main.ts acp` as a real subprocess in a temp
`MOTHX_DIR`: the initialize NDJSON handshake (envelope-or-structured-error),
initialize-first `-32600`, EOF shutdown after initialize + `mothx/doctor`,
and the `acp --help` flags. Full suite 1625 passed / 0 failed (was 1613;
+12), architecture 8/8, lint/check/fmt clean. Remaining #38 work: the root
TUI/print actions (#37), serve/a2a/stats/cron/speedtest bodies (#36), and
`stopManageCron` process-shutdown wiring once those entry points exist.

### Ledger entry — `internal/serve` runtime foundation (backlog #36, slice 1: config state + HTTP bootstrap)

The serve runtime now boots. `src/serve/options.ts` ports the pure option
surface from `run.go`/`openaiapi/config.go`: `RunOptions`, `applyOverrides`
(ephemeral CLI flags, never persisted), `applyRuntimeFeatures` (feature flags
projected onto channels/WebUI/cron/memory/subagents), `listenFromPortOverride`,
`displayListenAddr`, `useEmbeddedWebUI`, and the `--unsafe` auth-off +
loopback→`0.0.0.0` rewrite (`unsafeListenAddr`, including IPv4 127/8 and
`[::1]`). `src/serve/config_state.ts` ports `config_state.go` in full:
`ServeConfigState.load/reload/snapshot/updateChannel/updateFull`, the global/
project/explicit layer resolution, whitelist-validated channel merge patches
(wechat: enabled/credPath/workDir/autoTyping; feishu: enabled/appId/appSecret/
workDir with appSecret masked in the effective view), 0600 temp-file + rename
atomic writes (`atomicWritePrivateFile`), apply-failure file rollback, and
`stripRunOverrides` so full-config PUTs cannot persist CLI-only values.

`src/serve/http.ts` owns the agent-free HTTP projections: `buildServeStatus`/
`featureStatusFromConfig` (the `/api/status` feature matrix, settings-level
webSearch OR), `writeJson`, the SPA Web UI handler (`createWebUIHandler`:
disk or injected embedded assets, content-type table, index.html client-route
fallback, traversal-safe `safeRelativePath` segment walk, 503 when the
frontend is unbuilt), and `resolveWebUIDir` (cwd → exe-adjacent → share path).
`src/serve/server.ts` adds the first real listener: `createServeRouter`
(`/api/status` GET + 405, Web UI, 404 when disabled), `parseListenAddr`,
`startServeHttp` (Deno.serve with abort/shutdown and ephemeral-port
`onListen`), and `runServe` with the startup banner printed from the actually
bound address. The CLI `serve` subcommand is wired in `src/cli/command.ts`
with the full Go flag set (`--config/--port/--webui-dir/--provider/--model/
--work-dir/--unsafe/--sandbox/--multi-agent/--delegate/--workflows/
--web-search/--browser/--artifact/--a2a-master/--lobster/--verbose/--debug`).
This slice also fixed a real cross-command bug: Cliffy 1.3 invokes option
actions with a single parsed-flags object, so the earlier two-argument
`(_, value)` actions never fired (ACP/root value flags were silently
ignored); all commands now use `stringSetter`/`boolSetter` reading
`flags[camelCaseName]`, verified end-to-end against a live `mothx acp`
initialize handshake and a live `mothx serve --port 0` HTTP process.

Tests: `config_state_test.ts` (14), `http_test.ts` (7), `server_test.ts` (4,
including a real ephemeral-port Deno.serve), CLI `serve_process_test.ts` (1,
spawns `deno run src/main.ts serve` and reads the bound port from the banner),
plus the prior 12 CLI tests. Full suite 1651 passed / 0 failed (was 1625;
+26), architecture 8/8, lint/check/fmt clean. Remaining #36 work: the
OpenAI-compatible chat completions/SSE core in `openaiapi/` (~27k LoC Go),
session/run management routes, the messaging channel dispatcher
(channels/wechat/feishu), cron/delivery/hooks/webhook, and the remaining
management HTTP handlers.

### Ledger entry — `cmd/mothx` remaining commands (backlog #38: stats/a2a/speedtest)

Migrated the three remaining leaf subcommands from `cmd/mothx` (Go source of
truth) onto the existing TS runtimes; the CLI tree now carries no pending
placeholders except `cron` (#36) and the root TUI/print action (#37).

- `src/cli/stats.ts` — ported `main_stats.go`: `executeStatsCommand` runs the
  dashboard server (`src/stats/server.ts`) or the terminal tables;
  `printStatsCLI` reproduces the `text/tabwriter` projection (summary, By
  Provider with `vendor (protocol)` labeling, By Model, Recent Requests) with
  a deterministic column aligner; `openStatsDB` wraps `DB.open` errors as
  `open stats database: ...`; best-effort cross-platform browser opener
  (`open`/`rundll32`/`xdg-open`/`gio`/`sensible-browser`) that never fails
  the command. Added `Server.finished()` to `src/stats/server.ts` so the
  process can block on the dashboard listener like Go's `server.Serve`.
- `src/cli/a2a.ts` + `src/a2a/config.ts` — ported `main_a2a.go` config/status
  surface: `loadConfig` (JSON parse + field-by-field validation, defaults when
  the file is absent), `resolveA2AConfig` (global → project `.mothx/a2a.json`
  overlay → CLI `--port/--work-dir/--auth-token` overrides),
  `executeA2AInit` (--init-a2a-config [--force], template = DefaultConfig +
  placeholder token/work_dir/agent-card per Go `InitA2AConfig` L82–104),
  and `executeA2AStatus` (2s-timeout agent-card probe with injectable
  `fetchImpl`). `mothx a2a start` intentionally remains a `ValidationError`:
  it needs a Runtime agent factory bridge (Go `simpleAgentFactory` builds a
  transient `SessionRuntime` agent per task); wiring it through
  `agentruntime` is the next a2a slice, not an adapter-local assembler.
- `src/cli/speedtest.ts` — full port of `main_speedtest.go` (~470 LoC Go):
  flag validation with Go error strings, `parseSpeedtestThinkingLevel`,
  `collectSpeedtestTargets` (configured-credential filter incl. `${VAR}`
  placeholder rejection, provider/model filters, default-model fallback,
  provider+model sort), per-target `runs` loop with AbortSignal timeout,
  `runSpeedtestRequest` (text/think first-token latency, usage-or-estimated
  tokens via the words-vs-runes/4 heuristic, tokens/s over generation
  window), `averageSpeedtestResults`, stable sort (success first, rate desc,
  provider/model asc), and the aligned results table. Providers come from
  `src/provider/factory` `createWithOptions` (requireModel) — no local
  provider construction. Network-latency TCP probing is deferred (injected
  `measureNetwork`, defaults 0) because it is cosmetic and untestable
  offline; the Go default prints real RTTs.
- Command tree: `newStatsCommand`, `newA2ACommand` (init/status/stop + flags;
  `stop` still rejects — the TS server writes no PID file),
  `newSpeedtestCommand` (`-p/-m/--prompt/--max-tokens/--timeout/--concurrency/--runs/-t`)
  with a minimal Go-duration parser for `--timeout` (ms/s/m/h).
- Tests: `src/cli/stats_test.ts` (5), `src/cli/a2a_test.ts` (6, async-safe
  MOTHX_DIR env helper), `src/cli/speedtest_test.ts` (11, fake provider over
  `AsyncIterable<StreamEvent>` — no network). CLI suite now 35 tests; full
  suite 1673 passed / 0 failed, architecture 8/8, lint/check/fmt clean.
- Remaining #38/#36/#37: `a2a start` runtime factory bridge, `cron`, root
  TUI/print action, and the #37 TUI migration (bubbletea → Ink).

### Ledger entry — `internal/tui` pure layers (backlog #37, slice 1: command specs + formatters)

Started the #37 TUI migration with the protocol-stable pure layers; the Ink
component and agent-event slices build on these without rework.

- `src/tui/command_specs.ts` — ported `command_specs.go` verbatim: all 33
  slash-command specs in Go declaration order with English usage strings
  (protocol text, never localized) and the exact i18n message IDs from
  `internal/tui/i18n/commands.go` (`commands.<name>.description`, including
  `default_model`/`paste_image`/`init_mcp` underscores); plus the
  `handleCommand` dispatch prologue from `commands.go` as pure functions:
  `splitFields` (Go `strings.Fields`), `parseInputLine` (`/skill:<name>`
  skill form, slash commands, plain text), `findCommandSpec`, and
  `isKnownCommand`. The Go App owns unknown-command errors; the parser only
  normalizes.
- `src/tui/formatters.ts` — ported the pure helpers of `formatters.go`:
  `displayWidth` (lipgloss.Width semantics for what the TUI renders: CJK/
  fullwidth/Hangul = 2 cells, ANSI escapes = 0, combining marks = 0),
  `truncateDisplay` (the `...`-suffixed grid-safe truncation),
  `compactBashOutput` (blank-run collapse + per-line trim), and
  `formatDuration` (`<1s`/`1s`/`1m01s`/`1h01m`). The i18n-coupled tool-result
  formatters (`formatToolArgsWithTranslator` etc.) migrate with the Ink
  tool components, not here.
- Both modules exported through `src/tui/mod.ts`.
- Tests: `src/tui/command_specs_test.ts` (4 — exact name-order/usage/message-ID
  table assertion against the Go source, Fields collapse, dispatch prologue),
  `src/tui/formatters_test.ts` (4 — width semantics, CJK truncation, ANSI
  zero-width, blank-run collapse, duration ladder). TUI suite 13 tests; full
  suite 1681 passed / 0 failed, architecture 8/8, lint/check/fmt clean.
- Remaining #37 slices: Ink components (input/header/tabbar/tool modal),
  agent-event projection onto `SessionRuntime` (App Update/Init), then the
  root interactive/print action in `src/cli/command.ts`.

### Ledger entry — `internal/tui` slice 2a: i18n runtime + header + agent tab bar

Migrated the i18n infrastructure and the first two chrome components. The
renderers stay pure string functions (ANSI-styled, DOM-free) so they are
usable both from the Ink tree and from deterministic tests, mirroring the Go
string-returning lipgloss renderers.

- `src/tui/i18n.ts` — ported `language.go` + `catalog.go` + the catalog
  mechanism of `messages.go`: `parseConfigured` (unknown → auto, valid=false),
  `resolveLanguage` (auto ⇒ zh only in UTC+8, null zone ⇒ en), `utcOffset`
  (`UTC+08:00`/`unknown`), and an immutable `Translator` with the exact
  fallback chain zh → en → raw message id, plus a minimal `sprintf` subset
  (`%s %v %d %02d %%` with Go's sign-outside-zero-padding). The bilingual
  catalogs are populated per component slice — first batch carries the
  `tool.modal.*` state/agent-tab family and input placeholder, with message
  IDs and texts copied verbatim from the Go bundle (en L677–685, zh L897–905).
- `src/tui/header.ts` — ported `header.go`: the mothx logo, `logoWidth`, and
  `renderHeader` with rounded-border info panel (bold `MothX (version)`,
  `provider | model`, cwd, rename notice), the narrow-width responsive
  collapse to panel-only, cwd truncation to the available gutter, and the
  vertically-centered two-column join. Colors are ANSI 256 (`38;5;86` accent)
  matching the lipgloss palette.
- `src/tui/agent_tabbar.ts` — ported `agent_tabbar.go`: hidden for ≤1 agents,
  per-state icons (●/○/✓/✗/⊘ in green/dim/green/red/orange), localized state
  suffix, accent+bold active tab vs dim inactive, display-width truncation,
  and the bottom border row. Takes a plain `AgentTab[]` snapshot instead of
  the live `agent.AgentManager` so the renderer stays testable; the
  SessionRuntime-backed snapshot provider lands with the agent-event slice.
- Hardened `truncateDisplay` in `src/tui/formatters.ts`: ANSI escape sequences
  now pass through with zero width and are never split mid-sequence (Go's
  `xansi.Truncate` behavior), which the styled tab-bar rows rely on.
- Tests: `src/tui/components_test.ts` (12) covering the translator fallback
  chain and auto resolution, sprintf corner cases, header grid alignment
  (all rows equal display width) and responsive collapse, tab-bar hidden/
  active/truncation behavior, plus the prior suite. TUI suite 25 tests; full
  suite 1693 passed / 0 failed, architecture 8/8, lint/check/fmt clean.
- Next #37 slices: input editor + suggest, tool modal/ESM panel, then the
  agent-event projection and root interactive action.

### Ledger entry — `internal/tui` slice 2b: editor buffer/model + suggest + command-suggest wiring

Migrated the input stack: the Unicode multi-line editor (buffer + model),
the suggestion dropdown, and the slash-command suggestion wiring. Like slice
2a the components stay pure classes with string-rendered views; the Ink layer
maps `useInput` events onto `Editor.handleKey` without owning semantics.

- `src/tui/components/editor/buffer.ts` — full port of `buffer.go`: lines
  stored without trailing newlines, rune-offset cursor with preferred column
  for vertical navigation, insert rune/string/newline (multi-line paste with
  \r\n/\r normalization), delete back/forward/to-line-end/to-line-start/
  word-back (Ctrl+W), character and word movement across line boundaries,
  home/end/end-all, absolute-cursor word walks, clamping, and the display-
  column helper. Go `unicode.IsSpace` maps to `/\s/`.
- `src/tui/components/editor/editor.ts` — full port of `editor.go`: Enter
  submits (`handleKey` returns true), Alt+Enter / Ctrl+J insert newlines,
  the full key table (arrows, word arrows, home/end, Ctrl+A/E/K/U/W, space,
  Tab = two spaces), display-line wrapping by display width
  (`wrapLineSegments` with CJK-aware widths), the cursor-windowed view
  (`maxLines` window centered on the cursor), reverse-video cursor insertion,
  the placeholder line (first rune cursor-carried, rest dimmed), and the
  padded background framing. Key handling is a string-keyed method so the
  Bubble Tea `KeyMsg` mapping lives in the adapter, not the model.
- `src/tui/components/suggest/suggest.ts` — port of `suggest.go`: prefix
  filtering on label/value (case-insensitive), empty query hides, wrap-around
  cursor movement, scroll window centered on the cursor with the `↑↓ more`
  hint, dim/accent+bold item rendering, rounded-border dropdown.
- `src/tui/command_suggest.ts` — port of `command_suggest.go`:
  `commandSuggestionItems` (spec table + localized descriptions via the
  slice-1 i18n runtime), `commandSuggestionItemsForInput` (slash gate, no
  newline, command names before the first space, argument tables after), and
  the static per-command argument tables (/mode /esm /defaultModel /sessions
  /expert /delegate /browser /stats /alloweditpath /allowautoedit /statusline
  /tuilang /agent), including the two-level argument forms
  (`/allowautoedit on|off global`, `/statusline on|off project|global`,
  `/tuilang global|project auto|zh|en`). App-level overlay suppression stays
  with the App slice.
- i18n catalogs populated with all 33 `commands.*.description` messages,
  verbatim from the Go bundle (en L473–505, zh L897–929), so command
  suggestions render bilingually.
- Tests: `src/tui/editor_suggest_test.ts` (17) covering buffer editing
  semantics (merge-on-col-0 backspace, word delete, multi-line paste, word
  movement across lines, CJK rune/display counts), editor key handling and
  wrapping/windowing, dropdown filter/wrap/scroll, and the command-suggest
  wiring (33 localized items, `/mo` prefix filter → /mode + /model,
  argument tables). Note: tests must match Deno's `*_test.ts` discovery
  pattern (renamed from `components_test_2b.ts`). TUI suite 42 tests; full
  suite 1710 passed / 0 failed, architecture 8/8, lint/check/fmt clean.
- Next #37 slices: tool modal + ESM panel (slice 2c), then the agent-event
  projection and root interactive action (slice 3).

### Ledger entry — `internal/tui` slice 2c: agent-activity store + tool-modal state

Migrated the background-agent activity pipeline (event stream → folded
snapshot → panel/summary renders) and the tool-modal geometry/scroll state.
The Go App-coupled halves (targets from `a.toolResults`, live status from
`a.agentMgr`) stay with the App assembly slice; everything here takes plain
snapshots.

- `src/tui/activity.ts` — port of `activity.go`: `AgentActivityStore` folds
  the agent event stream into per-agent `AgentActivity` snapshots —
  think/text deltas (truncated rolling windows + full accumulators), tool
  start/result with the shared Runtime error classification
  (`agentruntime.classifyError` + `displayErrorMessage`, PhaseTool/
  SideEffectUnknown and PhaseModel — the exact Go contract), retry lines,
  status lines, hosted items, and terminal states with Go's override
  semantics (a terminal failure message replaces the last result; late
  events after a terminal state are ignored). Timeline is capped at 200
  entries (`appendActivityLine`), workflow agents detected by the
  `workflow:` id prefix, and `isBackgroundAgentEvent` excludes the lead agent
  plus the four approval/question event types. Renderers:
  `renderAgentActivity` (header with kind/state/age, latest tool with
  detailed args, thinking/response/result sections, HH:MM:SS timeline),
  `renderActivitySummary` (last 4 agents one-liner), `formatActivityTool`
  (known-key `name(key="value")` summary), `truncatePlain`,
  `formatActivityAge`.
- `src/tui/tool_modal.ts` — port of the state/geometry half of
  `tool_modal.go`: `ToolModalState.widthFor/contentWidthFor/chromeFor/
  verticalFrame/pageSizeFor/maxOffsetFor` (the exact Go arithmetic,
  `Padding(0,2)` → 4 columns), scrolling with bottom pin (`applyPin`),
  target switching with wrap + scroll reset, tab-row rendering (accent+bold
  active, dim inactive, `  |  ` separator, truncation), and the framed
  render with the localized `Agent details` title, position indicator, hint
  row, ANSI-aware title truncation with `…`, and the separator rule sized to
  the title. Content lines are caller-supplied.
- i18n catalogs populated with the `tool.modal.position/title/hints` and all
  15 `activity.*` messages, verbatim from the Go bundle (en L668–684 +
  L820–834, zh L1162–1178 + L1000+).
- Tests: `src/tui/activity_modal_test.ts` (16) — event folding including
  terminal-override and terminal-late-ignore semantics, timeline cap,
  workflow kind, background gating; panel/summary renders; activity tool
  formatting and age ladder; modal geometry math, scroll/pin, target wrap,
  framed render with title truncation (narrow drops `Esc:close`, wide keeps
  it — the Go `xansi.Truncate` behavior). TUI suite 58 tests; full suite
  1726 passed / 0 failed, architecture 8/8, lint/check/fmt clean.
- Remaining #37: ESM panel (slice 2d), App assembly with agent-event
  projection and root interactive action (slice 3), transcript/tool-result
  i18n-rich formatters.

### Ledger entry — `internal/tui` slice 2d: renderutil + ESM panel

Migrated the ANSI-aware text wrapping utilities and the Supervisor Mode
progress panel. The ESM runtime itself (Store/Objective/state machine) was
already in `src/esm`; this slice covers its TUI projection only.

- `src/tui/renderutil.ts` — port of `internal/tui/renderutil/ansi_wrap.go`:
  `visibleWidth` (cells after tab→3-space normalization, ANSI zero-width),
  `wrapPlainText` (hard wrap at cell boundaries, Go `xansi.Hardwrap`),
  `wrapANSI` (word-aware wrap breaking after spaces and `/` path
  breakpoints, Go `xansi.Wrap`), `stripANSI`, `truncateANSI` (preserves
  unprinted SGR sequences so color state does not leak past the cut, the
  `xansi.Truncate` behavior), and the shared line pipeline (tab
  normalization, right-visible-whitespace trim, ANSI blank-line drop).
- `src/tui/esm_panel.ts` — port of `esm_panel.go` with every function
  parameterized (objective snapshot, activity context, translator):
  `esmPanelWidth/contentWidth`, `esmPanelLines` (the full body assembly:
  title, now-line, progress with `N/3 pipeline stages` + remaining count,
  next-step, status/stage/pipeline rows, wrapped objective field,
  worker-progress, remaining-work numbering, blocker + repeated-blocker
  audit, completion review, rejection/recovery counters, completion
  candidate, live details, tokens/time/last-saved footer, load-error and
  no-objective branches), `esmPanelNow` (phase activity label + live
  sub-agent detail fallback chain tool→result→text→think→running),
  `effectiveESMPhase` (phase override + status fallback),
  `renderESMPipeline` (`[x]/[!]/[>]/[ ]` markers), `esmPhaseIndex/Label`,
  `esmCompletedStages`, `esmPhaseActivityLabel`, `esmPanelNextStep`,
  `formatESMPanelUpdateTime`, `formatDurationMSForPanel`, and
  `activeESMPanelActivity`.
- i18n catalogs populated with all 56 translated `esm.panel.*` messages from
  `i18n/esm_labels.go` (`MsgESMPanelPaused` has no label entry in Go either;
  the fallback chain covers it).
- Tests: `src/tui/esm_panel_test.ts` (18) — wrapper cell-width/ANSI/CJK
  behavior, path-breakpoint word wrap, trailing-SGR truncation, pipeline
  marker matrix (x/!/>/space), status-over-phase activity labels, full
  assembly with every section, load-error/no-objective branches, live
  activity fallback chain, and 40-width field wrapping. TUI suite 76 tests;
  full suite 1744 passed / 0 failed, architecture 8/8, lint/check/fmt clean.
- Remaining #37: App assembly with agent-event projection (slice 3) and the
  root interactive action; a2a-start factory bridge; cron subcommand.

### Ledger entry — `internal/tui` slice 3a: transcript store (event projection storage)

Started slice 3 with the storage half of the agent-event projection: the
transcript rows, the assistant/think streaming slots, and the tool-result
state machine that `handleAgentEvent` writes into. The Ink rendering half
and the App wiring land next.

- `src/tui/transcript_store.ts` — ported the state machine verbatim from
  `agent_events.go` + `input.go` + `state.go`:
  - Streaming slots: `beginAssistantSlot` (EventTurnStart reserves the row
    before deltas arrive so tool rows cannot shift assistant indices),
    `appendAssistantDelta`, and `appendThinkDelta` with the exact Go slot
    conversion — an untouched (empty) assistant slot is reused as the think
    slot and a fresh assistant slot opens after it. `commitActiveStream`
    clears active indices.
  - Tool rows: `appendToolExecutionStart` (dedup by call ID + status,
    commits the active stream first), `appendToolResult` (terminalizes the
    matching running row in place carrying matched name/args, opens a new
    completed row when no running row exists, and drops late stragglers for
    already-interrupted calls so an aborted run cannot open a second row),
    and `finalizeInterruptedTools` (running → interrupted with
    `executionState: "interrupted"`, terminal rows untouched).
  - `resetTranscriptState` clears all bookkeeping (Go resetTranscriptState).
  - Summaries: `summarizeToolResult` (bash/ls → compactBashOutput keeping
    one blank line, read → `N lines`, edit/write → file-diff summary with
    fallbacks), `summarizeFileDiff` (`+A -D[ large] (-ranges +ranges)`),
    `formatLineRangesForDisplay` (run compression). FileDiff maps to the
    existing `src/tools/io_helpers.ts` shape (`added`/`deleted`/
    `addedLines`/`deletedLines`/`truncated`).
- i18n: `tool.result.lines` / `tool.result.applied` added to both catalogs.
- Tests: `src/tui/transcript_store_test.ts` (15) — slot reservation and
  conversion, delta accumulation with dirty tracking, commit semantics,
  tool-row dedup/matching/straggler/interruption paths, reset, and the
  summary forms. TUI suite 91 tests; full suite 1759 passed / 0 failed,
  architecture 8/8, lint/check/fmt clean.
- Next #37: Ink transcript renderer + App assembly (handleAgentEvent
  dispatch over the store), then the root interactive action.

### Ledger entry — `internal/tui` slice 3b: AppController (agent-event dispatch)

Migrated the event-dispatch half of `handleAgentEvent` as a standalone
controller, keeping the Ink layer a subscriber. The ExecutionRuntime/Decision
bridge lands as the `RunHandle` adapter in 3c.

- `src/tui/app_controller.ts` — ported `handleAgentEvent` (agent_events.go)
  plus the approval/question queue state (`approval.go showNext*`):
  - Background routing: `AgentActivityStore.isBackgroundAgentEvent` gates
    member/workflow events into the activity store; lead events fall through
    to the transcript.
  - Streaming/tools/turns: text/think deltas into the slice-3a store,
    hosted-item status lines, turn start/end, tool call (embedded
    ToolCallBlock), execution start/end, tool result, plan updates.
  - Approvals: registers a `DecisionApproval` via `RunHandle`, binds the
    answer resolver, queues pending requests, shows the next one
    (enqueue + show-next consumes the queue into the shown slot, matching
    Go), dedups on the shown id, and surfaces duplicate-registration errors
    as command errors.
  - Questions: member questions (`agentId` set) route to the lead-mailbox
    message path and are never registered as human decisions (Go comment
    preserved); human questions register `DecisionQuestion`, queue, and
    show.
  - Terminal: `EventRunFinished` maps TaskFailed/Canceled/Incomplete to the
    canonical RunStates, calls `finish`, finalizes interrupted tools, clears
    `isThinking`, and adds the error/warning message; legacy
    `EventDone`/`EventError` terminalize as failed when no canonical
    terminal has arrived and are ignored after it.
- Tests: `src/tui/app_controller_test.ts` (12) — streaming/turn flow,
  background routing, tool row lifecycle through the controller, status
  messages, run-finished terminal mapping for all statuses, legacy terminal
  events, approval/question registration + queue consumption, member-vs-human
  question routing, and duplicate-decision errors. TUI suite 103 tests; full
  suite 1771 passed / 0 failed, architecture 8/8, lint/check/fmt clean.
- Next #37 (slice 3c): Ink transcript renderer + App.tsx assembly,
  `RunHandle` adapter over `ExecutionRuntime`/`DecisionService`, and the
  root interactive action in the CLI.

### Ledger entry — `internal/tui` slice 3c: TuiRun adapter + Ink App assembly

Bridged the controller to the shared execution lifecycle and rebuilt the Ink
root component around the migrated stores.

- `src/tui/tui_run.ts` — ported `run.go`'s decision half as `TuiRun`, which
  implements the controller's `RunHandle` contract: `registerDecision`
  (DecisionService registration with duplicate/invalid error text, pending
  persistence), `bindDecision`, `resolveDecision` (`resolveWith` + resolved
  persistence commit), `clearDecisions` with `decisionTerminalStatus`
  (cancelled/cancelling → "cancelled", every other terminal state →
  "timed_out" so non-cancellation outcomes are not misreported), and the
  lifecycle passthroughs (`finish` with `finishWithState`, `cancel`,
  `resume`, `waitForApproval/Question`). Decision events persist through the
  shared `recordDecisionEvent` sink with `source: "tui"`; missing
  execution/session fields are no-ops exactly like the Go nil-guards. The
  durable begin path (ExecutionIntent + `BeginIntentDurable` + admission
  guard) belongs to the CLI root assembly (3d) where `SessionRuntime` builds
  the agent.
- `src/tui/app.tsx` — rebuilt the Ink root around the controller: a single
  `<Static>` carries the header lines plus committed transcript rows
  (Ink supports exactly one Static; two instances drop output), the active
  think/assistant slots render as clipped streaming rows in the managed
  view, and shown approval/question panels render as bordered boxes with
  `isThinking` spinner. The legacy banner mode is preserved for the
  toolchain smoke test.
- Tests: `src/tui/tui_run_test.ts` (5) — terminal status mapping, duplicate
  and resolved-decision registration errors through the real
  `DecisionService`, clear-and-terminalize flows, and the no-runtime no-op
  contract; the Ink assembly test (`app_controller_test.ts`) now renders
  header + streaming transcript + approval panel through FakeStdout. TUI
  suite 109 tests; full suite 1777 passed / 0 failed, architecture 8/8,
  lint/check/fmt clean.
- Next #37 (slice 3d): CLI root interactive action — SessionRuntime agent
  build, `tuiRun.start` (admission guard + `BeginIntentDurable`), the
  `listenAgentEvents` loop, and main-loop key handling.

### Ledger entry — `internal/tui` slice 3d (part 1): root print action

Wired the CLI root print action (`-P`) end-to-end through the shared
runtime, replacing the last placeholder on the root command's print path
(the interactive TUI action remains and keeps its slice hint).

- `src/cli/root_print.ts` — ported `main_util.go runPrint`:
  - Provider via `src/provider/factory` (`createWithOptions`, requireModel);
    mode default `yolo` (settings → fallback), thinking normalization.
  - One fresh session per print run (`session.newManager`) bound through the
    shared `Builder.build` (registry, skills, sandbox, MCP — the only
    production construction path) with `SourceCLI`.
  - Durable lifecycle: admission guard → `cli_<id>`/`intent_<id>` ids →
    `acceptInput` → `buildUserMessage` → SHA-256 request fingerprint +
    policy snapshot (`approvalPolicy: print`, `questionPolicy:
    unattended`) → `BeginIntentDurable` with the canonical started event and
    conversation-turn linkage. `RunStore` + `SessionRunEventSink` attached.
  - `BuildAgent` + conversation-turn binding + `runWithUserMessage`; the
    event loop (`agent.consumeEvents`) streams text (buffered → wrapped
    stdout) or NDJSON (`start`/`text_delta`/`think_delta`/`hosted_item`/
    `tool_call`/`tool_execution_start`/`tool_execution_end`), mirrors Go's
    stderr `[tool: …]`/`[running: …]`/`done` lines, and errors on approval
    requests with Go's exact message. Terminal mapping
    failed/cancelled/incomplete → `finishDurableWithRetry` events.
- Root command: `-P` now dispatches to `runPrintAction` (prompt from
  positional args); the TUI hint remains for non-print invocations.
- Tests: `src/cli/cli_test.ts` root help asserts the prompt positional and
  `--print` flag; full suite 1778 passed / 0 failed, architecture 8/8,
  lint/check/fmt clean.
- Next: interactive TUI main loop (3e), a2a-start factory bridge, cron
  subcommand.

### Ledger entry — `internal/tui` slice 3d-2 (part 1): interactive session assembly + input shell

Ported the interactive TUI assembly: the session state object, the in-tree
keyboard shell, and the CLI root wiring. This completes the structural port
of the TUI main loop; live end-to-end keyboard verification remains a
manual/E2E follow-up since Ink input requires a real TTY.

- `src/tui/tui_session.ts` — the interactive session object (the Go App's
  run lifecycle half): `start()` builds the shared runtime once through
  `Builder.build` (SourceTUI, registry/skills/sandbox/MCP), `submitPrompt`
  runs the durable conversation-turn path (admission guard → `tui_<id>`/
  `intent_<id>` → acceptInput → buildUserMessage → intent+policy snapshot →
  `BeginIntentDurable` with started event and turn linkage → `RunStore` +
  `SessionRunEventSink` → `BuildAgent` + `setConversationTurn` +
  `execution.setAgent` → `runWithUserMessage`), pumping events into the
  AppController until the terminal flag, then clearing busy/thinking and
  releasing the admission guard. `cancelRun` aborts via
  `ExecutionRuntime.cancel` (ctrl+c while busy), `answerApproval`/
  `answerQuestion` drive the decision panels.
- `src/tui/tui_shell.tsx` — the in-tree keyboard loop (`useInput` requires a
  component context): printable input → `Editor.insertText`, arrows/del/
  tab/ctrl-a/e/j/k/u/w → the Editor's key table (slice 2b), Alt/Ctrl+Enter
  newline, Enter submits through the session, approval panel y/n and question
  panel numeric options route through the decision bindings, ctrl+c cancels
  a busy run or exits, SIGINT mirrors ctrl+c. Renders through the migrated
  `App` (single Static, streaming rows, panels).
- `src/cli/root_tui.ts` — `runInteractiveAction`: builds the session, renders
  `TuiShell` (React createElement from plain TS), rerenders on a 100ms
  refresh timer plus submit completions, and exits through the shell's
  onExit. The root command's default action now dispatches here.
- Known follow-ups: live TTY keyboard E2E (Ink input needs a real terminal;
  unit coverage covers the controller/store layers), editor width tracking
  terminal resize, and the settings-driven translator.
- Tests: full suite 1778 passed / 0 failed (no new failures; keyboard loop
  is TTY-bound), architecture 8/8, lint/check/fmt clean.

### Ledger entry — `internal/tui` wrap-up: a2a start factory bridge + cron placeholder removal

Closed the two remaining CLI items, leaving no pending placeholders in the
command tree.

- `src/cli/a2a.ts` — `RuntimeAgentFactory` implements the a2a
  `AgentFactory` contract (Go `simpleAgentFactory`, main_a2a.go L268–313):
  each task builds a transient agent through `Builder.build` +
  `SessionRuntime.buildAgent` (the only production construction path;
  SourceACP to match Go, thinking off, sandbox level from `--sandbox`), with
  provider creation via the shared factory (`requireModel`). An adapter
  reorders the core Agent's `run(userMsg, signal)` to the A2A contract's
  `run(signal, input)`. `executeA2AStartWithSettings` wires it into
  `DefaultExecutor` and `a2a.run` (server startup is lazy — agents are built
  per task, so the listener comes up without provider credentials). The
  root `a2a start` action now dispatches here with clean startup-error
  handling; the placeholder is gone.
- `mothx cron` subcommand removed: the Go CLI has no such subcommand (cron
  is the root `--cron` flag plus the TUI `/cron` slash command; the
  `main_cron.go` helpers have no CLI callers). The obsolete pending
  placeholder and its `pendingCommand` helper were deleted; the help test
  now asserts the Commands section matches the Go surface.
- Verified live on the rebuilt binary: `mothx a2a start` listens on
  127.0.0.1:8093 and serves the agent card; interactive TUI renders the
  header and input loop; `-P` with an unknown provider exits cleanly with
  `error: unknown provider: …`.
- Full suite 1778 passed / 0 failed, architecture 8/8, lint/check/fmt clean.
- Remaining #37 follow-ups (non-blocking): live TTY keyboard E2E, editor
  width tracking terminal resize, settings-driven translator in the shell.

## Validation

```sh
deno task fmt      # deno fmt
deno task lint     # deno lint
deno task check    # deno check src/
deno task test     # deno test -A
```

Each ported package ships its Go tests translated to `Deno.test`.
