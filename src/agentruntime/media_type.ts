// Media-type sniffing for Runtime input and artifact intake.
//
// `detectAttachmentMediaType` depends on. `detectContentType` implements the
// WHATWG MIME sniffing algorithm over at most the first 512 bytes and always
// returns a valid MIME type, falling back to "application/octet-stream".
//
// Deviation: `[]byte` maps to `Uint8Array`; the signature table is expressed as
// plain objects instead of Go's `sniffSig` interface.

const sniffLen = 512;

/** Whether a byte is a whitespace byte (0xWS) per the MIME sniffing spec. */
function isWS(b: number): boolean {
  switch (b) {
    case 0x09:
    case 0x0a:
    case 0x0c:
    case 0x0d:
    case 0x20:
      return true;
    default:
      return false;
  }
}

/** Whether a byte is a tag-terminating byte (0xTT) per the MIME sniffing spec. */
function isTT(b: number): boolean {
  return b === 0x20 || b === 0x3e;
}

interface ExactSig {
  kind: "exact";
  sig: Uint8Array;
  ct: string;
}
interface MaskedSig {
  kind: "masked";
  mask: Uint8Array;
  pat: Uint8Array;
  skipWS: boolean;
  ct: string;
}
interface HtmlSig {
  kind: "html";
  sig: Uint8Array;
}
interface Mp4Sig {
  kind: "mp4";
}
interface TextSig {
  kind: "text";
}
type SniffSig = ExactSig | MaskedSig | HtmlSig | Mp4Sig | TextSig;

function bytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

function exact(sig: string, ct: string): ExactSig {
  return { kind: "exact", sig: bytes(sig), ct };
}

function masked(
  mask: string,
  pat: string,
  ct: string,
  skipWS = false,
): MaskedSig {
  return { kind: "masked", mask: bytes(mask), pat: bytes(pat), ct, skipWS };
}

function html(sig: string): HtmlSig {
  return { kind: "html", sig: bytes(sig) };
}

function hasPrefix(data: Uint8Array, prefix: Uint8Array): boolean {
  if (data.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (data[i] !== prefix[i]) return false;
  }
  return true;
}

function equalRange(
  data: Uint8Array,
  start: number,
  want: Uint8Array,
): boolean {
  if (start + want.length > data.length) return false;
  for (let i = 0; i < want.length; i++) {
    if (data[start + i] !== want[i]) return false;
  }
  return true;
}

/** Matching the table in section 6 of the MIME sniffing spec. */
const sniffSignatures: SniffSig[] = [
  html("<!DOCTYPE HTML"),
  html("<HTML"),
  html("<HEAD"),
  html("<SCRIPT"),
  html("<IFRAME"),
  html("<H1"),
  html("<DIV"),
  html("<FONT"),
  html("<TABLE"),
  html("<A"),
  html("<STYLE"),
  html("<TITLE"),
  html("<B"),
  html("<BODY"),
  html("<BR"),
  html("<P"),
  html("<!--"),
  masked("\xFF\xFF\xFF\xFF\xFF", "<?xml", "text/xml; charset=utf-8", true),
  exact("%PDF-", "application/pdf"),
  exact("%!PS-Adobe-", "application/postscript"),

  // UTF BOMs.
  masked(
    "\xFF\xFF\x00\x00",
    "\xFE\xFF\x00\x00",
    "text/plain; charset=utf-16be",
  ),
  masked(
    "\xFF\xFF\x00\x00",
    "\xFF\xFE\x00\x00",
    "text/plain; charset=utf-16le",
  ),
  masked("\xFF\xFF\xFF\x00", "\xEF\xBB\xBF\x00", "text/plain; charset=utf-8"),

  // Image types.
  exact("\x00\x00\x01\x00", "image/x-icon"),
  exact("\x00\x00\x02\x00", "image/x-icon"),
  exact("BM", "image/bmp"),
  exact("GIF87a", "image/gif"),
  exact("GIF89a", "image/gif"),
  masked(
    "\xFF\xFF\xFF\xFF\x00\x00\x00\x00\xFF\xFF\xFF\xFF\xFF\xFF",
    "RIFF\x00\x00\x00\x00WEBPVP",
    "image/webp",
  ),
  exact("\x89PNG\x0D\x0A\x1A\x0A", "image/png"),
  exact("\xFF\xD8\xFF", "image/jpeg"),

  // Audio and video types.
  masked(
    "\xFF\xFF\xFF\xFF\x00\x00\x00\x00\xFF\xFF\xFF\xFF",
    "FORM\x00\x00\x00\x00AIFF",
    "audio/aiff",
  ),
  masked("\xFF\xFF\xFF", "ID3", "audio/mpeg"),
  masked("\xFF\xFF\xFF\xFF\xFF", "OggS\x00", "application/ogg"),
  masked(
    "\xFF\xFF\xFF\xFF\xFF\xFF\xFF\xFF",
    "MThd\x00\x00\x00\x06",
    "audio/midi",
  ),
  masked(
    "\xFF\xFF\xFF\xFF\x00\x00\x00\x00\xFF\xFF\xFF\xFF",
    "RIFF\x00\x00\x00\x00AVI ",
    "video/avi",
  ),
  masked(
    "\xFF\xFF\xFF\xFF\x00\x00\x00\x00\xFF\xFF\xFF\xFF",
    "RIFF\x00\x00\x00\x00WAVE",
    "audio/wave",
  ),
  { kind: "mp4" },
  exact("\x1A\x45\xDF\xA3", "video/webm"),

  // Font types.
  masked(
    "\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\xFF\xFF",
    "\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00LP",
    "application/vnd.ms-fontobject",
  ),
  exact("\x00\x01\x00\x00", "font/ttf"),
  exact("OTTO", "font/otf"),
  exact("ttcf", "font/collection"),
  exact("wOFF", "font/woff"),
  exact("wOF2", "font/woff2"),

  // Archive types.
  exact("\x1F\x8B\x08", "application/x-gzip"),
  exact("PK\x03\x04", "application/zip"),
  exact("Rar!\x1A\x07\x00", "application/x-rar-compressed"),
  exact("Rar!\x1A\x07\x01\x00", "application/x-rar-compressed"),

  exact("\x00\x61\x73\x6D", "application/wasm"),

  { kind: "text" },
];

