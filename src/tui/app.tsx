// Ink + React assembly of the TUI (the Go Bubble Tea App's View half).
//
// Rendering rules preserved from the Go App:
// - Completed transcript rows go to the terminal's own scrollback exactly once
//   via Ink's <Static>; only the active streaming row stays in the managed
//   view (inline mode, never the alternate screen).
// - The header, tab bar, and streaming rows are plain strings produced by the
//   migrated formatters; this component lays them out.
//
// Enhanced with TurnCard-style display inspired by moark:
// - Activity timeline showing tool executions and thinking
// - Collapsible tool results
// - Response text with improved formatting
// - Status indicators and timing

import React, { useRef } from "react";
import type { ReactElement } from "react";
import { Box, Static, Text } from "ink";
import {
  TOOL_EXECUTION_FAILED,
  TOOL_EXECUTION_INTERRUPTED,
} from "../agentruntime/events.ts";
import { AppController } from "./app_controller.ts";
import { renderHeader } from "./header.ts";
import { displayWidth } from "./formatters.ts";
import { type ToolResultEntry, TranscriptStore } from "./transcript_store.ts";
import type { Translator } from "./i18n.ts";
import { formatToolGroup, formatToolRow } from "./tool_row_format.ts";
import { CompactThinkingRow } from "./thinking_display.tsx";
import { CompactToolRow } from "./tool_execution_display.tsx";
import { stripANSI } from "./renderutil.ts";
import { renderMarkdown, renderStreamingMarkdown } from "./markdown.ts";

export interface AppProps {
  /** The event-dispatch controller owning the transcript. */
  controller?: AppController;
  /** Static header info; omitted renders the plain label banner. */
  header?: {
    version: string;
    providerName: string;
    modelName: string;
    cwd: string;
  };
  /** Terminal width for header layout. */
  width?: number;
  /** Legacy banner label (kept for the toolchain smoke test). */
  label?: string;
  /** Visible tail of the transcript when `controller` is absent. */
  visibleRows?: Array<{ id: string; text: string }>;
  /**
   * Simple event view (Go a.compactMode): one-line tool summaries and routine
   * lifecycle rows hidden; the full view keeps full tool output and replays
   * the hidden rows. Defaults to the simple view.
   */
  compactMode?: boolean;
  /**
   * A framed panel owns the managed region while open: live transcript rows,
   * activity rows, and new Static admissions are hidden until it closes so
   * Ink cannot mix panel updates with output above it.
   */
  overlayOpen?: boolean;
}

/** One transcript row with its presentation kind. */
export interface TranscriptRow {
  id: string;
  text: string;
  kind:
    | "header"
    | "plain"
    | "status"
    | "assistant"
    | "think"
    | "tool"
    | "error"
    | "warning";
}

/** Append-only list of rows already released to Ink's <Static>. */
interface StaticAdmission {
  rows: TranscriptRow[];
  ids: Set<string>;
  /**
   * Snapshot handed to <Static>. Ink memoizes on the items identity, so the
   * array is copied whenever rows are admitted instead of being mutated in
   * place.
   */
  view: TranscriptRow[];
  /** Bumped on every admission. */
  revision: number;
  /** Revision of the rows currently in `view`. */
  viewRevision: number;
}

/** The full-screen layout with enhanced TurnCard display. */
export function App(props: AppProps): ReactElement {
  if (!props.controller) {
    // Legacy banner mode (toolchain smoke tests).
    return (
      <Box flexDirection="column">
        <Text color="cyan" bold>
          {props.label ?? "OpenSAC"}
        </Text>
        {props.visibleRows?.map((row) => (
          <Text key={row.id}>{row.text}</Text>
        ))}
      </Box>
    );
  }
  return <ControllerApp {...props} controller={props.controller} />;
}

