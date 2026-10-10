// User-pattern regular-expression compilation, hardened for the Go → TS
// migration hazards of `regexp`:
//
// Go's RE2 never backtracks, so any pattern that compiled was safe to run.
// JS `RegExp` is a backtracking engine: a short pathological pattern such as
// `(a+)+$` can hang the single-threaded Node event loop against a long line.
// `compileUserRegExp` bounds the input and rejects the classic
// catastrophic-backtracking shapes before compiling. It is defense in depth,
// not a proof: the definitive isolation is running untrusted matching in a
// bounded worker, which remains a documented follow-up.

/** Thrown when a user-supplied pattern is rejected or fails to compile. */
export class UserRegExpError extends Error {
  override name = "UserRegExpError";
}

/** Maximum accepted user-pattern length. */
export const maxUserRegExpLength = 512;

/** Matches an unbounded `{n,}`/`{n,m,}`-style quantifier body. */
const unboundedBraceQuantifier = /^\{\d*(?:,\d*)?,?\}$/;

/** Reports whether a quantifier character is unbounded (`*`, `+`, `{n,}`). */
function isUnboundedQuantifier(source: string, i: number): boolean {
  const ch = source[i];
  if (ch === "*" || ch === "+") return true;
  if (ch !== "{") return false;
  const end = source.indexOf("}", i);
  if (end === -1) return false;
  const body = source.slice(i, end + 1);
  // `{2}` and `{1,3}` are bounded; `{1,}` and `{2,}` are not.
  return unboundedBraceQuantifier.test(body) && body.includes(",");
}

/**
 * Reports whether the pattern contains a quantified group that itself contains
 * an unbounded quantifier (the `(a+)+` family). Escapes and character classes
 * are skipped so literals such as `\(a\+\)\+` and `[(+*]` stay legal.
 */
function hasNestedUnboundedQuantifier(pattern: string): boolean {
  const n = pattern.length;
  const groupStarts: number[] = [];
  let inClass = false;
  const contentHasUnbounded = new Array<boolean>(n).fill(false);

  for (let i = 0; i < n; i++) {
    const ch = pattern[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (inClass) {
      if (ch === "]") inClass = false;
      continue;
    }
    if (ch === "[") {
      inClass = true;
      continue;
    }
    if (ch === "(") {
      groupStarts.push(i);
      continue;
    }
    if (ch === ")") {
      const start = groupStarts.pop();
      if (start === undefined) continue;
      const inner = contentHasUnbounded[start];
      // A quantified group holding an unbounded quantifier is the evil shape.
      if (inner && isUnboundedQuantifier(pattern, i + 1)) return true;
      // Propagate to enclosing groups.
      if (groupStarts.length > 0 && inner) {
        contentHasUnbounded[groupStarts[groupStarts.length - 1]] = true;
      }
      continue;
    }
    if (isUnboundedQuantifier(pattern, i)) {
      if (groupStarts.length > 0) {
        contentHasUnbounded[groupStarts[groupStarts.length - 1]] = true;
      }
    }
  }
  return false;
}

/**
 * Compiles a pattern the code generated itself (for example from a glob). The
 * generator guarantees a safe shape, so only syntax is validated and wrapped in
 * `UserRegExpError`; length and shape limits apply to raw user patterns only.
 */
export function compileGeneratedRegExp(source: string, flags = ""): RegExp {
  try {
    return new RegExp(source, flags);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new UserRegExpError(`invalid regex: ${detail}`);
  }
}

/**
 * Compiles a user-supplied pattern, throwing `UserRegExpError` when the pattern
 * is too long, matches a catastrophic-backtracking shape, or is not valid in
 * the JS regex syntax (which is not Go's RE2 subset).
 */
export function compileUserRegExp(pattern: string, flags = ""): RegExp {
  if (pattern.length > maxUserRegExpLength) {
    throw new UserRegExpError(
      `regex pattern exceeds ${maxUserRegExpLength} characters`,
    );
  }
  if (hasNestedUnboundedQuantifier(pattern)) {
    throw new UserRegExpError(
      "regex pattern uses nested unbounded quantifiers that can hang matching",
    );
  }
  try {
    return new RegExp(pattern, flags);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new UserRegExpError(`invalid regex: ${detail}`);
  }
}
