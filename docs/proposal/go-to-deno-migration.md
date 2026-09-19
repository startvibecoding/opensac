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
| 21 | `internal/workflow` | 3035 | `src/workflow` | 🟡 |
| 22 | `internal/browser` | 838 | `src/browser` | ⬜ |
| 23 | `internal/esm` | 3367 | `src/esm` | ✅ |
| 24 | `internal/memory` | 829 | `src/memory` | ✅ |
| 25 | `internal/cron` | 3158 | `src/cron` | ⬜ |
| 26 | `internal/agentruntime` | 21399 | `src/agentruntime` | ⬜ |
| 27 | `internal/messaging` | 4546 | `src/messaging` | ✅ |
| 28 | `internal/skillhub` | 2788 | `src/skillhub` | ✅ |
| 29 | `internal/a2a` | 2388 | `src/a2a` | ✅ |
| 30 | `internal/stats` | 811 | `src/stats` | ✅ |
| 31 | `internal/debugpprof` | 187 | `src/debugpprof` | ✅ |
| 32 | `internal/doctor` | 572 | `src/doctor` | ✅ |
| 33 | `internal/update` | 319 | `src/update` | ✅ |
| 34 | `internal/architecture` | 900 | `src/architecture` | ✅ |
| 35 | `internal/acp` | 20753 | `src/acp` | ⬜ |
| 36 | `internal/serve` | 46511 | `src/serve` | ⬜ |
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

## Validation

```sh
deno task fmt      # deno fmt
deno task lint     # deno lint
deno task check    # deno check src/
deno task test     # deno test -A
```

Each ported package ships its Go tests translated to `Deno.test`.