/** Controller-backed layout with overlay-safe static admission. */
function ControllerApp({
  controller,
  header,
  width = 80,
  compactMode = true,
  overlayOpen = false,
}: AppProps & { controller: AppController }): ReactElement {
  const store = controller.store;
  // Ink supports a single <Static>; header lines and committed transcript rows
  // share it, header first. The admitted view is kept across renders so an
  // open framed panel can be painted without re-walking the whole transcript.
  const admissionRef = useRef<StaticAdmission>({
    rows: [],
    ids: new Set(),
    view: [],
    revision: 0,
    viewRevision: -1,
  });
  const admission = admissionRef.current;

  // A framed panel owns the managed region: live rows, activity rows, and new
  // Static admissions are all suppressed while it is open, so the transcript
  // walk (which formats every row) is skipped entirely instead of running its
  // results into discarded arrays. Rows that completed meanwhile are released
  // on the first frame after the panel closes.
  if (overlayOpen) {
    if (admission.viewRevision !== admission.revision) {
      admission.view = admission.rows.slice();
      admission.viewRevision = admission.revision;
    }
    return (
      <Box flexDirection="column">
        <Static items={admission.view}>
          {(row) => renderRow(row, false, store, width)}
        </Static>
        {controller.shownApproval && renderApproval(controller)}
        {controller.shownQuestion && renderQuestion(controller)}
      </Box>
    );
  }

  // Rows with an index below the active streaming rows are committed; the
  // active assistant/think slot and running tool rows stay in the managed
  // view. The store's `messages` array is the source of truth: every row is
  // committed exactly once via <Static>, identified by its transcript index
  // plus the generation (a cleared transcript re-uses indices). Running tool
  // rows never commit — <Static> is append-only, so a row whose text will
  // change (running… → summary) must stay in the managed view until it
  // reaches a terminal state.
  const slotStart = activeSlotStart(controller);
  const runningTools = new Set(
    store.toolResults
      .filter((r) => r.status === "running")
      .map((r) => r.msgIndex),
  );
  const committed: TranscriptRow[] = [];
  const streaming: TranscriptRow[] = [];
  // Parallel batches (Go renderToolGroupBlock): calls that overlapped share a
  // group id and render as one tree block instead of one row per call. The
  // block stays in the managed view until every member is terminal, then
  // commits to scrollback as a single unit (Go printToolGroupOnce).
  const groupedToolIds = new Set(
    store.toolResults
      .filter((r) => store.isMultiToolGroup(r.groupID))
      .map((r) => r.toolCallID),
  );
  const seenGroups = new Set<number>();
  for (let i = 0; i < store.messages.length; i++) {
    // The simple view omits full-view-only lifecycle rows entirely (Go
    // renderMessageAt consulting hiddenEventIdx); the full view replays them.
    if (compactMode && store.isFullOnly(i)) continue;
    const groupID = store.toolGroupIDAt(i);
    if (groupID > 0 && store.isMultiToolGroup(groupID)) {
      if (seenGroups.has(groupID)) continue;
      seenGroups.add(groupID);
      const members = store.toolGroupMembers(groupID);
      const row = toolGroupRow(store, groupID, members, compactMode);
      const settled =
        !members.some((m) => m.status === "running") &&
        members.every((m) => m.msgIndex < slotStart);
      if (settled) committed.push(row);
      else streaming.push(row);
      continue;
    }
    const resolved = rowTextAt(store, i, compactMode);
    if (!resolved) continue;
    const row: TranscriptRow = {
      id: `row-${store.generation}-${i}`,
      text: resolved.text,
      kind: resolved.kind,
    };
    if (i < slotStart && !runningTools.has(i)) committed.push(row);
    // Rows owned by the activity timeline (tools + the active think slot)
    // must not also render here, or the same thinking text appears twice.
    else if (
      resolved.kind !== "tool" &&
      !(resolved.kind === "think" && i === store.currentThinkIdx)
    ) {
      streaming.push(row);
    }
  }

  // Live per-turn activity timeline (running tools + thinking) tracked by
  // the controller from the agent event stream. Terminal tool rows belong to
  // <Static> once complete, so only running items remain in the managed view.
  const activities = controller.activityManager
    .buildTimeline()
    .filter((activity) =>
      activity.type !== "tool"
        ? // Grouped running calls are listed by the batch's tree block, so the
          // timeline keeps only the tools that are not part of a batch.
          true
        : activity.status === "running" &&
          !groupedToolIds.has(activity.toolUseId ?? activity.id),
    );

  const headerLines = header
    ? renderHeader(
        width,
        header.version,
        header.providerName,
        header.modelName,
        header.cwd,
      )
        .split("\n")
        .filter((l) => l !== "")
        .map((line, i): TranscriptRow => ({
          id: `header-${i}`,
          text: line,
          kind: "header",
        }))
    : [];
  const committedAll = [...headerLines, ...committed];
  // Ink's <Static> prints only the tail it has not seen (it advances by item
  // count), so admission is append-only for the life of the view: rows the
  // simple view deferred join the end of the list when the full view comes
  // back, which is how the Go TUI's printUnrenderedTranscript releases them.
  // A cleared transcript keeps its printed rows and admits the new ones under
  // their fresh generation ids.
  for (const row of committedAll) {
    if (admission.ids.has(row.id)) continue;
    admission.ids.add(row.id);
    admission.rows.push(row);
    admission.revision++;
  }
  if (admission.viewRevision !== admission.revision) {
    admission.view = admission.rows.slice();
    admission.viewRevision = admission.revision;
  }
  const staticItems = admission.view;

  return (
    <Box flexDirection="column">
      <Static items={staticItems}>
        {(row) => renderRow(row, false, store, width)}
      </Static>

      {/* Live activity timeline (running tools + thinking).
          Rows receive width-4: 1-col left indent (marginLeft) + 3 cols of
          margin slack so a full-width row never touches the terminal edge. */}
      {!overlayOpen && activities.length > 0 && (
        <Box flexDirection="column" marginLeft={1} marginBottom={1}>
          {activities.map((activity) =>
            activity.type === "tool" ? (
              <CompactToolRow
                key={activity.id}
                toolName={activity.toolName ?? activity.type}
                toolInput={activity.toolInput}
                status={
                  activity.status as
                    "running" | "completed" | "error" | "interrupted"
                }
                intent={activity.intent}
                elapsedMs={activity.elapsedMs}
                width={width - 4}
              />
            ) : (
              <CompactThinkingRow
                key={activity.id}
                content={activity.content ?? ""}
                isStreaming={activity.status === "running"}
                elapsedMs={activity.elapsedMs}
                translator={controller.translator}
                width={width - 4}
              />
            ),
          )}
        </Box>
      )}

      {!overlayOpen &&
        streaming.map((row) => renderRow(row, true, store, width))}
      {controller.shownApproval !== undefined && renderApproval(controller)}
      {controller.shownQuestion !== undefined && renderQuestion(controller)}
      {!overlayOpen &&
        controller.coreConnectionNotice !== "" &&
        (controller.coreConnection === "reconnecting" ? (
          <Text color="yellow">{controller.coreConnectionNotice}</Text>
        ) : (
          <Text dimColor>{controller.coreConnectionNotice}</Text>
        ))}
      {!overlayOpen && controller.isThinking && (
        <Text dimColor>
          ~ {controller.translator.text("thinking.in_progress")}
        </Text>
      )}
    </Box>
  );
}

