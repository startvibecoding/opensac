#!/usr/bin/env node

// npm entry point for opensac.
//
// This wrapper is the `opensac` command npm links. It resolves the native
// binary from the platform package npm installed as an optional dependency for
// this host, then execs it. Keeping the platform selection in one small script
// means the entry package stays tiny and a user downloads one binary instead of
// every platform's.
//
// The supported platforms come from `platforms.js` next to this file, which
// `make npm-packages` generates from scripts/platforms.ts. Nothing here lists a
// platform, so adding one cannot leave this wrapper behind.

"use strict";

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

/** npm platform suffix -> platform package name. */
const PLATFORM_PACKAGES = require("./platforms.js");

/** Maps this host to its npm platform suffix, or null when unsupported. */
function detectPlatform() {
  const key = `${process.platform}-${process.arch}`;
  return Object.prototype.hasOwnProperty.call(PLATFORM_PACKAGES, key)
    ? key
    : null;
}

/**
 * Candidate locations for an installed platform package. npm normally nests it
 * under this package, but some global installs and hoisting layouts place it as
 * a sibling.
 */
function searchDirs(packageName) {
  const dirs = [];
  const add = (dir) => {
    if (dir && !dirs.includes(dir)) dirs.push(dir);
  };

  try {
    add(path.dirname(require.resolve(`${packageName}/package.json`)));
  } catch {
    // Fall through to the explicit layouts below.
  }
  add(path.join(__dirname, "..", "node_modules", packageName));
  add(path.join(__dirname, "..", "..", packageName));
  add(path.join(__dirname, "..", "..", "..", packageName));
  return dirs;
}

/** Absolute path to the native binary, or null when it is not installed. */
function findBinary(packageName) {
  const binaryName = process.platform === "win32" ? "opensac.exe" : "opensac";
  for (const dir of searchDirs(packageName)) {
    const candidate = path.join(dir, "bin", binaryName);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function reportUnsupported(platform) {
  console.error(`opensac does not publish a binary for ${platform}.`);
  console.error(
    `Supported platforms: ${Object.keys(PLATFORM_PACKAGES).join(", ")}`,
  );
  console.error("");
  console.error("If you built opensac from source, run it directly:");
  console.error("  deno task build && ./bin/opensac");
  process.exit(1);
}

function reportMissingBinary(platform, packageName) {
  console.error(`Found no opensac binary for ${platform}.`);
  console.error(`Expected it in the ${packageName} package.`);
  console.error("");
  console.error("Reinstall to fetch the platform binary:");
  console.error(`  npm install -g ${entryPackageName()}`);
  process.exit(1);
}

/**
 * Name of the entry package this wrapper was installed from, so the reinstall
 * hint names the package the user actually has. The same wrapper is published
 * unscoped to npmjs and scoped to GitHub Packages, and only this manifest knows
 * which one it is.
 */
function entryPackageName() {
  try {
    const manifest = require(path.join(__dirname, "..", "package.json"));
    if (manifest && typeof manifest.name === "string" && manifest.name !== "") {
      return manifest.name;
    }
  } catch {
    // Fall through to the unscoped default.
  }
  return "opensac-installer";
}

function main() {
  const platform = detectPlatform();
  if (platform === null) {
    reportUnsupported(`${process.platform}-${process.arch}`);
  }

  const packageName = PLATFORM_PACKAGES[platform];
  const binaryPath = findBinary(packageName);
  if (binaryPath === null) reportMissingBinary(platform, packageName);

  try {
    // stdio: inherit keeps the Ink TUI interactive, which it would not be if
    // this wrapper captured the child's output.
    execFileSync(binaryPath, process.argv.slice(2), { stdio: "inherit" });
  } catch (error) {
    // Forward the child's exit status so `opensac` scripts and CI see the real
    // result instead of a generic failure.
    if (error && typeof error.status === "number") process.exit(error.status);
    if (
      error && typeof error.code === "string" && error.code.startsWith("ENOENT")
    ) {
      console.error(`opensac binary disappeared: ${binaryPath}`);
      process.exit(1);
    }
    throw error;
  }
}

main();
