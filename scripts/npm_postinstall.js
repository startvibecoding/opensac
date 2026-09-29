#!/usr/bin/env node

// Prints a short banner after `npm install -g opensac-installer`.
//
// This is the first thing a new user sees, so it states what to run next and
// where configuration lives. It stays silent in CI and whenever the user opted
// out, so it never pollutes scripted or logged installs.

"use strict";

if (process.env.CI || process.env.OPENSAC_SKIP_POSTINSTALL) process.exit(0);

const os = require("os");
const path = require("path");

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[92m";

const logo = [
  "  ____                 ____  _____ ",
  " / ___|___  ___ _ __   / ___|| ____|",
  "| |   / _ \\/ _ \\ '_ \\ | |   |  _|  ",
  "| |__| (_) |  __/ | | || |___| |___ ",
  " \\____\\___/ \\___|_| |_| \\____||____|",
].join("\n");

/** Absolute path of the user-level settings file. */
function configPath() {
  if (process.platform === "win32") {
    const appData = process.env.APPDATA ||
      path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appData, "opensac", "settings.json");
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.trim() !== ""
    ? xdg
    : path.join(os.homedir(), ".config");
  return path.join(base, "opensac", "settings.json");
}

/** Installed package version, or '' when it cannot be read. */
function packageVersion() {
  try {
    return require("../package.json").version || "";
  } catch {
    return "";
  }
}

const version = packageVersion();
const versionLabel = version ? ` ${DIM}v${version}${RESET}` : "";

console.log();
console.log(`${GREEN}${BOLD}${logo}${RESET}${versionLabel}`);
console.log();
console.log(`  ${BOLD}An AI pair programmer, right in your terminal.${RESET}`);
console.log();
console.log(`  ${DIM}─────────────────────────────────────────${RESET}`);
console.log();
console.log(
  `    ${CYAN}${BOLD}opensac${RESET}                            ${DIM}Interactive mode${RESET}`,
);
console.log(
  `    ${CYAN}${BOLD}opensac -P "write fizzbuzz"${RESET}  ${DIM}One-shot mode${RESET}`,
);
console.log();
console.log(
  `  Add an API key from inside the TUI with ${CYAN}${BOLD}/auth${RESET}.`,
);
console.log();
console.log(`  ${DIM}Settings  ${configPath()}${RESET}`);
console.log();