/** Approval prompt panel (rendered outside the overlay-safe early return). */
function renderApproval(controller: AppController): ReactElement {
  const approval = controller.shownApproval!;
  return (
    <Box flexDirection="column" borderStyle="round">
      <Text bold color="yellow">
        {controller.translator.text("approval.required")}
      </Text>
      <Text>
        {approval.toolName} {JSON.stringify(approval.args ?? {})}
      </Text>
    </Box>
  );
}

/** Question prompt panel. */
function renderQuestion(controller: AppController): ReactElement {
  const question = controller.shownQuestion!;
  return (
    <Box flexDirection="column" borderStyle="round">
      <Text bold>{question.question}</Text>
      {(question.options ?? []).map((opt) => (
        <Text key={opt}>- {opt}</Text>
      ))}
    </Box>
  );
}

/** Renders one transcript row; streaming rows are clipped and stripped. */
function renderRow(
  row: TranscriptRow,
  streaming: boolean,
  store?: TranscriptStore,
  width = 80,
): ReactElement {
  if (row.kind === "header") {
    return <Text key={row.id}>{row.text}</Text>;
  }
  if (row.kind === "think") {
    const prefix = store
      ? storeTranslator(store).text("transcript.think_prefix")
      : "[think]: ";
    return (
      <Text key={row.id} dimColor italic>
        {prefix}
        {streaming ? clip(row.text, 4) : row.text}
      </Text>
    );
  }
  if (row.kind === "tool") {
    return (
      <Text key={row.id} color="cyan">
        {row.text}
      </Text>
    );
  }
  if (row.kind === "status") {
    return (
      <Text key={row.id} dimColor>
        {row.text}
      </Text>
    );
  }
  if (row.kind === "error") {
    return (
      <Text key={row.id} color="red">
        {row.text}
      </Text>
    );
  }
  if (row.kind === "warning") {
    return (
      <Text key={row.id} color="yellow">
        {row.text}
      </Text>
    );
  }
  if (row.kind === "assistant") {
    const markdown = streaming
      ? clip(renderStreamingMarkdown(row.text, width), 6)
      : renderMarkdown(row.text, width);
    return <Text key={row.id}>{markdown}</Text>;
  }
  return (
    <Text key={row.id}>
      {streaming ? stripANSI(clip(row.text, 6)) : row.text}
    </Text>
  );
}

