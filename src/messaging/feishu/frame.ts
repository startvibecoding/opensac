// Ported from the larksuite/oapi-sdk-go v3 `ws` package (pbbp2 framing).
//
// The Go SDK's generated protobuf `Frame`/`Header` types are replaced by a
// small hand-rolled protobuf codec covering exactly the fields the Feishu
// long-connection protocol uses. Wire field numbers match `ws/pbbp2.pb.go`:
//
//   message Header { 1 key; 2 value; }
//   message Frame  {
//     1 SeqID; 2 LogID; 3 service; 4 method; 5 headers;
//     6 payload_encoding; 7 payload_type; 8 payload; 9 LogIDNew;
//   }

export interface FrameHeader {
  key: string;
  value: string;
}

export interface Frame {
  seqID: number;
  logID: number;
  service: number;
  method: number;
  headers: FrameHeader[];
  payloadEncoding: string;
  payloadType: string;
  payload: Uint8Array;
  logIDNew: string;
}

export const FrameTypeControl = 0;
export const FrameTypeData = 1;

export const MessageTypeEvent = "event";
export const MessageTypeCard = "card";
export const MessageTypePing = "ping";
export const MessageTypePong = "pong";

export const HeaderTimestamp = "timestamp";
export const HeaderType = "type";
export const HeaderMessageID = "message_id";
export const HeaderSum = "sum";
export const HeaderSeq = "seq";
export const HeaderTraceID = "trace_id";
export const HeaderInstanceID = "instance_id";
export const HeaderBizRt = "biz_rt";
export const HeaderHandshakeStatus = "Handshake-Status";
export const HeaderHandshakeMsg = "Handshake-Msg";
export const HeaderHandshakeAuthErrCode = "Handshake-Autherrcode";

export const GenEndpointUri = "/callback/ws/endpoint";
export const DeviceID = "device_id";
export const ServiceID = "service_id";

export const OK = 0;
export const SystemBusy = 1;
export const Forbidden = 403;
export const AuthFailed = 514;
export const ExceedConnLimit = 1000040350;
export const InternalError = 1000040343;

/** headersGetString mirrors ws.Headers.GetString. */
export function headersGetString(
  headers: FrameHeader[],
  key: string,
): string {
  for (const header of headers) {
    if (header.key === key) {
      return header.value;
    }
  }
  return "";
}

