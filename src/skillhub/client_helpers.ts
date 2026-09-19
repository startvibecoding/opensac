// Ported from internal/skillhub/client_helpers.go and factory.go

import { endpoint, type HttpClient, statusText } from "./http.ts";
import type { SkillSummary } from "./types.ts";

/** Clamps a requested limit to the 1..100 range, defaulting to 20. */
export function boundedLimit(limit: number | undefined): number {
  if (!limit || limit <= 0) return 20;
  if (limit > 100) return 100;
  return limit;
}

/** Case-insensitive substring filter over name/displayName/description. */
export function filterSkills(
  items: SkillSummary[],
  query: string,
): SkillSummary[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return items;
  return items.filter((item) =>
    item.name.toLowerCase().includes(needle) ||
    item.displayName.toLowerCase().includes(needle) ||
    item.description.toLowerCase().includes(needle)
  );
}

/** Performs a GET and returns the response body stream on success. */
export async function download(
  client: HttpClient,
  url: string,
  signal?: AbortSignal,
): Promise<ReadableStream<Uint8Array>> {
  const response = await client(url, { method: "GET", signal });
  if (response.status < 200 || response.status >= 300) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`GET ${url}: ${statusText(response)}`);
  }
  if (!response.body) throw new Error(`GET ${url}: empty body`);
  return response.body;
}

/** Re-exported for callers that build URLs. */
export { endpoint };
