// Project-owned replacement for the JSR `@std/assert` module, backed by
// `node:assert/strict`. See `./path.ts` for the rationale.
//
// Only the helpers this repository imports are provided. Semantics follow
// `@std/assert`:
//   * an optional assertion `message` is appended to failure text;
//   * `assertEquals`/`assertNotEquals` compare prototypes-agnostically (a
//     null-prototype SQLite row equals a plain object), which `deepStrictEqual`
//     does not;
//   * `assertThrows`/`assertRejects` take `(fn, ErrorClass?, msgIncludes?, msg?)`
//     and return the caught error, inferring its type from `ErrorClass`.

import nodeAssert from "node:assert/strict";

/** An error constructor or a `RegExp` matched against the error message. */
type ErrorClass = (new (...args: never[]) => Error) | RegExp;

/** Prototype-agnostic, strict deep equality (mirrors `@std/assert`). */
function deepEqual(
  a: unknown,
  b: unknown,
  seen = new Map<unknown, unknown>(),
): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null || typeof a !== "object") return false;

  const previous = seen.get(a);
  if (previous !== undefined) return previous === b;
  seen.set(a, b);

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    return a.every((value, index) => deepEqual(value, b[index], seen));
  }
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date &&
      Object.is(a.getTime(), b.getTime());
  }
  if (a instanceof RegExp || b instanceof RegExp) {
    return a instanceof RegExp && b instanceof RegExp &&
      a.source === b.source && a.flags === b.flags;
  }
  if (a instanceof Error || b instanceof Error) {
    return a instanceof Error && b instanceof Error &&
      a.name === b.name && a.message === b.message;
  }
  if (a instanceof Map || b instanceof Map) {
    if (!(a instanceof Map) || !(b instanceof Map) || a.size !== b.size) {
      return false;
    }
    for (const [key, value] of a) {
      if (!b.has(key) || !deepEqual(value, b.get(key), seen)) return false;
    }
    return true;
  }
  if (a instanceof Set || b instanceof Set) {
    if (!(a instanceof Set) || !(b instanceof Set) || a.size !== b.size) {
      return false;
    }
    for (const value of a) if (!b.has(value)) return false;
    return true;
  }
  if (ArrayBuffer.isView(a) || ArrayBuffer.isView(b)) {
    if (!ArrayBuffer.isView(a) || !ArrayBuffer.isView(b)) return false;
    if (a.constructor !== b.constructor) return false;
    const left = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    const right = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    if (left.length !== right.length) return false;
    for (let i = 0; i < left.length; i++) {
      if (left[i] !== right[i]) return false;
    }
    return true;
  }

  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const leftKeys = Object.keys(left);
  if (leftKeys.length !== Object.keys(right).length) return false;
  for (const key of leftKeys) {
    if (!Object.prototype.hasOwnProperty.call(right, key)) return false;
    if (!deepEqual(left[key], right[key], seen)) return false;
  }
  return true;
}

/** Asserts that `expr` is truthy. */
export function assert(expr: unknown, message?: string): asserts expr {
  if (message === undefined) nodeAssert.ok(expr);
  else nodeAssert.ok(expr, message);
}

/** Asserts deep, prototype-agnostic equality. */
export function assertEquals<T>(
  actual: T,
  expected: T,
  message?: string,
): void {
  if (deepEqual(actual, expected)) return;
  if (message === undefined) nodeAssert.deepStrictEqual(actual, expected);
  else nodeAssert.deepStrictEqual(actual, expected, message);
}

/** Asserts that two values are not deeply equal. */
export function assertNotEquals<T>(
  actual: T,
  expected: T,
  message?: string,
): void {
  if (!deepEqual(actual, expected)) return;
  nodeAssert.fail(message ?? "expected values to differ");
}

/** Asserts strict (`===`) equality. */
export function assertStrictEquals<T>(
  actual: T,
  expected: T,
  message?: string,
): void {
  if (message === undefined) nodeAssert.strictEqual(actual, expected);
  else nodeAssert.strictEqual(actual, expected, message);
}

/** Asserts that two values are not strictly equal. */
export function assertNotStrictEquals<T>(
  actual: T,
  expected: T,
  message?: string,
): void {
  if (message === undefined) nodeAssert.notStrictEqual(actual, expected);
  else nodeAssert.notStrictEqual(actual, expected, message);
}

