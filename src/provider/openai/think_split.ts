// Ported from internal/provider/openai/think_split.go

// The tag literals use Unicode escapes so the source is not rewritten by
// tooling that treats "<...>" as markup.
export const thinkOpenTag = "\u003cthink\u003e";
export const thinkCloseTag = "\u003c/think\u003e";

/**
 * Streaming state machine that separates reasoning content wrapped in
 * `think` tags from regular text content. Some OpenAI-compatible models inline
 * their reasoning in the content field using these tags instead of providing a
 * separate reasoning_content field.
 *
 * It handles tags split across multiple stream chunks by holding back a
 * partial-tag suffix until enough characters arrive to disambiguate.
 */
export class ThinkSplitter {
  private inThink = false;
  /**
   * Holds a trailing fragment that may be the start of a tag and cannot yet be
   * classified as text/think output.
   */
  private pending = "";

  /**
   * Feeds the next content delta and returns any text and thinking output that
   * can be emitted so far. Either return value may be empty.
   */
  push(delta: string): { text: string; think: string } {
    let buf = this.pending + delta;
    this.pending = "";

    let textOut = "";
    let thinkOut = "";

    while (buf.length > 0) {
      if (this.inThink) {
        const idx = buf.indexOf(thinkCloseTag);
        if (idx < 0) {
          // No close tag yet. Emit everything except a possible partial close
          // tag at the end.
          const [safe, hold] = splitPartialSuffix(buf, thinkCloseTag);
          thinkOut += safe;
          this.pending = hold;
          buf = "";
          continue;
        }
        thinkOut += buf.slice(0, idx);
        buf = buf.slice(idx + thinkCloseTag.length);
        this.inThink = false;
      } else {
        const idx = buf.indexOf(thinkOpenTag);
        if (idx < 0) {
          const [safe, hold] = splitPartialSuffix(buf, thinkOpenTag);
          textOut += safe;
          this.pending = hold;
          buf = "";
          continue;
        }
        textOut += buf.slice(0, idx);
        buf = buf.slice(idx + thinkOpenTag.length);
        this.inThink = true;
      }
    }

    return { text: textOut, think: thinkOut };
  }

  /**
   * Returns any buffered content remaining after the stream ends. A partial tag
   * fragment is treated as literal output in whatever mode is active.
   */
  flush(): { text: string; think: string } {
    if (this.pending === "") {
      return { text: "", think: "" };
    }
    const rest = this.pending;
    this.pending = "";
    if (this.inThink) {
      return { text: "", think: rest };
    }
    return { text: rest, think: "" };
  }
}

/**
 * Returns the portion of s that can be safely emitted now and the trailing
 * fragment that might be the beginning of tag. The held fragment is the longest
 * suffix of s that is a proper prefix of tag.
 */
export function splitPartialSuffix(
  s: string,
  tag: string,
): [safe: string, hold: string] {
  let maxHold = tag.length - 1;
  if (maxHold > s.length) maxHold = s.length;
  for (let n = maxHold; n > 0; n--) {
    if (tag.startsWith(s.slice(s.length - n))) {
      return [s.slice(0, s.length - n), s.slice(s.length - n)];
    }
  }
  return [s, ""];
}
