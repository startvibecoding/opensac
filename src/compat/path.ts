// Project-owned replacement for the JSR `@std/path` module.
//
// This repository targets the Node runtime and does not depend on Deno's
// package registry, so `node:path` and `node:url` provide the same surface.
// `node:path` is a CommonJS `export =` module, so its members are re-exported
// explicitly here (a bare `export *` would not surface them). Add a member here
// (backed by a Node builtin) rather than reintroducing a `jsr:` import.
//
// `fromFileUrl`/`toFileUrl` mirror `@std/path`'s names over the Node functions
// `fileURLToPath`/`pathToFileURL`; `SEPARATOR` mirrors `@std/path`'s platform
// separator constant.

import * as nodePath from "node:path";
import * as nodeUrl from "node:url";

export const join = nodePath.join;
export const resolve = nodePath.resolve;
export const normalize = nodePath.normalize;
export const isAbsolute = nodePath.isAbsolute;
export const relative = nodePath.relative;
export const dirname = nodePath.dirname;
export const basename = nodePath.basename;
export const extname = nodePath.extname;
export const parse = nodePath.parse;
export const format = nodePath.format;
export const toNamespacedPath = nodePath.toNamespacedPath;
export const posix = nodePath.posix;
export const win32 = nodePath.win32;
export const sep = nodePath.sep;
export const delimiter = nodePath.delimiter;

export const fromFileUrl = nodeUrl.fileURLToPath;
export const fileURLToPath = nodeUrl.fileURLToPath;
export const toFileUrl = nodeUrl.pathToFileURL;
export const pathToFileURL = nodeUrl.pathToFileURL;
export const SEPARATOR: string = nodePath.sep;
