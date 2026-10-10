// Session listing/deletion projection for the TUI command layer.
//
// The listing itself is Core-owned (`TUIService.listPersistedSessions`); this
// module only formats the shared rows for the transcript, so it never opens a
// database or builds SQL.

import { type TUISessionListEntry } from "./service.ts";

/** Formats one session row for the transcript. */
export function formatSessionEntry(
  detail: TUISessionListEntry,
  current: boolean,
): string {
  const marker = current ? "*" : " ";
  const when = detail.modTime.toISOString();
  const preview = detail.preview.trim().replace(/\s+/g, " ").slice(0, 60);
  return `  [${marker}] ${detail.sessionId} (${detail.messageCount}) ${when}${
    preview === "" ? "" : ` — ${preview}`
  }`;
}

/** Presents the session list; the caller appends the active-session marker. */
export function renderSessionList(
  details: TUISessionListEntry[],
  currentID: string,
  title: (count: number) => string,
  empty: string,
): string {
  if (details.length === 0) return empty;
  const lines = [title(details.length)];
  for (const detail of details) {
    lines.push(formatSessionEntry(detail, detail.sessionId === currentID));
  }
  return lines.join("\n");
}
