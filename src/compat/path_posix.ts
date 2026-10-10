// Project-owned replacement for the standard `path.posix` module, backed by
// `node:path`'s `posix` namespace. See `./path.ts` for the rationale.

import { posix } from "node:path";

export const {
  join,
  resolve,
  dirname,
  basename,
  normalize,
  relative,
  isAbsolute,
  extname,
  parse,
  format,
} = posix;

export const sep: string = posix.sep;
export const delimiter: string = posix.delimiter;
export const SEPARATOR: string = posix.sep;
