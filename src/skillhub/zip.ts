// Minimal ZIP reader/writer used by the skillhub installer.
//
// Go's archive/zip is not available in Node; this module implements only the
// subset needed for safe extraction (central-directory parsing, stored and
// deflate entries via DecompressionStream) plus a small writer so tests can
// build real archives without a dependency.

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const S_IFMT = 0xf000;
const S_IFDIR = 0x4000;
const S_IFLNK = 0xa000;

export interface ZipEntry {
  name: string;
  isDir: boolean;
  isSymlink: boolean;
  uncompressedSize: number;
  /** Decompresses the entry's bytes. */
  read(): Promise<Uint8Array>;
}

/** Parses a ZIP archive's central directory and exposes its entries. */
export function readZipEntries(data: Uint8Array): ZipEntry[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const eocd = findEndOfCentralDirectory(view);
  if (eocd < 0) throw new Error("zip: end of central directory not found");
  const count = view.getUint16(eocd + 10, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  const entries: ZipEntry[] = [];
  let cursor = centralOffset;
  for (let i = 0; i < count; i++) {
    if (view.getUint32(cursor, true) !== CENTRAL_SIGNATURE) {
      throw new Error("zip: invalid central directory entry");
    }
    const method = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLen = view.getUint16(cursor + 28, true);
    const extraLen = view.getUint16(cursor + 30, true);
    const commentLen = view.getUint16(cursor + 32, true);
    const externalAttrs = view.getUint32(cursor + 38, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const name = new TextDecoder().decode(
      data.subarray(cursor + 46, cursor + 46 + nameLen),
    );
    const mode = (externalAttrs >>> 16) & S_IFMT;
    const isDir = name.endsWith("/") || mode === S_IFDIR;
    const isSymlink = mode === S_IFLNK;
    const dataStart = localDataOffset(view, data, localOffset);
    const slice = data.subarray(dataStart, dataStart + compressedSize);
    entries.push({
      name,
      isDir,
      isSymlink,
      uncompressedSize,
      read: () => decompress(method, slice),
    });
    cursor += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function findEndOfCentralDirectory(view: DataView): number {
  const min = Math.max(0, view.byteLength - 22 - 0xffff);
  for (let i = view.byteLength - 22; i >= min; i--) {
    if (view.getUint32(i, true) === EOCD_SIGNATURE) return i;
  }
  return -1;
}

function localDataOffset(
  view: DataView,
  data: Uint8Array,
  localOffset: number,
): number {
  if (view.getUint32(localOffset, true) !== LOCAL_SIGNATURE) {
    throw new Error("zip: invalid local file header");
  }
  const nameLen = view.getUint16(localOffset + 26, true);
  const extraLen = view.getUint16(localOffset + 28, true);
  void data;
  return localOffset + 30 + nameLen + extraLen;
}

function decompress(method: number, slice: Uint8Array): Promise<Uint8Array> {
  if (method === 0) return Promise.resolve(slice.slice());
  if (method === 8) {
    return transform(slice, new DecompressionStream("deflate-raw"));
  }
  return Promise.reject(
    new Error(`zip: unsupported compression method ${method}`),
  );
}

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

// TypeScript's DOM lib types CompressionStream.writable as
// WritableStream<BufferSource>, which is not assignable to the generic
// Uint8Array pipeThrough signature; the cast is safe for these codecs.
async function transform(
  bytes: Uint8Array,
  codec: DecompressionStream | CompressionStream,
): Promise<Uint8Array> {
  const stream = streamOf(bytes).pipeThrough(
    codec as unknown as ReadableWritablePair<Uint8Array, Uint8Array>,
  );
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// --- Writer (test helper) ---

export interface ZipWriteEntry {
  name: string;
  content: Uint8Array | string;
  /** Unix mode; defaults to a regular file (0644). */
  mode?: number;
  dir?: boolean;
}

/**
 * Builds a minimal ZIP archive. Entries use deflate by default; pass
 * `store: true` for stored (method 0) entries.
 */
export async function createZip(
  entries: ZipWriteEntry[],
  options: { store?: boolean } = {},
): Promise<Uint8Array> {
  const method = options.store ? 0 : 8;
  const encoder = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const raw = entry.dir
      ? new Uint8Array(0)
      : typeof entry.content === "string"
        ? encoder.encode(entry.content)
        : entry.content;
    const compressed = entry.dir
      ? new Uint8Array(0)
      : method === 8
        ? await deflateRaw(raw)
        : raw;
    const crc = crc32(raw);
    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, LOCAL_SIGNATURE, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0, true);
    lv.setUint16(8, method, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, compressed.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    localParts.push(local, compressed);

    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, CENTRAL_SIGNATURE, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(10, method, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, compressed.length, true);
    cv.setUint32(24, raw.length, true);
    cv.setUint16(28, nameBytes.length, true);
    const mode = entry.mode ?? (entry.dir ? 0o040755 : 0o100644);
    cv.setUint32(38, mode << 16, true);
    cv.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    centralParts.push(central);

    offset += local.length + compressed.length;
  }
  const centralSize = centralParts.reduce((n, p) => n + p.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, EOCD_SIGNATURE, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  const all = [...localParts, ...centralParts, eocd];
  const total = all.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const part of all) {
    out.set(part, cursor);
    cursor += part.length;
  }
  return out;
}

function deflateRaw(raw: Uint8Array): Promise<Uint8Array> {
  return transform(raw, new CompressionStream("deflate-raw"));
}

let crcTable: Uint32Array | undefined;

function crc32(data: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
