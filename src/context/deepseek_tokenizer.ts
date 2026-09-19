// Ported from internal/context/deepseek_tokenizer.go
//
// DeepSeek V3's tokenizer is a byte-level BPE tokenizer. The vocabulary and
// merge ranks are loaded from the vendored tokenizer JSON so token estimates
// are deterministic and do not require Python or a network connection at
// runtime. The JSON is embedded into the compiled binary via
// `deno compile --include src/context/tokenizerdata`.

/** DeepSeek V3 applies regex splitting before byte-level BPE. */
const DEEPSEEK_PRE_TOKEN_PATTERN =
  /\p{N}{1,3}|[一-龥\u3040-\u30ff]+|[!"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~][A-Za-z]+|[^\r\n\p{L}\p{P}\p{S}]?[\p{L}\p{M}]+| ?[\p{P}\p{S}]+[\r\n]*|\s*[\r\n]+|\s+/gu;

function deepSeekPretokenize(text: string): string[] {
  const matches = text.match(DEEPSEEK_PRE_TOKEN_PATTERN);
  if ((matches === null || matches.length === 0) && text !== "") {
    return [text];
  }
  return matches ?? [];
}

interface DeepSeekTokenizerFile {
  added_tokens?: Array<{ id: number; content: string }>;
  model?: {
    vocab?: Record<string, number>;
    merges?: string[];
  };
}

interface DeepSeekTokenizer {
  vocab: Set<string>;
  ranks: Map<string, number>;
  addedByLength: string[];
}

let deepSeekTok: DeepSeekTokenizer | null | undefined;

function tokenizerDataURL(): URL {
  return new URL("./tokenizerdata/deepseek_v3_tokenizer.json", import.meta.url);
}

function loadDeepSeekTokenizer(): DeepSeekTokenizer | null {
  if (deepSeekTok !== undefined) return deepSeekTok;
  let file: DeepSeekTokenizerFile;
  try {
    const data = Deno.readTextFileSync(tokenizerDataURL());
    file = JSON.parse(data) as DeepSeekTokenizerFile;
  } catch {
    deepSeekTok = null;
    return null;
  }
  const vocabMap = file.model?.vocab;
  if (vocabMap === undefined || Object.keys(vocabMap).length === 0) {
    deepSeekTok = null;
    return null;
  }
  const merges = file.model?.merges ?? [];
  const ranks = new Map<string, number>();
  for (let i = 0; i < merges.length; i++) {
    ranks.set(merges[i], i);
  }
  const added = new Set<string>();
  for (const token of file.added_tokens ?? []) {
    if (token.content !== "") added.add(token.content);
  }
  const addedByLength = [...added];
  addedByLength.sort((a, b) => b.length - a.length);
  deepSeekTok = {
    vocab: new Set(Object.keys(vocabMap)),
    ranks,
    addedByLength,
  };
  return deepSeekTok;
}

/**
 * Counts tokens using the distributed DeepSeek V3 tokenizer. It intentionally
 * counts plain text only; message framing is accounted for by the caller when
 * constructing a request estimate.
 */
export function deepSeekTokenCount(text: string): number {
  const tok = loadDeepSeekTokenizer();
  if (tok === null || text === "") {
    return 0;
  }
  let total = 0;
  let remaining = text;
  while (remaining !== "") {
    const special = deepSeekConsumeAddedToken(tok, remaining);
    if (special !== null) {
      total++;
      remaining = remaining.slice(special.length);
      continue;
    }
    let nextSpecial = remaining.length;
    for (const candidate of tok.addedByLength) {
      const pos = remaining.indexOf(candidate);
      if (pos >= 0 && pos < nextSpecial) {
        nextSpecial = pos;
      }
    }
    const chunk = remaining.slice(0, nextSpecial);
    for (const piece of deepSeekPretokenize(chunk)) {
      total += deepSeekBPETokenCount(tok, piece);
    }
    remaining = remaining.slice(nextSpecial);
  }
  return total;
}

function deepSeekConsumeAddedToken(
  tok: DeepSeekTokenizer,
  text: string,
): string | null {
  for (const special of tok.addedByLength) {
    if (text.startsWith(special)) {
      return special;
    }
  }
  return null;
}

/** Symbol pair used by the BPE merge queue. */
interface DeepSeekPair {
  left: number;
  right: number;
  rank: number;
}

/** Binary min-heap ordered by (rank, left), mirroring the Go container/heap. */
class DeepSeekPairHeap {
  private readonly items: DeepSeekPair[] = [];

  get length(): number {
    return this.items.length;
  }

  private less(a: DeepSeekPair, b: DeepSeekPair): boolean {
    if (a.rank !== b.rank) return a.rank < b.rank;
    return a.left < b.left;
  }

  push(item: DeepSeekPair): void {
    const items = this.items;
    items.push(item);
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.less(items[i], items[parent])) break;
      [items[i], items[parent]] = [items[parent], items[i]];
      i = parent;
    }
  }

  pop(): DeepSeekPair | undefined {
    const items = this.items;
    if (items.length === 0) return undefined;
    const top = items[0];
    const last = items.pop() as DeepSeekPair;
    if (items.length > 0) {
      items[0] = last;
      let i = 0;
      const n = items.length;
      for (;;) {
        const left = 2 * i + 1;
        const right = left + 1;
        let smallest = i;
        if (left < n && this.less(items[left], items[smallest])) {
          smallest = left;
        }
        if (right < n && this.less(items[right], items[smallest])) {
          smallest = right;
        }
        if (smallest === i) break;
        [items[i], items[smallest]] = [items[smallest], items[i]];
        i = smallest;
      }
    }
    return top;
  }
}

