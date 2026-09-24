// Shared JSON decoding for externally influenced input: user-edited config
// files, protocol payloads, and third-party tool output. Go's `json.Unmarshal`
// at least shape-checked into a struct and returned an error; a bare
// `JSON.parse(x) as T` asserts nothing and lets `undefined` (or a crash on
// `null`) propagate past the boundary. These readers keep the failure at the
// boundary: absent or mistyped fields read as `undefined`, and callers keep
// their existing fallback semantics.

/** Returns the value as a plain object record, or undefined. */
export function asJsonRecord(
  value: unknown,
): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

/** Parses JSON text into a plain object record, or undefined. */
export function parseJsonRecord(
  text: string,
): Record<string, unknown> | undefined {
  try {
    return asJsonRecord(JSON.parse(text));
  } catch {
    return undefined;
  }
}

/** Reads a string field, or undefined when absent or mistyped. */
export function optString(obj: unknown, key: string): string | undefined {
  const rec = asJsonRecord(obj);
  if (rec === undefined) return undefined;
  const v = rec[key];
  return typeof v === "string" ? v : undefined;
}

/** Reads a number field, or undefined when absent or mistyped. */
export function optNumber(obj: unknown, key: string): number | undefined {
  const rec = asJsonRecord(obj);
  if (rec === undefined) return undefined;
  const v = rec[key];
  return typeof v === "number" ? v : undefined;
}

/** Reads a boolean field, or undefined when absent or mistyped. */
export function optBoolean(obj: unknown, key: string): boolean | undefined {
  const rec = asJsonRecord(obj);
  if (rec === undefined) return undefined;
  const v = rec[key];
  return typeof v === "boolean" ? v : undefined;
}

/** Reads an array-of-strings field, or undefined when absent or mistyped. */
export function optStringArray(
  obj: unknown,
  key: string,
): string[] | undefined {
  const rec = asJsonRecord(obj);
  if (rec === undefined) return undefined;
  const v = rec[key];
  if (!Array.isArray(v)) return undefined;
  if (!v.every((item) => typeof item === "string")) return undefined;
  return [...v] as string[];
}

/** Reads a plain-object field, or undefined when absent or not an object. */
export function optRecord(
  obj: unknown,
  key: string,
): Record<string, unknown> | undefined {
  const rec = asJsonRecord(obj);
  if (rec === undefined) return undefined;
  return asJsonRecord(rec[key]);
}

/** Reads a string-to-string map field, or undefined when absent or mistyped. */
export function optStringMap(
  obj: unknown,
  key: string,
): Record<string, string> | undefined {
  const rec = asJsonRecord(obj);
  if (rec === undefined) return undefined;
  const v = asJsonRecord(rec[key]);
  if (v === undefined) return undefined;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) {
    if (typeof val === "string") out[k] = val;
  }
  return out;
}
