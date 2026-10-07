// Shared session error sentinels.
//
// The typed sentinels thrown by the session layer so callers can classify a
// failure without matching on message text.

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
