// Normalized durable JSON for the Run/delivery stores.
//
// A shared JSON normalization helper for the durable Run/delivery stores: an
// absent or invalid value collapses to an empty object so a partially written
// recovery payload can never corrupt the JSON columns.

/**
 * Normalizes a durable JSON value to a bindable string. Empty or invalid input
 * becomes `"{}"`, mirroring Go's `normalizedRunJSON`.
 */
export function normalizedRunJSON(value: unknown): string {
  if (value === undefined || value === null) return "{}";
  try {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    if (text === undefined || text === "") return "{}";
    JSON.parse(text);
    return text;
  } catch {
    return "{}";
  }
}
