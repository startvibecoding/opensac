// the horizontal tab bar showing
// all active agents (lead + team members). Hidden with zero or one agent.
// The Go original reads live state from agent.AgentManager; the TS projection
// takes a plain snapshot array so the renderer stays DOM-free and testable.

import { displayWidth, truncateDisplay } from "./formatters.ts";
import { type MessageID, Translator } from "./i18n.ts";
import {
  ACCENT as accent,
  BOLD as bold,
  DIM as dim,
  GREEN as green,
  ORANGE as orange,
  RED as red,
  RESET as reset,
} from "./theme.ts";

export type AgentTabState =
  "running" | "ready" | "done" | "error" | "canceled" | "";

/** One tab snapshot; `id` is the canonical AgentID. */
export interface AgentTab {
  id: string;
  state: AgentTabState;
}

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
    const withState =
      tab.state !== "" ? `${label} (${localizedState(tr, tab.state)})` : label;
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
