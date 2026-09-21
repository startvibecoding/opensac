// Session listing/deletion projection for the TUI command layer.
//
// The listing itself is DAO-backed through `src/session/manager.ts`; this module
// only formats the shared rows for the transcript, so it never opens a database
// or builds SQL.

import { listForDirDetailed, type SessionDetail } from "../session/manager.ts";

/** Lists session details for a working directory (Go ListForDirDetailed). */
export function listManagerSessions(
  cwd: string,
  sessionDir: string,
): SessionDetail[] {
  return listForDirDetailed(cwd, sessionDir);
}

/** Formats one session row for the transcript. */
export function formatSessionEntry(
  detail: SessionDetail,
  current: boolean,
): string {
  const marker = current ? "*" : " ";
  const when = detail.modTime.toISOString();
  const preview = detail.preview.trim().replace(/\s+/g, " ").slice(0, 60);
  return `  [${marker}] ${detail.id} (${detail.messageCount}) ${when}${
    preview === "" ? "" : ` — ${preview}`
  }`;
}

/** Presents the session list; the caller appends the active-session marker. */
export function renderSessionList(
  details: SessionDetail[],
  currentID: string,
  title: (count: number) => string,
  empty: string,
): string {
  if (details.length === 0) return empty;
  const lines = [title(details.length)];
  for (const detail of details) {
    lines.push(formatSessionEntry(detail, detail.id === currentID));
  }
  return lines.join("\n");
}
