// (process identity).
//
// The runtime owner identity names one OS process for lease ownership.
// It is computed once per process. Keeping it in its own module avoids a
// runtime_lock import cycle.

let processID: string | null = null;

/** Returns this process's stable runtime owner identity. */
export function runtimeOwnerID(): string {
  if (processID !== null) return processID;
  try {
    const nonce = new Uint8Array(16);
    crypto.getRandomValues(nonce);
    processID = `pid-${Deno.pid}-${toHex(nonce)}`;
  } catch {
    processID = `pid-${Deno.pid}-${Date.now()}`;
  }
  return processID;
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}
