// (NeedsApproval decision
// logic). The Agent-construction helpers are replaced with the minimal
// ApprovalConfig view the decision now takes.

import { assert } from "../compat/assert.ts";
import { type AllowConfig } from "../config/allow.ts";
import { type ApprovalSettings, type Settings } from "../config/settings.ts";
import { needsApproval } from "./agent_approval.ts";
import { test } from "#testing";

function approval(a: ApprovalSettings): Settings {
  return { approval: a };
}

function cfg(mode: string, settings: Settings): {
  mode: string;
  settings: Settings;
} {
  return { mode, settings };
}

function cfgAllow(
  mode: string,
  settings: Settings,
  allow: AllowConfig,
): { mode: string; settings: Settings; allow: AllowConfig } {
  return { mode, settings, allow };
}

test("needsApproval: autoEdit skips approval", () => {
  const settings = approval({ confirmBeforeWrite: true });
  const allow: AllowConfig = { autoEdit: true };
  assert(
    !needsApproval(cfgAllow("agent", settings, allow), "write", {
      path: "any/file.go",
    }),
  );
  assert(
    !needsApproval(cfgAllow("agent", settings, allow), "edit", {
      path: "any/file.go",
    }),
  );
});

test("needsApproval: edit-path whitelist", () => {
  const settings = approval({ confirmBeforeWrite: true });
  const allow: AllowConfig = { editPaths: ["internal/**"] };
  assert(
    !needsApproval(cfgAllow("agent", settings, allow), "edit", {
      path: "internal/agent/agent.go",
    }),
  );
  assert(needsApproval(cfgAllow("agent", settings, allow), "edit", {
    path: "cmd/main.go",
  }));
});

test("needsApproval: edit-path plan mode unaffected", () => {
  const allow: AllowConfig = { autoEdit: true, editPaths: ["**"] };
  const c = cfgAllow("plan", approval({}), allow);
  assert(!needsApproval(c, "bash", { command: "ls" }));
});

test("needsApproval: non-bash never needs approval", () => {
  assert(
    !needsApproval(cfg("agent", approval({})), "read", {
      path: "README.md",
    }),
  );
});

test("needsApproval: agent-mode write confirm", () => {
  const c = cfg("agent", approval({ confirmBeforeWrite: true }));
  assert(needsApproval(c, "write", { path: "README.md" }));
  assert(needsApproval(c, "edit", { path: "README.md" }));
});

test("needsApproval: yolo-mode write does not confirm", () => {
  const c = cfg("yolo", approval({ confirmBeforeWrite: true }));
  assert(!needsApproval(c, "write", { path: "README.md" }));
});

test("needsApproval: agent-mode whitelist skips approval", () => {
  const c = cfg("agent", approval({ bashWhitelist: ["go ", "make "] }));
  assert(!needsApproval(c, "bash", { command: "go test ./..." }));
});

test("needsApproval: agent-mode project bash rules skip approval", () => {
  const allow: AllowConfig = {
    bashCommands: ["make test"],
    bashPrefixes: ["go test "],
  };
  const c = cfgAllow("agent", approval({}), allow);
  assert(!needsApproval(c, "bash", { command: "make test" }));
  assert(!needsApproval(c, "bash", { command: "go test ./internal/tui" }));
  assert(needsApproval(c, "bash", { command: "go env" }));
});

test("needsApproval: bash rules accept cmd alias", () => {
  const allow: AllowConfig = { bashCommands: ["make test"] };
  const c = cfgAllow("agent", approval({}), allow);
  assert(!needsApproval(c, "bash", { cmd: "make test" }));
});

test("needsApproval: agent-mode blacklist forces approval", () => {
  const c = cfg(
    "agent",
    approval({
      bashWhitelist: ["go ", "rm "],
      bashBlacklist: ["rm -rf"],
    }),
  );
  assert(needsApproval(c, "bash", { command: "rm -rf /tmp/demo" }));
});

test("needsApproval: blacklist overrides project bash allow", () => {
  const allow: AllowConfig = { bashCommands: ["rm -rf build"] };
  const c = cfgAllow("agent", approval({ bashBlacklist: ["rm -rf"] }), allow);
  assert(needsApproval(c, "bash", { command: "rm -rf build" }));
});

test("needsApproval: agent-mode non-whitelisted needs approval", () => {
  const c = cfg("agent", approval({ bashWhitelist: ["go "] }));
  assert(needsApproval(c, "bash", { command: "python script.py" }));
});

test("needsApproval: yolo-mode allows unless blacklisted", () => {
  const c = cfg("yolo", approval({ bashBlacklist: ["rm -rf"] }));
  assert(!needsApproval(c, "bash", { command: "go test ./..." }));
  assert(needsApproval(c, "bash", { command: "rm -rf /" }));
});

test("needsApproval: os-mode allows unless blacklisted", () => {
  const c = cfg("os", approval({ bashBlacklist: ["rm -rf"] }));
  assert(!needsApproval(c, "bash", { command: "go test ./..." }));
  assert(needsApproval(c, "bash", { command: "rm -rf /" }));
});

test("needsApproval: blacklist overrides whitelist", () => {
  const c = cfg(
    "agent",
    approval({
      bashWhitelist: ["rm ", "rm -rf"],
      bashBlacklist: ["rm -rf"],
    }),
  );
  assert(needsApproval(c, "bash", { command: "rm -rf build" }));
});
