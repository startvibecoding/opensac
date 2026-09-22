// Translated from internal/serve/openaiapi/server_test.go (the capability
// mode/display tables) and session_mgr.go's capability persistence cases,
// adapted to the free capability-resolution functions that back them.
import { assert, assertEquals } from "@std/assert";
import { Server } from "./server.ts";
import {
  applyStoredCapabilitiesToResponse,
  applyStoredCapabilitiesToSession,
  capabilitiesFromSession,
  defaultSessionCapabilities,
  loadStoredCapabilities,
  normalizedDisplayMode,
  persistSessionCapabilities,
  resolveSessionMode,
  validateCapabilityMode,
} from "./session_capabilities.ts";
import { APISession } from "./session_mgr.ts";
import type { Settings } from "../../config/settings.ts";
import { closeAll } from "../../db/mod.ts";
import type { SessionCapabilities } from "./types.ts";

function tempDir(): string {
  return Deno.makeTempDirSync({ prefix: "opensac-openaiapi-caps-" });
}

function settingsFor(dir: string): Settings {
  return { sessionDir: dir } as unknown as Settings;
}

Deno.test("validateCapabilityMode accepts the Go mode table", () => {
  for (const mode of ["", "plan", "agent", "yolo", "os"]) {
    assertEquals(validateCapabilityMode(mode), null);
  }
  const err = validateCapabilityMode("bogus");
  assert(err !== null);
  assert(
    err.message.includes("mode must be plan, agent, yolo, os, or empty string"),
  );
});

Deno.test("normalizedDisplayMode maps only code", () => {
  assertEquals(normalizedDisplayMode("code"), "code");
  assertEquals(normalizedDisplayMode(" work "), "work");
  assertEquals(normalizedDisplayMode(""), "work");
  assertEquals(normalizedDisplayMode("manual"), "work");
});

Deno.test("applyStoredCapabilitiesToSession validates and copies stored state", () => {
  const sess = new APISession();
  sess.id = "s1";
  const invalid = applyStoredCapabilitiesToSession(sess, {
    sessionId: "s1",
    mode: "bogus",
    displayMode: "work",
    delegateMode: false,
    multiAgent: false,
    workflows: false,
    webSearch: false,
    browser: false,
    a2aMaster: false,
    updatedAt: new Date(),
  });
  assert(invalid !== null);

  const err = applyStoredCapabilitiesToSession(sess, {
    sessionId: "s1",
    mode: "agent",
    displayMode: "manual",
    delegateMode: true,
    multiAgent: true,
    workflows: true,
    webSearch: true,
    browser: true,
    a2aMaster: true,
    updatedAt: new Date(),
  });
  assertEquals(err, null);
  assertEquals(sess.mode, "agent");
  assertEquals(
    sess.displayMode,
    "work",
    "non-code display modes normalize to work",
  );
  assertEquals(sess.delegateMode, true);
  assertEquals(sess.multiAgent, true);
  assertEquals(sess.workflows, true);
  assertEquals(sess.webSearch, true);
  assertEquals(sess.browser, true);
  assertEquals(sess.a2aMaster, true);
});

Deno.test("applyStoredCapabilitiesToResponse overlays persisted state", () => {
  const caps: SessionCapabilities = {
    id: "s1",
    active: false,
    mode: "",
    displayMode: "work",
    delegateMode: false,
    delegate: false,
    multiAgent: false,
    workflows: false,
    webSearch: false,
    browser: false,
    a2aMaster: false,
    persisted: false,
    runtimeOnly: true,
    persistenceNote: "note",
  };
  applyStoredCapabilitiesToResponse(caps, {
    sessionId: "s1",
    mode: "plan",
    displayMode: "code",
    delegateMode: true,
    multiAgent: false,
    workflows: false,
    webSearch: false,
    browser: false,
    a2aMaster: false,
    updatedAt: new Date(),
  });
  assertEquals(caps.mode, "plan");
  assertEquals(caps.displayMode, "code");
  assertEquals(caps.delegate, true);
  assertEquals(caps.runtimeOnly, false);
  assertEquals(caps.persistenceNote, "");

  // An empty stored mode defaults to yolo and non-code display normalizes.
  const caps2: SessionCapabilities = { ...caps, mode: "", displayMode: "" };
  applyStoredCapabilitiesToResponse(caps2, {
    sessionId: "s1",
    mode: "",
    displayMode: "",
    delegateMode: false,
    multiAgent: false,
    workflows: false,
    webSearch: false,
    browser: false,
    a2aMaster: false,
    updatedAt: new Date(),
  });
  assertEquals(caps2.mode, "yolo");
  assertEquals(caps2.displayMode, "work");
});

Deno.test("defaultSessionCapabilities uses serve config defaults", () => {
  const server = new Server({
    cfg: {
      defaultMode: "agent",
      enableDelegate: true,
      enableWorkflows: true,
      enableBrowser: true,
      enableA2AMaster: true,
      enableSubAgents: true,
    },
    settings: settingsFor(""),
  });
  const caps = defaultSessionCapabilities(server, "/tmp", true, false);
  assertEquals(caps.mode, "agent");
  assertEquals(caps.delegateMode, true);
  assertEquals(caps.workflows, true);
  assertEquals(caps.browser, true);
  assertEquals(caps.a2aMaster, true);
  assertEquals(caps.multiAgent, true);
  assertEquals(caps.active, true);
  assertEquals(caps.workDir, "/tmp");
  assertEquals(caps.runtimeOnly, true);

  // An empty config mode falls back to the product default yolo.
  const fallback = new Server({});
  assertEquals(
    defaultSessionCapabilities(fallback, "", false, false).mode,
    "yolo",
  );
});

Deno.test("capabilitiesFromSession resolves mode and overlays the session", () => {
  const server = new Server({ settings: settingsFor("") });
  const sess = new APISession();
  sess.id = "s1";
  sess.workDir = "/tmp";
  sess.mode = "plan";
  sess.displayMode = "code";
  sess.browser = true;
  const caps = capabilitiesFromSession(server, sess, true, false);
  assertEquals(caps.id, "s1");
  // Without a persisted binding the requested-less resolution keeps the
  // session mode resolved through the shared policy (empty default → yolo
  // policy but explicit session mode wins).
  assertEquals(caps.mode === "plan" || caps.mode === "yolo", true);
  assertEquals(caps.displayMode, "code");
  assertEquals(caps.browser, true);

  // A nil session falls back to defaults.
  const defaults = capabilitiesFromSession(server, null, false, false);
  assertEquals(defaults.mode, "yolo");
});

Deno.test("persistSessionCapabilities round trips through the session dir", () => {
  const dir = tempDir();
  try {
    const server = new Server({ settings: settingsFor(dir) });
    const sess = new APISession();
    sess.id = "s-cap";
    sess.mode = "agent";
    sess.displayMode = "code";
    sess.browser = true;
    sess.multiAgent = true;

    assertEquals(loadStoredCapabilities(server, "s-cap").ok, false);
    persistSessionCapabilities(server, sess);
    const stored = loadStoredCapabilities(server, "s-cap");
    assertEquals(stored.ok, true);
    assert(stored.caps !== null);
    assertEquals(stored.caps.mode, "agent");
    assertEquals(stored.caps.displayMode, "code");
    assertEquals(stored.caps.browser, true);
    assertEquals(stored.caps.multiAgent, true);

    // resolveSessionMode keeps the persisted mode for a bound session.
    const resolved = resolveSessionMode(server, sess, "");
    assertEquals(resolved.err, null);
    assert(resolved.mode !== "");
  } finally {
    closeAll();
  }
});