function deepSeekBPETokenCount(tok: DeepSeekTokenizer, piece: string): number {
  // GPT-style byte-level encoding maps bytes to the printable Unicode range
  // used by tokenizer.json. This is the same reversible mapping used by the
  // Hugging Face ByteLevel pre-tokenizer.
  const bytes = new TextEncoder().encode(piece);
  const symbols: string[] = new Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    symbols[i] = String.fromCodePoint(deepSeekByteToRune(bytes[i]));
  }
  if (symbols.length === 0) {
    return 0;
  }
  const merged = deepSeekBPEMerge(tok, symbols);
  let count = 0;
  for (const symbol of merged) {
    if (tok.vocab.has(symbol)) {
      count++;
    } else {
      // Keep the estimator conservative if a future tokenizer file has a
      // merge not represented in its vocabulary.
      count += new TextEncoder().encode(symbol).length;
    }
  }
  return count;
}

function deepSeekBPEMerge(tok: DeepSeekTokenizer, symbols: string[]): string[] {
  const n = symbols.length;
  if (n < 2) {
    return symbols;
  }
  const prev = new Array<number>(n);
  const next = new Array<number>(n);
  const active = new Array<boolean>(n);
  for (let i = 0; i < n; i++) {
    prev[i] = i - 1;
    next[i] = i + 1;
    active[i] = true;
  }
  next[n - 1] = -1;

  const h = new DeepSeekPairHeap();
  const pushPair = (left: number, right: number): void => {
    if (left < 0 || right < 0 || !active[left] || !active[right]) {
      return;
    }
    const rank = tok.ranks.get(symbols[left] + " " + symbols[right]);
    if (rank !== undefined) {
      h.push({ left, right, rank });
    }
  };
  for (let i = 0; i + 1 < n; i++) {
    pushPair(i, i + 1);
  }

  let activeCount = n;
  while (h.length > 0 && activeCount > 1) {
    const pair = h.pop();
    if (pair === undefined) break;
    if (!active[pair.left] || !active[pair.right]) continue;
    if (next[pair.left] !== pair.right) continue;
    const rank = tok.ranks.get(symbols[pair.left] + " " + symbols[pair.right]);
    if (rank === undefined || rank !== pair.rank) continue;
    const left = pair.left;
    const right = pair.right;
    symbols[left] += symbols[right];
    active[right] = false;
    activeCount--;
    const after = next[right];
    next[left] = after;
    if (after >= 0) {
      prev[after] = left;
    }
    pushPair(prev[left], left);
    pushPair(left, next[left]);
  }

  const merged: string[] = [];
  for (let i = 0; i >= 0; i = next[i]) {
    if (active[i]) {
      merged.push(symbols[i]);
    }
  }
  return merged;
}

function deepSeekByteToRune(b: number): number {
  // bytes that already have a printable representation
  if (
    (b >= 0x21 && b <= 0x7e) || (b >= 0xa1 && b <= 0xac) ||
    (b >= 0xae && b <= 0xff)
  ) {
    return b;
  }
  let n = 0;
  for (let i = 0; i < b; i++) {
    if (
      !((i >= 0x21 && i <= 0x7e) || (i >= 0xa1 && i <= 0xac) ||
        (i >= 0xae && i <= 0xff))
    ) {
      n++;
    }
  }
  return 0x100 + n;
}