/** Asserts that a value is exactly `false`. */
export function assertFalse(value: unknown, message?: string): void {
  if (message === undefined) nodeAssert.strictEqual(value, false);
  else nodeAssert.strictEqual(value, false, message);
}

/** Asserts that a value is neither `null` nor `undefined`. */
export function assertExists<T>(
  value: T,
  message?: string,
): asserts value is NonNullable<T> {
  const ok = value !== null && value !== undefined;
  if (message === undefined) nodeAssert.ok(ok, "expected value to exist");
  else nodeAssert.ok(ok, message);
}

/** Asserts that `actual` is an instance of `expected`. */
export function assertInstanceOf<T extends Error>(
  actual: unknown,
  expected: new (...args: never[]) => T,
  message?: string,
): asserts actual is T {
  const ok = actual instanceof expected;
  const fallback = `expected instance of ${expected.name}`;
  if (message === undefined) nodeAssert.ok(ok, fallback);
  else nodeAssert.ok(ok, message);
}

/** Asserts that a string contains `expected`. */
export function assertStringIncludes(
  actual: string,
  expected: string,
  message?: string,
): void {
  const ok = typeof actual === "string" && actual.includes(expected);
  const fallback = `expected ${JSON.stringify(actual)} to include ${
    JSON.stringify(expected)
  }`;
  if (message === undefined) nodeAssert.ok(ok, fallback);
  else nodeAssert.ok(ok, message);
}

/** Asserts that a string matches a regular expression. */
export function assertMatch(
  actual: string,
  expected: RegExp,
  message?: string,
): void {
  if (message === undefined) nodeAssert.match(actual, expected);
  else nodeAssert.match(actual, expected, message);
}

/** Validates a caught error against an error constructor/`RegExp` and message. */
function validateThrown(
  thrown: unknown,
  errorClass: ErrorClass | undefined,
  messageIncludes: string | undefined,
): void {
  const error = thrown as { message?: unknown };
  const text = typeof error?.message === "string"
    ? error.message
    : String(thrown);
  if (errorClass instanceof RegExp) {
    if (!errorClass.test(text)) {
      nodeAssert.fail(
        `expected thrown error message ${
          JSON.stringify(text)
        } to match ${errorClass.toString()}`,
      );
    }
  } else if (typeof errorClass === "function") {
    if (!(thrown instanceof errorClass)) {
      nodeAssert.fail(
        `expected thrown error to be an instance of ${errorClass.name}`,
      );
    }
  }
  if (messageIncludes !== undefined && !text.includes(messageIncludes)) {
    nodeAssert.fail(
      `expected thrown error message ${JSON.stringify(text)} to include ${
        JSON.stringify(messageIncludes)
      }`,
    );
  }
}

/** Asserts that `fn` throws, returning the caught error. */
export function assertThrows<T extends Error>(
  fn: () => unknown,
  errorClass: new (...args: never[]) => T,
  messageIncludes?: string,
  message?: string,
): T;
export function assertThrows(
  fn: () => unknown,
  errorClass?: ErrorClass,
  messageIncludes?: string,
  message?: string,
): Error;
export function assertThrows(
  fn: () => unknown,
  errorClass?: ErrorClass,
  messageIncludes?: string,
  message?: string,
): Error {
  let threw = false;
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    threw = true;
    thrown = error;
  }
  if (!threw) nodeAssert.fail(message ?? "Missing expected exception.");
  validateThrown(thrown, errorClass, messageIncludes);
  return thrown as Error;
}

/** Asserts that `fn`/`promise` rejects, returning the rejection reason. */
export function assertRejects<T extends Error>(
  fn: (() => Promise<unknown>) | Promise<unknown>,
  errorClass: new (...args: never[]) => T,
  messageIncludes?: string,
  message?: string,
): Promise<T>;
export function assertRejects(
  fn: (() => Promise<unknown>) | Promise<unknown>,
  errorClass?: ErrorClass,
  messageIncludes?: string,
  message?: string,
): Promise<Error>;
export async function assertRejects(
  fn: (() => Promise<unknown>) | Promise<unknown>,
  errorClass?: ErrorClass,
  messageIncludes?: string,
  message?: string,
): Promise<Error> {
  let rejected = false;
  let reason: unknown;
  try {
    await (typeof fn === "function" ? fn() : fn);
  } catch (error) {
    rejected = true;
    reason = error;
  }
  if (!rejected) nodeAssert.fail(message ?? "Missing expected rejection.");
  validateThrown(reason, errorClass, messageIncludes);
  return reason as Error;
}
