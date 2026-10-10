// (v0.37.0).
//
// Package semver implements comparison of semantic version strings.
// In this package, semantic version strings must begin with a leading "v",
// as in "v1.0.0".
//
// This is a faithful 1:1 port of the subset used by internal/update:
// IsValid, Canonical, Compare. Only the ASCII byte-oriented parse rules of
// x/mod/semver are reproduced (the update package never feeds it non-ASCII).

interface Parsed {
  major: string;
  minor: string;
  patch: string;
  short: string;
  prerelease: string;
  build: string;
}

function isIdentChar(code: number): boolean {
  return (
    (code >= 0x41 && code <= 0x5a) || // A-Z
    (code >= 0x61 && code <= 0x7a) || // a-z
    (code >= 0x30 && code <= 0x39) || // 0-9
    code === 0x2d // -
  );
}

function parseIntPrefix(v: string): { num: string; rest: string } | undefined {
  if (v === "") return undefined;
  const c0 = v.charCodeAt(0);
  if (c0 < 0x30 || c0 > 0x39) return undefined;
  let i = 1;
  while (i < v.length) {
    const c = v.charCodeAt(i);
    if (c < 0x30 || c > 0x39) break;
    i++;
  }
  if (v.charCodeAt(0) === 0x30 && i !== 1) {
    return undefined;
  }
  return { num: v.slice(0, i), rest: v.slice(i) };
}

function parsePrerelease(v: string): { pre: string; rest: string } | undefined {
  if (v === "" || v.charCodeAt(0) !== 0x2d /* - */) {
    return undefined;
  }
  let i = 1;
  let start = 1;
  while (i < v.length && v.charCodeAt(i) !== 0x2b /* + */) {
    const c = v.charCodeAt(i);
    if (!isIdentChar(c) && c !== 0x2e /* . */) {
      return undefined;
    }
    if (c === 0x2e) {
      if (start === i || isBadNum(v.slice(start, i))) {
        return undefined;
      }
      start = i + 1;
    }
    i++;
  }
  if (start === i || isBadNum(v.slice(start, i))) {
    return undefined;
  }
  return { pre: v.slice(0, i), rest: v.slice(i) };
}

function parseBuild(v: string): { build: string; rest: string } | undefined {
  if (v === "" || v.charCodeAt(0) !== 0x2b /* + */) {
    return undefined;
  }
  let i = 1;
  let start = 1;
  while (i < v.length) {
    const c = v.charCodeAt(i);
    if (!isIdentChar(c) && c !== 0x2e /* . */) {
      return undefined;
    }
    if (c === 0x2e) {
      if (start === i) return undefined;
      start = i + 1;
    }
    i++;
  }
  if (start === i) return undefined;
  return { build: v.slice(0, i), rest: v.slice(i) };
}

function isBadNum(v: string): boolean {
  let i = 0;
  while (i < v.length) {
    const c = v.charCodeAt(i);
    if (c < 0x30 || c > 0x39) break;
    i++;
  }
  return i === v.length && i > 1 && v.charCodeAt(0) === 0x30;
}

function isNum(v: string): boolean {
  let i = 0;
  while (i < v.length) {
    const c = v.charCodeAt(i);
    if (c < 0x30 || c > 0x39) break;
    i++;
  }
  return i === v.length;
}

function parse(v: string): Parsed | undefined {
  if (v === "" || v.charCodeAt(0) !== 0x76 /* v */) {
    return undefined;
  }
  let rest = v.slice(1);
  const major = parseIntPrefix(rest);
  if (major === undefined) return undefined;
  rest = major.rest;

  let minor = "0";
  let patch = "0";
  let short = ".0.0";

  if (rest !== "") {
    if (rest.charCodeAt(0) !== 0x2e /* . */) {
      return undefined;
    }
    const minorRes = parseIntPrefix(rest.slice(1));
    if (minorRes === undefined) return undefined;
    minor = minorRes.num;
    rest = minorRes.rest;

    if (rest !== "") {
      if (rest.charCodeAt(0) !== 0x2e) return undefined;
      const patchRes = parseIntPrefix(rest.slice(1));
      if (patchRes === undefined) return undefined;
      patch = patchRes.num;
      rest = patchRes.rest;
      short = "";
    } else {
      short = ".0";
    }
  }

  let prerelease = "";
  let build = "";
  if (rest.length > 0 && rest.charCodeAt(0) === 0x2d /* - */) {
    const pre = parsePrerelease(rest);
    if (pre === undefined) return undefined;
    prerelease = pre.pre;
    rest = pre.rest;
  }
  if (rest.length > 0 && rest.charCodeAt(0) === 0x2b /* + */) {
    const b = parseBuild(rest);
    if (b === undefined) return undefined;
    build = b.build;
    rest = b.rest;
  }
  if (rest !== "") return undefined;

  return { major: major.num, minor, patch, short, prerelease, build };
}

/** Reports whether v is a valid semantic version string. */
export function isValid(v: string): boolean {
  return parse(v) !== undefined;
}

/**
 * Returns the canonical formatting of the semantic version v. It fills in any
 * missing .MINOR or .PATCH and discards build metadata. The canonical invalid
 * semantic version is the empty string.
 */
export function canonical(v: string): string {
  const parsed = parse(v);
  if (parsed === undefined) return "";
  if (parsed.build !== "") {
    return v.slice(0, v.length - parsed.build.length);
  }
  if (parsed.short !== "") {
    return v + parsed.short;
  }
  return v;
}

function compareInt(x: string, y: string): number {
  if (x === y) return 0;
  if (x.length < y.length) return -1;
  if (x.length > y.length) return 1;
  return x < y ? -1 : 1;
}

function nextIdent(x: string): { ident: string; rest: string } {
  let i = 0;
  while (i < x.length && x.charCodeAt(i) !== 0x2e /* . */) i++;
  return { ident: x.slice(0, i), rest: x.slice(i) };
}

function comparePrerelease(x0: string, y0: string): number {
  if (x0 === y0) return 0;
  if (x0 === "") return 1;
  if (y0 === "") return -1;
  let x = x0;
  let y = y0;
  while (x !== "" && y !== "") {
    x = x.slice(1); // skip - or .
    y = y.slice(1); // skip - or .
    const dxr = nextIdent(x);
    const dyr = nextIdent(y);
    const dx = dxr.ident;
    const dy = dyr.ident;
    x = dxr.rest;
    y = dyr.rest;
    if (dx !== dy) {
      const ix = isNum(dx);
      const iy = isNum(dy);
      if (ix !== iy) {
        return ix ? -1 : 1;
      }
      if (ix) {
        if (dx.length < dy.length) return -1;
        if (dx.length > dy.length) return 1;
      }
      return dx < dy ? -1 : 1;
    }
  }
  return x === "" ? -1 : 1;
}

/**
 * Compares two versions according to semantic version precedence. Returns 0 if
 * v == w, -1 if v < w, or +1 if v > w. An invalid semantic version string is
 * considered less than a valid one; all invalid strings compare equal.
 */
export function compare(v: string, w: string): number {
  const pv = parse(v);
  const pw = parse(w);
  if (pv === undefined && pw === undefined) return 0;
  if (pv === undefined) return -1;
  if (pw === undefined) return 1;
  const a = pv;
  const b = pw;
  let c = compareInt(a.major, b.major);
  if (c !== 0) return c;
  c = compareInt(a.minor, b.minor);
  if (c !== 0) return c;
  c = compareInt(a.patch, b.patch);
  if (c !== 0) return c;
  return comparePrerelease(a.prerelease, b.prerelease);
}