const mp4ftype = bytes("ftyp");
const mp4 = bytes("mp4");

/**
 * Implements the algorithm described at
 * https://mimesniff.spec.whatwg.org/ to determine the Content-Type of the given
 * data. It considers at most the first 512 bytes of data. It always returns a
 * valid MIME type: if it cannot determine a more specific one, it returns
 * "application/octet-stream".
 */
export function detectContentType(input: Uint8Array): string {
  const data = input.length > sniffLen ? input.subarray(0, sniffLen) : input;

  // Index of the first non-whitespace byte in data.
  let firstNonWS = 0;
  for (; firstNonWS < data.length && isWS(data[firstNonWS]); firstNonWS++) {
    // advance
  }

  for (const sig of sniffSignatures) {
    const ct = matchSignature(sig, data, firstNonWS);
    if (ct !== "") return ct;
  }

  return "application/octet-stream"; // fallback
}

function matchSignature(
  sig: SniffSig,
  data: Uint8Array,
  firstNonWS: number,
): string {
  switch (sig.kind) {
    case "exact":
      return hasPrefix(data, sig.sig) ? sig.ct : "";
    case "masked": {
      const view = sig.skipWS ? data.subarray(firstNonWS) : data;
      if (sig.pat.length !== sig.mask.length) return "";
      if (view.length < sig.pat.length) return "";
      for (let i = 0; i < sig.pat.length; i++) {
        if ((view[i] & sig.mask[i]) !== sig.pat[i]) return "";
      }
      return sig.ct;
    }
    case "html": {
      const view = data.subarray(firstNonWS);
      const h = sig.sig;
      if (view.length < h.length + 1) return "";
      for (let i = 0; i < h.length; i++) {
        let db = view[i];
        const b = h[i];
        if (b >= 0x41 && b <= 0x5a) db &= 0xdf;
        if (b !== db) return "";
      }
      if (!isTT(view[h.length])) return "";
      return "text/html; charset=utf-8";
    }
    case "mp4": {
      if (data.length < 12) return "";
      const boxSize =
        ((data[0] << 24) | (data[1] << 16) | (data[2] << 8) | data[3]) >>> 0;
      if (data.length < boxSize || boxSize % 4 !== 0) return "";
      if (!equalRange(data, 4, mp4ftype)) return "";
      for (let st = 8; st < boxSize; st += 4) {
        if (st === 12) {
          // Ignore the four bytes that correspond to the version number of the
          // "major brand".
          continue;
        }
        if (equalRange(data, st, mp4)) return "video/mp4";
      }
      return "";
    }
    case "text": {
      for (let i = firstNonWS; i < data.length; i++) {
        const b = data[i];
        if (
          b <= 0x08 || b === 0x0b || (0x0e <= b && b <= 0x1a) ||
          (0x1c <= b && b <= 0x1f)
        ) {
          return "";
        }
      }
      return "text/plain; charset=utf-8";
    }
  }
}

/**
 * Reads up to 512 bytes from `path` and sniffs its media type, mirroring Go's
 * `detectAttachmentMediaType`.
 */
export async function detectAttachmentMediaType(path: string): Promise<string> {
  const file = await Deno.open(path, { read: true });
  try {
    const buf = new Uint8Array(512);
    const n = await file.read(buf);
    return detectContentType(
      n === null ? new Uint8Array(0) : buf.subarray(0, n),
    );
  } finally {
    file.close();
  }
}
