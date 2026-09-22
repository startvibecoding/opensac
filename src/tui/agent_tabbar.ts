// Ported from internal/tui/agent_tabbar.go: the horizontal tab bar showing
// all active agents (lead + team members). Hidden with zero or one agent.
// The Go original reads live state from agent.AgentManager; the TS projection
// takes a plain snapshot array so the renderer stays DOM-free and testable.

import { displayWidth, truncateDisplay } from "./formatters.ts";
import { type MessageID, Translator } from "./i18n.ts";

export type AgentTabState =
  | "running"
  | "ready"
  | "done"
  | "error"
  | "canceled"
  | "";

/** One tab snapshot; `id` is the canonical AgentID. */
export interface AgentTab {
  id: string;
  state: AgentTabState;
}

const accent = "\u001B[38;5;86m";
const bold = "\u001B[1m";
const dim = "\u001B[38;5;240m";
const green = "\u001B[38;5;82m";
const red = "\u001B[38;5;196m";
const orange = "\u001B[38;5;214m";
const reset = "\u001B[0m";

function stateIcon(state: AgentTabState): string {
  switch (state) {
    case "running":
      return `${green}o${reset}`;
    case "ready":
      return `${dim}.${reset}`;
    case "done":
      return `${green}+${reset}`;
    case "error":
      return `${red}-${reset}`;
    case "canceled":
      return `${orange}=${reset}`;
    default:
      return " ";
  }
}

function localizedState(tr: Translator, state: AgentTabState): string {
  const map: Record<Exclude<AgentTabState, "">, MessageID> = {
    running: "tool.modal.state.running",
    ready: "tool.modal.state.ready",
    done: "tool.modal.state.done",
    error: "tool.modal.state.error",
    canceled: "tool.modal.state.canceled",
  };
  if (state === "") return tr.text("tool.modal.state.unknown");
  return tr.text(map[state]);
}

/**
 * Renders the tab bar row plus its bottom border. Returns "" when there are
 * zero or one agents (Go renderAgentTabBar). Overlong rows truncate with an
 * ellipsis by display width.
 */
export function renderAgentTabBar(
  tr: Translator,
  tabs: AgentTab[],
  activeID: string,
  width: number,
): string {
  if (tabs.length <= 1) return "";

  const rendered = tabs.map((tab) => {
    const icon = stateIcon(tab.state);
    const label = tr.text("tool.modal.agent_tab", icon, tab.id);
    const withState = tab.state !== ""
      ? `${label} (${localizedState(tr, tab.state)})`
      : label;
    return tab.id === activeID
      ? `${accent}${bold}${withState}${reset}`
      : `${dim}${withState}${reset}`;
  });

  let row = rendered.join(" ");
  if (displayWidth(row) > width) {
    row = truncateDisplay(row, width);
  }

  const border = `${dim}${"─".repeat(Math.max(width, 0))}${reset}`;
  return `${row}\n${border}`;
}