/** headersGetInt mirrors ws.Headers.GetInt (non-numeric values return 0). */
export function headersGetInt(headers: FrameHeader[], key: string): number {
  const raw = headersGetString(headers, key);
  if (raw === "") {
    return 0;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** headersAdd appends a header, matching ws.Headers.Add. */
export function headersAdd(
  headers: FrameHeader[],
  key: string,
  value: string,
): void {
  headers.push({ key, value });
}

// --- Minimal protobuf codec ---

const WIRE_VARINT = 0;
const WIRE_LEN = 2;

function writeVarint(out: number[], value: number): void {
  let v = value >>> 0;
  if (value > 0xffffffff) {
    // Handle values up to 2^53 with a bigint-free loop.
    let big = BigInt(value);
    while (big > 0x7fn) {
      out.push(Number((big & 0x7fn) | 0x80n));
      big >>= 7n;
    }
    out.push(Number(big));
    return;
  }
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v);
}

function writeTag(out: number[], field: number, wire: number): void {
  writeVarint(out, (field << 3) | wire);
}

function writeBytes(out: number[], bytes: Uint8Array): void {
  writeVarint(out, bytes.length);
  for (const b of bytes) {
    out.push(b);
  }
}

function writeString(out: number[], value: string): void {
  writeBytes(out, new TextEncoder().encode(value));
}

function writeVarintField(
  out: number[],
  field: number,
  value: number,
): void {
  if (value === 0) {
    return;
  }
  writeTag(out, field, WIRE_VARINT);
  writeVarint(out, value);
}

function writeStringField(
  out: number[],
  field: number,
  value: string,
): void {
  if (value === "") {
    return;
  }
  writeTag(out, field, WIRE_LEN);
  writeString(out, value);
}

function writeBytesField(
  out: number[],
  field: number,
  value: Uint8Array,
): void {
  if (value.length === 0) {
    return;
  }
  writeTag(out, field, WIRE_LEN);
  writeBytes(out, value);
}

/** marshalFrame encodes a Frame, mirroring generated proto Marshal. */
export function marshalFrame(frame: Frame): Uint8Array {
  const out: number[] = [];
  writeVarintField(out, 1, frame.seqID);
  writeVarintField(out, 2, frame.logID);
  writeVarintField(out, 3, frame.service);
  writeVarintField(out, 4, frame.method);
  for (const header of frame.headers) {
    writeTag(out, 5, WIRE_LEN);
    const headerOut: number[] = [];
    writeStringField(headerOut, 1, header.key);
    writeStringField(headerOut, 2, header.value);
    writeBytes(out, new Uint8Array(headerOut));
  }
  writeStringField(out, 6, frame.payloadEncoding);
  writeStringField(out, 7, frame.payloadType);
  writeBytesField(out, 8, frame.payload);
  writeStringField(out, 9, frame.logIDNew);
  return new Uint8Array(out);
}

/** unmarshalFrame decodes a Frame, mirroring generated proto Unmarshal. */
export function unmarshalFrame(data: Uint8Array): Frame {
  const frame: Frame = {
    seqID: 0,
    logID: 0,
    service: 0,
    method: 0,
    headers: [],
    payloadEncoding: "",
    payloadType: "",
    payload: new Uint8Array(),
    logIDNew: "",
  };
  let offset = 0;
  while (offset < data.length) {
    const tag = readVarint(data, offset);
    offset = tag.next;
    const field = tag.value >>> 3;
    const wire = tag.value & 0x7;
    switch (field) {
      case 1: {
        const r = readVarintWire(data, offset);
        frame.seqID = r.value;
        offset = r.next;
        break;
      }
      case 2: {
        const r = readVarintWire(data, offset);
        frame.logID = r.value;
        offset = r.next;
        break;
      }
      case 3: {
        const r = readVarintWire(data, offset);
        frame.service = r.value | 0;
        offset = r.next;
        break;
      }
      case 4: {
        const r = readVarintWire(data, offset);
        frame.method = r.value | 0;
        offset = r.next;
        break;
      }
      case 5: {
        const r = readBytesWire(data, offset);
        frame.headers.push(unmarshalHeader(r.value));
        offset = r.next;
        break;
      }
      case 6: {
        const r = readBytesWire(data, offset);
        frame.payloadEncoding = new TextDecoder().decode(r.value);
        offset = r.next;
        break;
      }
      case 7: {
        const r = readBytesWire(data, offset);
        frame.payloadType = new TextDecoder().decode(r.value);
        offset = r.next;
        break;
      }
      case 8: {
        const r = readBytesWire(data, offset);
        frame.payload = r.value;
        offset = r.next;
        break;
      }
      case 9: {
        const r = readBytesWire(data, offset);
        frame.logIDNew = new TextDecoder().decode(r.value);
        offset = r.next;
        break;
      }
      default: {
        const r = skipWire(data, offset, wire);
        offset = r;
        break;
      }
    }
  }
  return frame;
}

function unmarshalHeader(data: Uint8Array): FrameHeader {
  const header: FrameHeader = { key: "", value: "" };
  let offset = 0;
  while (offset < data.length) {
    const tag = readVarint(data, offset);
    offset = tag.next;
    const field = tag.value >>> 3;
    const wire = tag.value & 0x7;
    switch (field) {
      case 1: {
        const r = readBytesWire(data, offset);
        header.key = new TextDecoder().decode(r.value);
        offset = r.next;
        break;
      }
      case 2: {
        const r = readBytesWire(data, offset);
        header.value = new TextDecoder().decode(r.value);
        offset = r.next;
        break;
      }
      default:
        offset = skipWire(data, offset, wire);
        break;
    }
  }
  return header;
}

function readVarint(
  data: Uint8Array,
  offset: number,
): { value: number; next: number } {
  let result = 0;
  let shift = 0;
  let pos = offset;
  while (pos < data.length) {
    const byte = data[pos++];
    result += (byte & 0x7f) * Math.pow(2, shift);
    if ((byte & 0x80) === 0) {
      break;
    }
    shift += 7;
    if (shift > 63) {
      break;
    }
  }
  return { value: result, next: pos };
}

function readVarintWire(
  data: Uint8Array,
  offset: number,
): { value: number; next: number } {
  return readVarint(data, offset);
}

function readBytesWire(
  data: Uint8Array,
  offset: number,
): { value: Uint8Array; next: number } {
  const len = readVarint(data, offset);
  const start = len.next;
  const end = start + len.value;
  return { value: data.subarray(start, end), next: end };
}

function skipWire(data: Uint8Array, offset: number, wire: number): number {
  switch (wire) {
    case WIRE_VARINT:
      return readVarint(data, offset).next;
    case WIRE_LEN:
      return readBytesWire(data, offset).next;
    case 5:
      return offset + 4;
    case 1:
      return offset + 8;
    default:
      return data.length;
  }
}

/** newPingFrame mirrors ws.NewPingFrame. */
export function newPingFrame(serviceID: number): Frame {
  const headers: FrameHeader[] = [];
  headersAdd(headers, HeaderType, MessageTypePing);
  return {
    seqID: 0,
    logID: 0,
    service: serviceID,
    method: FrameTypeControl,
    headers,
    payloadEncoding: "",
    payloadType: "",
    payload: new Uint8Array(),
    logIDNew: "",
  };
}
