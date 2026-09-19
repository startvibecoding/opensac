// Ported from internal/session/session.go (shared session error sentinels).
//
// Only the sentinels needed by currently ported modules live here; the
// remaining session.go errors move in with the Manager port.

/** Reports that a session was modified by another process since it was read. */
export class SessionModifiedError extends Error {
  constructor(message = "session was modified by another process") {
    super(message);
    this.name = "SessionModifiedError";
  }
}

/**
 * Reports that a new session tried to reuse an existing session ID. A duplicate
 * must be rejected: updating the sessions row would merge the new header with
 * the old entries and create a forked conversation.
 */
export class SessionIDExistsError extends Error {
  constructor(message = "session ID already exists") {
    super(message);
    this.name = "SessionIDExistsError";
  }
}
