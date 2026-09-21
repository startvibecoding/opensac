// Ported from internal/tui/app_paste.go: large pastes fold into a numbered
// marker (`[paste #1 +15 lines]`) inserted into the input, and expand back to
// their original text at submit time. Small pastes insert directly.
//
// Markers are plain text, so the editor, history, and suggestions all keep
// working without paste awareness; only this store maps markers to content.

/** A paste is "large" above this many lines or characters (Go handlePaste). */
export const PASTE_LINE_LIMIT = 5;
export const PASTE_CHAR_LIMIT = 500;

export class PasteStore {
  #counter = 0;
  #pastes = new Map<number, string>();

  /** The number of stored pastes (Go pasteCounter). */
  get size(): number {
    return this.#pastes.size;
  }

  /**
   * Returns the text to insert for one pasted payload: the payload itself when
   * small, or a folded marker when it exceeds the limits.
   */
  fold(text: string): string {
    const normalized = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
    const lines = normalized.split("\n");
    const totalChars = normalized.length;
    if (lines.length <= PASTE_LINE_LIMIT && totalChars <= PASTE_CHAR_LIMIT) {
      return normalized;
    }
    this.#counter++;
    const id = this.#counter;
    this.#pastes.set(id, normalized);
    if (lines.length > PASTE_LINE_LIMIT) {
      return `[paste #${id} +${lines.length} lines]`;
    }
    return `[paste #${id} ${totalChars} chars]`;
  }

  /**
   * Expands every marker present in `text` back to its stored payload and drops
   * the used entries. Unreferenced pastes are kept (the user may have edited a
   * marker out of the draft and re-added it).
   */
  expand(text: string): string {
    let result = text;
    const used: number[] = [];
    for (const [id, content] of this.#pastes) {
      const markers = [
        `[paste #${id} +${content.split("\n").length} lines]`,
        `[paste #${id} ${content.length} chars]`,
      ];
      let hit = false;
      for (const marker of markers) {
        if (result.includes(marker)) {
          result = result.replaceAll(marker, content);
          hit = true;
        }
      }
      if (hit) used.push(id);
    }
    for (const id of used) this.#pastes.delete(id);
    return result;
  }

  /** Drops all stored pastes (Go /clear). */
  reset(): void {
    this.#counter = 0;
    this.#pastes.clear();
  }
}
