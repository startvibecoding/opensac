import { runtime } from "../platform/runtime.ts";
import { assertEquals, assertNotEquals } from "../compat/assert.ts";
import {
  cachePath,
  checkInBackground,
  compareVersions,
  isCheckable,
  normalize,
  readCache,
  refreshCache,
  setFetchLatestVersion,
  setNow,
} from "./update.ts";
import { test } from "#testing";

test("CompareVersions", () => {
  const cases: Array<[string, string, number]> = [
    ["1.1.50", "1.1.50", 0],
    ["v1.1.50", "1.1.50", 0],
    ["1.1.51", "1.1.50", 1],
    ["1.1.50", "1.1.51", -1],
    ["1.2.0", "1.1.99", 1],
    ["2.0.0", "1.9.9", 1],
    ["1.1.50-pre", "1.1.50", -1],
    ["1.1.50", "1.1.50-pre", 1],
    ["1.1.51-pre", "1.1.50", 1],
  ];
  for (const [a, b, want] of cases) {
    assertEquals(compareVersions(a, b), want, `compareVersions(${a},${b})`);
  }
});

test("IsCheckable", () => {
  const cases: Record<string, boolean> = {
    dev: false,
    "": false,
    "v1.1.50": true,
    "1.1.50": true,
    unknown: false,
  };
  for (const [v, want] of Object.entries(cases)) {
    assertEquals(isCheckable(v), want, `isCheckable(${v})`);
  }
});

test("Normalize", () => {
  assertEquals(normalize(" v1.2.3 "), "1.2.3");
});

test("CheckInBackgroundRespectsDisableFlag", () => {
  const dir = runtime.makeTempDirSync();
  const oldDir = runtime.env.get("OPENSAC_DIR");
  const oldDisable = runtime.env.get("VIBECODING_NO_UPDATE_CHECK");
  runtime.env.set("OPENSAC_DIR", dir);
  runtime.env.set("VIBECODING_NO_UPDATE_CHECK", "1");
  try {
    let called = false;
    setFetchLatestVersion(() => {
      called = true;
      return Promise.resolve("v1.2.4");
    });
    checkInBackground("v1.2.3", null);
    assertEquals(called, false, "expected disabled check not to fetch");
  } finally {
    restoreEnv("OPENSAC_DIR", oldDir);
    restoreEnv("VIBECODING_NO_UPDATE_CHECK", oldDisable);
  }
});

test("CheckInBackgroundRecordsFailureCooldown", async () => {
  const dir = runtime.makeTempDirSync();
  const oldDir = runtime.env.get("OPENSAC_DIR");
  const oldDisable = runtime.env.get("VIBECODING_NO_UPDATE_CHECK");
  runtime.env.set("OPENSAC_DIR", dir);
  runtime.env.set("VIBECODING_NO_UPDATE_CHECK", "");
  try {
    const nowValue = new Date(1000 * 1000);
    setNow(() => nowValue);
    setFetchLatestVersion(() => Promise.reject(new Error("boom")));

    await refreshCache("v1.2.3", null);

    const c = readCache();
    assertNotEquals(
      c.checked_at,
      "",
      "expected failed check to record cooldown timestamp",
    );
    assertEquals(new Date(c.checked_at).getTime(), nowValue.getTime());
  } finally {
    restoreEnv("OPENSAC_DIR", oldDir);
    restoreEnv("VIBECODING_NO_UPDATE_CHECK", oldDisable);
  }
});

test("RefreshCacheNotifiesForNewerSemver", async () => {
  const dir = runtime.makeTempDirSync();
  const oldDir = runtime.env.get("OPENSAC_DIR");
  const oldDisable = runtime.env.get("VIBECODING_NO_UPDATE_CHECK");
  runtime.env.set("OPENSAC_DIR", dir);
  runtime.env.set("VIBECODING_NO_UPDATE_CHECK", "");
  try {
    const nowValue = new Date(2000 * 1000);
    setNow(() => nowValue);
    setFetchLatestVersion(() => Promise.resolve("v1.10.0"));

    let noticed = "";
    await refreshCache("v1.2.3", (msg) => {
      noticed = msg;
    });
    assertNotEquals(
      noticed,
      "",
      "expected semver comparison to notify for newer version",
    );
    const c = readCache();
    assertEquals(new Date(c.checked_at).getTime(), nowValue.getTime());
  } finally {
    restoreEnv("OPENSAC_DIR", oldDir);
    restoreEnv("VIBECODING_NO_UPDATE_CHECK", oldDisable);
  }
});

test("RefreshCacheSkipsNotifyForCurrentOrOlderVersion", async () => {
  const dir = runtime.makeTempDirSync();
  const oldDir = runtime.env.get("OPENSAC_DIR");
  runtime.env.set("OPENSAC_DIR", dir);
  try {
    setFetchLatestVersion(() => Promise.resolve("v1.2.3"));
    let called = false;
    await refreshCache("v1.2.3", () => {
      called = true;
    });
    assertEquals(
      called,
      false,
      "did not expect notification for current version",
    );
    // sanity: cache path lives under the temp dir
    assertEquals(cachePath().startsWith(dir), true);
  } finally {
    restoreEnv("OPENSAC_DIR", oldDir);
  }
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) runtime.env.delete(key);
  else runtime.env.set(key, value);
}