/**
 * Resolves the display text of transcript row `index`. Streaming rows keep
 * their raw text in the store's per-slot builders (assistant/think); tool rows
 * carry their summary in `toolResults`. Empty placeholders resolve to nothing.
 */
function storeTranslator(store: TranscriptStore): Translator {
  return store.translator;
}

/** Presentation kind of a plain message row (status rows render dim). */
function messageRowKind(
  store: TranscriptStore,
  index: number,
): TranscriptRow["kind"] {
  switch (store.messageKinds.get(index) ?? "plain") {
    case "error":
      return "error";
    case "warning":
      return "warning";
    case "status":
      return "status";
    case "assistant":
      return "assistant";
    default:
      return "plain";
  }
}

/**
 * Renders a parallel tool-call batch as one tree block (Go
 * `renderToolGroupBlock`): a live count title followed by one indented branch
 * per call. The row is keyed by group id, so it is admitted to scrollback
 * exactly once — when the batch settles.
 */
function toolGroupRow(
  store: TranscriptStore,
  groupID: number,
  members: ToolResultEntry[],
  compact: boolean,
): TranscriptRow {
  const lines: string[] = [];
  let warning = false;
  for (const member of members) {
    const resolved = rowTextAt(store, member.msgIndex, compact);
    if (!resolved) continue;
    if (resolved.kind === "warning") warning = true;
    lines.push(resolved.text);
  }
  const running = members.some((m) => m.status === "running");
  const title = storeTranslator(store).text(
    running ? "tool.group.running" : "tool.group.done",
    members.length,
  );
  return {
    id: `group-${store.generation}-${groupID}`,
    text: formatToolGroup(title, lines),
    kind: warning ? "warning" : "tool",
  };
}

function rowTextAt(
  store: TranscriptStore,
  index: number,
  compact: boolean,
): { text: string; kind: TranscriptRow["kind"] } | undefined {
  const tool = store.toolRowAt(index);
  if (tool) {
    const text = formatToolRow(
      storeTranslator(store),
      {
        toolName: tool.toolName,
        toolArgs: tool.toolArgs,
        status: tool.status,
        summary: tool.summary,
        fullContent: tool.fullContent,
        diff: tool.diff,
        plan: tool.plan,
        toolError: tool.toolError,
        executionState: tool.executionState,
      },
      compact,
    );
    const warning =
      tool.status === "interrupted" ||
      tool.toolError !== "" ||
      tool.executionState === TOOL_EXECUTION_FAILED ||
      tool.executionState === TOOL_EXECUTION_INTERRUPTED;
    return {
      text,
      kind: warning ? "warning" : "tool",
    };
  }
  const message = store.messages[index];
  if (message !== undefined && message !== "") {
    return { text: message, kind: messageRowKind(store, index) };
  }
  const assistant = store.assistantRaw(index);
  if (assistant !== "") return { text: assistant, kind: "assistant" };
  const think = store.thinkRaw(index);
  if (think !== "") return { text: think, kind: "think" };
  return undefined;
}

/** First message index eligible for scrollback commit. */
function activeSlotStart(controller: AppController): number {
  const { currentAssistantIdx, currentThinkIdx } = controller.store;
  const candidates = [currentAssistantIdx, currentThinkIdx].filter(
    (i) => i >= 0,
  );
  return candidates.length > 0
    ? Math.min(...candidates)
    : store_end(controller);
}

function store_end(controller: AppController): number {
  return controller.store.messages.length;
}

function clip(text: string, maxLines = 6): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  return lines.slice(lines.length - maxLines).join("\n") + "\n";
}

/** Exposed for tests: grid width check of the rendered header. */
export function headerWidth(props: AppProps): number {
  if (!props.header) return 0;
  return Math.max(
    ...renderHeader(
      props.width ?? 80,
      props.header.version,
      props.header.providerName,
      props.header.modelName,
      props.header.cwd,
    )
      .split("\n")
      .map(displayWidth),
  );
}
