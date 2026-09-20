// Public surface of src/tui (Ink + React projection of the Go bubbletea TUI).

export { App, type AppProps } from "./app.tsx";
export {
  MarkdownBlock,
  renderMarkdown,
  renderStreamingMarkdown,
} from "./markdown.ts";
export {
  Transcript,
  type TranscriptBlock,
  type TranscriptProps,
} from "./transcript.tsx";
export {
  type CommandSpec,
  commandSpecs,
  findCommandSpec,
  isKnownCommand,
  type MessageID,
  type ParsedInput,
  parseInputLine,
  splitFields,
} from "./command_specs.ts";
export {
  compactBashOutput,
  displayWidth,
  formatDuration,
  truncateDisplay,
} from "./formatters.ts";
export {
  catalogs,
  type ConfiguredLanguage,
  type Language,
  type MessageID as I18nMessageID,
  parseConfigured,
  resolveLanguage,
  sprintf,
  Translator,
  utcOffset,
} from "./i18n.ts";
export { logoWidth, mothxLogo, renderHeader } from "./header.ts";
export {
  type AgentTab,
  type AgentTabState,
  renderAgentTabBar,
} from "./agent_tabbar.ts";
export { Buffer } from "./components/editor/buffer.ts";
export {
  CURSOR_BLINK_INTERVAL_MS,
  Editor,
  wrapLineSegments,
} from "./components/editor/editor.ts";
export { Suggest, type SuggestItem } from "./components/suggest/suggest.ts";
export {
  commandArgumentSuggestionItems,
  commandSuggestionItems,
  commandSuggestionItemsForInput,
} from "./command_suggest.ts";
export {
  type ActivityLine,
  type AgentActivity,
  AgentActivityStore,
  formatActivityAge,
  formatActivityTool,
  formatDetailedActivityTool,
  MAX_ACTIVITY_LINES,
  renderActivitySummary,
  renderAgentActivity,
  truncatePlain,
} from "./activity.ts";
export { ToolModalState, type ToolModalTarget } from "./tool_modal.ts";
export {
  stripANSI,
  truncateANSI,
  visibleWidth,
  wrapANSI,
  wrapPlainText,
} from "./renderutil.ts";
export {
  activeESMPanelActivity,
  effectiveESMPhase,
  esmCompletedStages,
  type ESMPanelActivityContext,
  esmPanelLines,
  esmPanelWidth,
  esmPhaseIndex,
  esmPhaseLabel,
  formatDurationMSForPanel,
  renderESMPipeline,
} from "./esm_panel.ts";
export {
  formatLineRangesForDisplay,
  summarizeFileDiff,
  summarizeToolResult,
  type ToolResultEntry,
  type ToolResultStatus,
  TranscriptStore,
} from "./transcript_store.ts";
export {
  AppController,
  type AppControllerCallbacks,
  type MessageKind,
  type PendingApproval,
  type PendingQuestion,
  type RunHandle,
} from "./app_controller.ts";
export {
  DecisionSourceTUI,
  decisionTerminalStatus,
  TuiRun,
} from "./tui_run.ts";
export { TUISession } from "./tui_session.ts";
export { inputFooter, TuiShell } from "./tui_shell.tsx";
