//
// A best-effort, host-only UDP wake-up bus so every opensac process on this host
// that shares a session directory learns when a Session lease is acquired,
// released, or lost, or when a database was rebuilt. SQLite leases and durable
// Run rows remain the sole authority: receivers always re-read the database
// before projecting any state to a client.
//
// Deviation from Go: the Go implementation writes the raw socket options
// (SO_REUSEADDR, SO_BROADCAST) with golang.org/x/sys/unix/cgo and binds with
// net.PacketConn. Deno's stable UDP primitive (`Deno.listenDatagram`) requires
// `--unstable-net`, so this port uses `node:dgram` (available without unstable
// flags), which exposes the same reuseAddr/setBroadcast options.

import dgram from "node:dgram";
import { runtimeOwnerID } from "./runtime_identity.ts";

/**
 * A best-effort local-process wake-up signal. SQLite leases and durable Run
 * rows remain the sole authority: receivers must always re-read the database
 * before projecting any state to a client.
 *
 * Threat model: the UDP bus is unauthenticated. Any process on the same host
 * can send spoofed notifications (only the loopback source address is
 * checked). This is acceptable because notifications are advisory only; every
 * receiver re-validates against the authoritative SQLite lease and Run rows
 * before acting, so a forged packet can at most trigger a redundant database
 * re-read, never an ownership or content change. The bus is deliberately
 * host-only: it is a directed broadcast on the loopback network.
 */
export interface RuntimeLeaseNotification {
  version?: number;
  messageId?: string;
  type: string;
  sessionId?: string;
  /** Names the database file for the `database_rebuilt` wake-up. */
  path?: string;
  origin?: string;
  originInstanceId?: string;
  ownerInstanceId?: string;
  epoch?: number;
  expiresAt?: number;
}

const runtimeLeaseBusDefaultPort = "49371";
export const runtimeLeaseBusVersion = 2;
const runtimeLeaseBusDedupeTTL = 10_000;
const runtimeLeaseBusDedupeLimit = 4096;

/** Advisory wake-up published after a database was backed up and rebuilt. */
export const runtimeLeaseBusDatabaseRebuilt = "database_rebuilt";

type Handler = (notification: RuntimeLeaseNotification) => void;

interface RuntimeLeaseBusState {
  started: boolean;
  listening: boolean;
  conn: dgram.Socket | null;
  handlers: Map<number, Handler>;
  nextId: number;
  seen: Map<string, number>;
  stopListener: (() => void) | null;
}

const runtimeLeaseBus: RuntimeLeaseBusState = {
  started: false,
  listening: false,
  conn: null,
  handlers: new Map(),
  nextId: 0,
  seen: new Map(),
  stopListener: null,
};

let runtimeLeaseBusMessageSequence = 0;

const runtimeLeaseBusLogs: {
  nextId: number;
  sinks: Map<number, (message: string) => void>;
} = { nextId: 0, sinks: new Map() };

/**
 * Receives UDP diagnostics without writing them to the process-wide logger.
 * Tools and diagnostics surfaces use this to expose the messages; TUI, CLI, and
 * protocol transports must not receive protocol diagnostics.
 */
export function subscribeRuntimeLeaseLogs(
  sink: (message: string) => void,
): () => void {
  if (sink === null || sink === undefined) return () => {};
  runtimeLeaseBusLogs.nextId++;
  const id = runtimeLeaseBusLogs.nextId;
  runtimeLeaseBusLogs.sinks.set(id, sink);
  return () => {
    runtimeLeaseBusLogs.sinks.delete(id);
  };
}

export function runtimeLeaseBusLogf(
  format: string,
  ...args: unknown[]
): void {
  const message = formatLog(format, args);
  for (const sink of [...runtimeLeaseBusLogs.sinks.values()]) {
    sink(message);
  }
}

/**
 * Receives best-effort notifications from other local processes. It is
 * deliberately optional: a bind failure simply leaves durable SQLite replay as
 * the synchronization path.
 */
export function subscribeRuntimeLeaseNotifications(
  handler: Handler | null | undefined,
): () => void {
  if (handler === null || handler === undefined) return () => {};
  runtimeLeaseBus.nextId++;
  const id = runtimeLeaseBus.nextId;
  runtimeLeaseBus.handlers.set(id, handler);
  if (!runtimeLeaseBus.started) {
    runtimeLeaseBus.started = true;
    runRuntimeLeaseBus();
  }
  return () => {
    runtimeLeaseBus.handlers.delete(id);
    // Stop the listener once every handler unsubscribed so the bus does not
    // outlive its last subscriber.
    if (runtimeLeaseBus.handlers.size === 0 && runtimeLeaseBus.conn !== null) {
      runtimeLeaseBus.stopListener?.();
    }
  };
}

/** Reports whether the UDP listener is currently bound. */
export function runtimeLeaseBusListening(): boolean {
  return runtimeLeaseBus.listening;
}

