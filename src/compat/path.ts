// Project-owned replacement for the third-party standard `path` module.
//
// This repository targets the Node runtime and uses only Node built-ins, so
// `node:path` and `node:url` provide the same surface.
// `node:path` is a CommonJS `export =` module, so its members are re-exported
// explicitly here (a bare `export *` would not surface them). Add a member here
// (backed by a Node builtin) rather than adding a dependency.
//
// `fromFileUrl`/`toFileUrl` mirror the standard names over the Node functions
// `fileURLToPath`/`pathToFileURL`; `SEPARATOR` mirrors the platform separator
// constant.

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
