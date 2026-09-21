// Ported from internal/serve/runtime/attachments.go.

import type { Attachment } from "../../provider/types.ts";

/** formatAttachmentSummary renders provider-neutral attachment references. */
export function formatAttachmentSummary(items: Attachment[]): string {
  if (!items || items.length === 0) return "";
  const lines: string[] = ["Attachments:"];
  const seen = new Set<string>();
  for (const item of items) {
    let label = (item.name ?? "").trim();
    if (label === "") label = (item.kind ?? "").trim();
    if (label === "") label = "attachment";
    let target = (item.url ?? "").trim();
    if (target === "") target = (item.providerRef ?? "").trim();
    if (target === "") continue;
    const key = label + "\x00" + target;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(`- ${label}: ${target}`);
  }
  if (lines.length === 1) return "";
  return lines.join("\n");
}
