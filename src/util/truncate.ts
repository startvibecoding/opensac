/** Returns a valid UTF-8 prefix of `s` whose byte length is at most `maxBytes`. */
export function truncateString(s: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const bytes = new TextEncoder().encode(s);
  if (bytes.length <= maxBytes) return s;
  // Mirror Go's `for idx := range s` byte-index iteration: find the last
  // rune-start byte index that is <= maxBytes.
  let end = 0;
  for (let idx = 0; idx < bytes.length; idx++) {
    // A rune start is a byte that is not a UTF-8 continuation byte.
    if ((bytes[idx] & 0xc0) === 0x80) continue;
    if (idx > maxBytes) break;
    end = idx;
  }
  if (end === 0) return "";
  return new TextDecoder().decode(bytes.slice(0, end));
}

/** Truncates `s` with `truncateString` and appends `suffix` when truncation occurs. */
export function truncateWithSuffix(
  s: string,
  maxBytes: number,
  suffix: string,
): string {
  const bytes = new TextEncoder().encode(s);
  if (bytes.length <= maxBytes) return s;
  return truncateString(s, maxBytes) + suffix;
}
