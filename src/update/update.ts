//
// Package update provides non-blocking version update detection based on the
// npm registry. It never blocks the user: network checks run in the background
// and failures only affect the update notification.

import * as path from "../compat/path.ts";
import { configDir } from "../config/settings.ts";
import { userAgent } from "../ua/ua.ts";
import * as semver from "./semver.ts";

/** The npm package used for update detection. */
export const PACKAGE_NAME = "opensac";

/** The minimum time between background network checks. */
export const checkIntervalMs = 24 * 60 * 60 * 1000;

/** Injectable latest-version fetcher (mirrors the Go package var in tests). */
export let fetchLatestVersion: (abort?: AbortSignal) => Promise<string> =
  fetchLatest;

/** Sets the injectable fetch function (mirrors assigning the Go package var). */
export function setFetchLatestVersion(
  fn: (abort?: AbortSignal) => Promise<string>,
): void {
  fetchLatestVersion = fn;
}

/** Injectable clock (mirrors the Go package `now` var in tests). */
export let now: () => Date = () => new Date();

/** Sets the injectable clock (mirrors assigning the Go package var). */
export function setNow(fn: () => Date): void {
  now = fn;
}

/** Returns the npm registry endpoint for the latest dist-tag. */
export function registryURL(): string {
  const u = Deno.env.get("VIBECODING_NPM_REGISTRY");
  if (u) {
    return u.replace(/\/+$/, "") + "/" + PACKAGE_NAME + "/latest";
  }
  return "https://registry.npmjs.org/" + PACKAGE_NAME + "/latest";
}

/** The on-disk cache for update checks. */
export interface CacheEntry {
  checked_at: string;
}

export function cachePath(): string {
  return path.join(configDir(), "update-check.json");
}

export function readCache(): CacheEntry {
  let c: CacheEntry = { checked_at: "" };
  let data: string;
  try {
    data = Deno.readTextFileSync(cachePath());
  } catch {
    return c;
  }
  try {
    const parsed = JSON.parse(data);
    if (parsed && typeof parsed === "object") {
      c = {
        checked_at: typeof parsed.checked_at === "string"
          ? parsed.checked_at
          : "",
      };
    }
  } catch {
    // ignore
  }
  return c;
}

export function writeCache(c: CacheEntry): void {
  let data: string;
  try {
    data = JSON.stringify(c, null, "  ");
  } catch {
    return;
  }
  try {
    Deno.mkdirSync(path.dirname(cachePath()), { recursive: true, mode: 0o755 });
    Deno.writeTextFileSync(cachePath(), data, { mode: 0o644 });
  } catch {
    // ignore
  }
}

/** Returns the update reminder text for current and latest. */
export function notice(current: string, latest: string): string {
  return `✨ Update available: ${normalize(current)} → ${
    normalize(latest)
  }\n   Run: npm install -g ${PACKAGE_NAME}@latest`;
}

function checkedAtDate(c: CacheEntry): Date {
  if (!c.checked_at) return new Date(0);
  const d = new Date(c.checked_at);
  return isNaN(d.getTime()) ? new Date(0) : d;
}

/**
 * Refreshes the cache in the background if it is stale. It returns immediately
 * and never blocks the caller. When the fetched npm latest version is newer
 * than current, notify is called from the background task. Disable with the
 * VIBECODING_NO_UPDATE_CHECK environment variable.
 */
export function checkInBackground(
  current: string,
  notify: ((msg: string) => void) | null,
): void {
  if (!isCheckable(current) || checksDisabled()) {
    return;
  }
  const c = readCache();
  const checkedAt = checkedAtDate(c);
  if (c.checked_at && now().getTime() - checkedAt.getTime() < checkIntervalMs) {
    return;
  }
  // Fire-and-forget background refresh; never block or reject into the caller.
  void refreshCache(current, notify).catch(() => {});
}

export async function refreshCache(
  current: string,
  notify: ((msg: string) => void) | null,
): Promise<void> {
  let latest = "";
  let failed = false;
  try {
    latest = await fetchLatestVersion();
  } catch {
    failed = true;
  }
  writeCache({ checked_at: now().toISOString() });
  if (failed) {
    return;
  }
  if (compareVersions(latest, current) <= 0) {
    return;
  }
  if (notify) {
    notify(notice(current, latest));
  }
}

/** Queries the npm registry for the latest published version. */
export async function fetchLatest(abort?: AbortSignal): Promise<string> {
  const signal = abort
    ? AbortSignal.any([abort, AbortSignal.timeout(5000)])
    : AbortSignal.timeout(5000);
  const resp = await fetch(registryURL(), {
    method: "GET",
    headers: {
      "User-Agent": userAgent(),
      "Accept": "application/json",
    },
    signal,
  });
  if (resp.status !== 200) {
    throw new Error(`npm registry: status ${resp.status}`);
  }
  const payload = await resp.json();
  const version = payload && typeof payload === "object"
    ? String(payload.version ?? "")
    : "";
  if (version === "") {
    throw new Error("npm registry: empty version");
  }
  return version;
}

function checksDisabled(): boolean {
  return (Deno.env.get("VIBECODING_NO_UPDATE_CHECK") ?? "") !== "";
}

/** Reports whether current is a real release version worth checking. */
export function isCheckable(current: string): boolean {
  return semverVersion(current) !== "";
}

/** Strips a leading "v" and surrounding whitespace. */
export function normalize(v: string): string {
  const t = v.trim();
  return t.startsWith("v") ? t.slice(1) : t;
}

/**
 * Compares two semantic version strings. Returns -1 if a < b, 0 if equal, and
 * 1 if a > b.
 */
export function compareVersions(a: string, b: string): number {
  return semver.compare(semverVersion(a), semverVersion(b));
}

export function semverVersion(v: string): string {
  v = normalize(v);
  if (v === "" || v.toLowerCase() === "dev") {
    return "";
  }
  if (!v.startsWith("v")) {
    v = "v" + v;
  }
  if (!semver.isValid(v)) {
    return "";
  }
  return semver.canonical(v);
}