/** Resolves once the UDP listener is bound, or when the timeout elapses. */
export function waitForRuntimeLeaseBusListener(
  timeoutMs = 5_000,
): Promise<boolean> {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      if (runtimeLeaseBus.listening) {
        resolve(true);
        return;
      }
      if (Date.now() >= deadline) {
        resolve(false);
        return;
      }
      setTimeout(poll, 10);
    };
    poll();
  });
}

/** Resolves once the UDP listener has stopped, or when the timeout elapses. */
export function waitForRuntimeLeaseBusStopped(
  timeoutMs = 5_000,
): Promise<boolean> {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      if (!runtimeLeaseBus.listening) {
        resolve(true);
        return;
      }
      if (Date.now() >= deadline) {
        resolve(false);
        return;
      }
      setTimeout(poll, 10);
    };
    poll();
  });
}

export function runtimeLeaseBusAddresses(): {
  listenHost: string;
  listenPort: number;
  broadcast: string;
} {
  const envPort = (Deno.env.get("OPENSAC_RUNTIME_BUS_PORT") ?? "").trim();
  const portText = envPort === "" ? runtimeLeaseBusDefaultPort : envPort;
  const port = Number.parseInt(portText, 10);
  // A wildcard bind is required to receive the directed broadcast. Every
  // listener verifies the packet source is loopback before processing it, and
  // the send address is always the loopback directed broadcast: the bus is
  // host-only by design, so no environment variable widens it to a LAN
  // broadcast.
  return {
    listenHost: "0.0.0.0",
    listenPort: port,
    broadcast: "127.255.255.255",
  };
}

function runRuntimeLeaseBus(): void {
  const { listenHost, listenPort } = runtimeLeaseBusAddresses();
  const address = `${listenHost}:${listenPort}`;
  const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
  runtimeLeaseBus.conn = socket;
  let bound = false;

  const teardown = () => {
    if (runtimeLeaseBus.conn === socket) {
      runtimeLeaseBus.conn = null;
      runtimeLeaseBus.listening = false;
      runtimeLeaseBus.stopListener = null;
      bound = false;
      try {
        socket.close();
      } catch {
        // already closed
      }
      // A handler may have subscribed between the close trigger and this
      // cleanup; restart instead of leaving it without a listener.
      const restart = runtimeLeaseBus.handlers.size > 0;
      runtimeLeaseBus.started = restart;
      if (restart) runRuntimeLeaseBus();
    }
  };
  runtimeLeaseBus.stopListener = teardown;

  socket.on("error", (err) => {
    if (!bound) {
      runtimeLeaseBus.started = false;
      if (runtimeLeaseBus.conn === socket) {
        runtimeLeaseBus.conn = null;
        runtimeLeaseBus.stopListener = null;
      }
      runtimeLeaseBusLogf(
        "[udp] listener unavailable address=%s error=%s",
        address,
        String(err),
      );
      try {
        socket.close();
      } catch {
        // already closed
      }
      return;
    }
    runtimeLeaseBusLogf(
      "[udp] listener error address=%s error=%s",
      address,
      String(err),
    );
    teardown();
  });

  socket.on("message", (msg, rinfo) => {
    onRuntimeLeaseDatagram(msg, rinfo.address, rinfo.port);
  });

  socket.bind(listenPort, listenHost, () => {
    bound = true;
    runtimeLeaseBus.listening = true;
    // The last handler may have unsubscribed while the socket was still
    // binding. Close now so it does not read forever with no subscribers.
    if (runtimeLeaseBus.handlers.size === 0) {
      teardown();
      return;
    }
    runtimeLeaseBusLogf("[udp] listener started address=%s", address);
  });
}

function onRuntimeLeaseDatagram(
  msg: Uint8Array,
  sourceAddress: string,
  sourcePort: number,
): void {
  if (!isLoopbackAddress(sourceAddress)) return;
  let notification: RuntimeLeaseNotification;
  try {
    notification = JSON.parse(new TextDecoder().decode(msg));
  } catch {
    return;
  }
  if (!validRuntimeLeaseNotification(notification)) return;
  if (notification.originInstanceId === runtimeOwnerID()) {
    // This process has already published the corresponding canonical event
    // directly. Ignoring its loopback copy avoids duplicate projections
    // while other processes still receive the broadcast.
    return;
  }
  if (!rememberRuntimeLeaseMessage(notification.messageId ?? "", Date.now())) {
    return;
  }
  const handlers = [...runtimeLeaseBus.handlers.values()];
  runtimeLeaseBusLogf(
    "[udp] received type=%s session=%s origin=%s origin_instance=%s message=%s epoch=%d source=%s:%d",
    notification.type,
    notification.sessionId ?? "",
    notification.origin ?? "",
    notification.originInstanceId ?? "",
    notification.messageId ?? "",
    notification.epoch ?? 0,
    sourceAddress,
    sourcePort,
  );
  for (const handler of handlers) handler(notification);
}

export function rememberRuntimeLeaseMessage(
  messageId: string,
  now: number,
): boolean {
  if (runtimeLeaseBus.seen.has(messageId)) return false;
  for (const [id, expiresAt] of runtimeLeaseBus.seen) {
    if (expiresAt <= now) runtimeLeaseBus.seen.delete(id);
  }
  if (runtimeLeaseBus.seen.size >= runtimeLeaseBusDedupeLimit) {
    for (const id of runtimeLeaseBus.seen.keys()) {
      runtimeLeaseBus.seen.delete(id);
      break;
    }
  }
  runtimeLeaseBus.seen.set(messageId, now + runtimeLeaseBusDedupeTTL);
  return true;
}

export function validRuntimeLeaseNotification(
  notification: RuntimeLeaseNotification,
): boolean {
  const messageId = notification.messageId ?? "";
  const originInstanceId = notification.originInstanceId ?? "";
  const origin = notification.origin ?? "";
  if (
    notification.version !== runtimeLeaseBusVersion ||
    messageId.trim() === "" || messageId.length > 256 ||
    originInstanceId.trim() === "" || originInstanceId.length > 256 ||
    origin.length > 128
  ) {
    return false;
  }
  if (notification.type === runtimeLeaseBusDatabaseRebuilt) {
    const p = (notification.path ?? "").trim();
    return p !== "" && p.length <= 4096;
  }
  const sessionId = (notification.sessionId ?? "").trim();
  if (sessionId === "" || sessionId.length > 256) return false;
  switch (notification.type) {
    case "acquired":
    case "renewed":
    case "released":
    case "lost":
    case "state_changed":
      return true;
    default:
      return false;
  }
}

/** Publishes one advisory notification to every local process. */
export function publishRuntimeLeaseNotification(
  notification: RuntimeLeaseNotification,
): void {
  if (
    (notification.sessionId ?? "") === "" &&
    notification.type !== runtimeLeaseBusDatabaseRebuilt
  ) {
    return;
  }
  const { broadcast, listenPort } = runtimeLeaseBusAddresses();
  const payload: RuntimeLeaseNotification = {
    ...notification,
    version: runtimeLeaseBusVersion,
    originInstanceId: runtimeOwnerID(),
  };
  if ((payload.origin ?? "").trim() === "") payload.origin = "runtime";
  if ((payload.messageId ?? "") === "") {
    runtimeLeaseBusMessageSequence++;
    payload.messageId = `${payload.originInstanceId}-${
      Date.now() * 1_000_000
    }-${runtimeLeaseBusMessageSequence}`;
  }
  let encoded: Uint8Array;
  try {
    encoded = new TextEncoder().encode(JSON.stringify(payload));
  } catch {
    return;
  }
  if (encoded.length > 1024) return;

  const socket = dgram.createSocket("udp4");
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    try {
      socket.close();
    } catch {
      // already closed
    }
  };
  const logSendFailure = (err: unknown) => {
    runtimeLeaseBusLogf(
      "[udp] send failed type=%s session=%s origin=%s origin_instance=%s message=%s error=%s",
      payload.type,
      payload.sessionId ?? "",
      payload.origin ?? "",
      payload.originInstanceId ?? "",
      payload.messageId ?? "",
      String(err),
    );
  };
  socket.on("error", (err) => {
    logSendFailure(err);
    finish();
  });
  try {
    socket.bind(0, "0.0.0.0", () => {
      try {
        socket.setBroadcast(true);
      } catch {
        // best effort; the send below reports the real failure
      }
      socket.send(encoded, listenPort, broadcast, (err) => {
        if (err) logSendFailure(err);
        else {
          runtimeLeaseBusLogf(
            "[udp] sent type=%s session=%s origin=%s origin_instance=%s message=%s epoch=%d",
            payload.type,
            payload.sessionId ?? "",
            payload.origin ?? "",
            payload.originInstanceId ?? "",
            payload.messageId ?? "",
            payload.epoch ?? 0,
          );
        }
        finish();
      });
    });
  } catch (err) {
    logSendFailure(err);
    finish();
  }
}

/**
 * Wakes local observers after a durable Run state transition. It never
 * carries Run content and never changes ownership.
 */
export function notifyRuntimeStateChanged(
  sessionId: string,
  origin: string,
): void {
  publishRuntimeLeaseNotification({
    type: "state_changed",
    sessionId,
    origin,
  });
}

function isLoopbackAddress(address: string): boolean {
  if (address === "::1" || address === "localhost") return true;
  if (address.startsWith("127.")) return true;
  if (address === "::ffff:127.0.0.1") return true;
  if (address.startsWith("::ffff:127.")) return true;
  return false;
}

function formatLog(format: string, args: unknown[]): string {
  let index = 0;
  return format.replace(/%[sdv]/g, (match) => {
    if (index >= args.length) return match;
    const value = args[index++];
    return typeof value === "string" ? value : formatValue(value);
  });
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value === "object") {
    try {
      return JSON.stringify(value) ?? String(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}
