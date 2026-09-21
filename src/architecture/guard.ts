// Static architecture guards for the Deno/TypeScript port.
//
// This is the Deno counterpart of the Go `internal/architecture` package. The
// Go guards parse Go source with `go/ast`; the Deno guards scan `.ts`/`.tsx`
// source lines with a small, dependency-free reader. The rules are the same:
// no direct Agent construction or canonical Run persistence outside
// `src/agentruntime`, one DB→DAO direction, one decision-envelope owner, no
// legacy lease/delivery APIs, and the public SDK boundary.
//
// The scanner is deliberately source-level so fixtures can be scanned without
// running `deno info`; the whole-repo tests call the same functions against the
// real tree.

import { join, relative } from "@std/path";

export interface Violation {
  file: string;
  message: string;
}

const SKIP_DIRS = new Set([".git", "node_modules", "dist"]);
const SOURCE_FILE = /\.(?:ts|tsx|mts|cts)$/;
const TEST_FILE = /_test\.(?:ts|tsx|mts|cts)$/;

// Every SQLite spelling that turns foreign key enforcement ON: `foreign_keys(1)`
// /`(ON)`/`(TRUE)` DSN pragmas and `PRAGMA foreign_keys = 1/ON/TRUE`,
// case-insensitively. Values that disable enforcement do not match. Only
// `src/db` may contain it; the canonical session database policy keeps
// enforcement OFF and exposes an explicit opt-in for private derived stores.
export const foreignKeyEnforcementPattern =
  /foreign_keys\s*(?:\(\s*(?:1|on|true)\s*\)|=\s*(?:1|on|true))/i;

const STATIC_IMPORT =
  /import\s+(?:type\s+)?(?:[^"'`]*?from\s+)?["']([^"']+)["']/g;
const DYNAMIC_IMPORT = /import\s*\(\s*["']([^"']+)["']\s*\)/g;

// Direct SQLite handles. The receiver-name check keeps HTTP/URL `query` and
// unrelated `*.prepare` methods (for example `delivery.prepare`) out of scope.
const DIRECT_SQL_CALL =
  /\b(db|tx|database|sqlDB|rootDB|sessionDB|first|second|reopened)\s*\.\s*(prepare|exec|query)\s*\(/;

const NEW_AGENT = /\bnew\s+(Agent|AgentLoop)\s*\(/;

const CANONICAL_RUN_PERSISTENCE = [
  "saveSessionRun",
  "createSessionRun",
  "updateSessionRunStatus",
  "saveSessionRunEvent",
];
const CANONICAL_RUN_QUERY = [
  "getSessionRun",
  "getSessionRunContext",
  "getActiveSessionRun",
  "getActiveSessionRunContext",
];
const LEGACY_RUNTIME_LEASE = [
  "tryLockRuntime",
  "lockRuntime",
  "tryLockRuntimes",
];
const LEGACY_ATTACHMENT_DELIVERY = [
  "projectDeliveries",
  "beginDelivery",
  "finishDelivery",
];

export function toSlash(path: string): string {
  return path.replaceAll("\\", "/");
}

export function relativeSlash(root: string, file: string): string {
  return toSlash(relative(root, file));
}

export function isTestPath(rel: string): boolean {
  return TEST_FILE.test(rel);
}

// `src/db` owns connection lifecycle, `src/dao` owns SQL, and the session
// schema/migration modules are the only other files allowed to name a SQLite
// driver or run schema SQL.
export function isSchemaOrDatabaseOwner(rel: string): boolean {
  const p = toSlash(rel);
  return (
    p === "src/session/schema.ts" ||
    p === "src/session/migrations.ts" ||
    p.startsWith("src/db/") ||
    p.startsWith("src/dao/")
  );
}

function isDatabaseOwner(rel: string): boolean {
  const p = toSlash(rel);
  return p.startsWith("src/db/") || p.startsWith("src/dao/");
}

function isAgentRuntime(rel: string): boolean {
  return toSlash(rel).startsWith("src/agentruntime/");
}

function isAgentPackage(rel: string): boolean {
  return toSlash(rel).startsWith("src/agent/");
}

function isSessionPackage(rel: string): boolean {
  return toSlash(rel).startsWith("src/session/");
}

// The guard implementation itself names every forbidden token (the decision
// strings, the direct-SQL regexes, the legacy API names), so it owns them and
// is exempt from its own scans.
function isGuardPackage(rel: string): boolean {
  return toSlash(rel).startsWith("src/architecture/");
}

export function walkSourceFiles(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string): void => {
    let entries: Deno.DirEntry[];
    try {
      entries = [...Deno.readDirSync(dir)];
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory) {
        if (SKIP_DIRS.has(entry.name)) continue;
        visit(join(dir, entry.name));
      } else if (entry.isFile && SOURCE_FILE.test(entry.name)) {
        out.push(join(dir, entry.name));
      }
    }
  };
  visit(root);
  out.sort();
  return out;
}

// Extract top-level import specifiers (static and dynamic). Template-literal
// bodies are ignored by `stringLiterals`, but import statements never live in a
// template body, so a plain regex is faithful here.
export function importSpecifiers(src: string): string[] {
  const out: string[] = [];
  for (const match of src.matchAll(STATIC_IMPORT)) out.push(match[1]);
  for (const match of src.matchAll(DYNAMIC_IMPORT)) out.push(match[1]);
  return out;
}

// Collect the value of every plain `"..."`/`'...'` string literal while
// skipping comments and template-literal bodies. This mirrors Go's `BasicLit`
// check (a template literal's contents are not string literals) and avoids
// false positives such as the ESM recovery prompt JSON embedded in a
// template literal.
export function stringLiterals(src: string): string[] {
  const out: string[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'") {
      const quote = c;
      i++;
      let value = "";
      while (i < n && src[i] !== quote) {
        if (src[i] === "\\") {
          value += src[i + 1] ?? "";
          i += 2;
          continue;
        }
        value += src[i];
        i++;
      }
      i++;
      out.push(value);
      continue;
    }
    if (c === "`") {
      i++;
      while (i < n && src[i] !== "`") {
        if (src[i] === "\\") {
          i += 2;
          continue;
        }
        i++;
      }
      i++;
      continue;
    }
    i++;
  }
  return out;
}

function callNames(src: string, names: string[]): string[] {
  const found: string[] = [];
  for (const name of names) {
    const re = new RegExp(`\\b${name}\\s*\\(`, "g");
    if (re.test(src)) found.push(name);
  }
  return found;
}

function scanFile(rel: string, src: string): Violation[] {
  const violations: Violation[] = [];
  const add = (message: string) => violations.push({ file: rel, message });

  if (!isDatabaseOwner(rel) && foreignKeyEnforcementPattern.test(src)) {
    add(
      "SQLite foreign key enforcement is owned by src/db; do not enable foreign_keys here",
    );
  }

  if (!isSchemaOrDatabaseOwner(rel)) {
    for (const specifier of importSpecifiers(src)) {
      if (specifier === "node:sqlite" || specifier.startsWith("node:sqlite/")) {
        add(
          "node:sqlite is restricted to src/db, src/dao, and schema migrations; use src/db plus src/dao",
        );
      }
    }
    if (DIRECT_SQL_CALL.test(src)) {
      const match = src.match(DIRECT_SQL_CALL);
      add(
        `direct database ${match?.[2] ?? "call"}; move SQL into src/dao`,
      );
    }
  }

  if (!isSessionPackage(rel)) {
    for (const value of stringLiterals(src)) {
      if (value === "decision_") {
        add(
          "decision event names belong to src/session; use agentruntime.BuildDecisionEvent",
        );
        break;
      }
    }
  }
  if (!isAgentRuntime(rel)) {
    for (const value of stringLiterals(src)) {
      if (value === "decision") {
        add(
          "the decision envelope belongs to src/agentruntime; use agentruntime.DecisionEventFields",
        );
        break;
      }
    }
  }

  if (
    isAgentRuntime(rel) || isAgentPackage(rel) || isGuardPackage(rel) ||
    isSessionPackage(rel)
  ) {
    return violations;
  }

  if (NEW_AGENT.test(src)) {
    const match = src.match(NEW_AGENT);
    add(
      `direct new ${
        match?.[1] ?? "Agent"
      }; use SessionRuntime.BuildAgent/BuildTransientAgent`,
    );
  }
  for (const name of callNames(src, CANONICAL_RUN_PERSISTENCE)) {
    add(`direct session.${name}; use ExecutionRuntime/RunStore`);
  }
  for (const name of callNames(src, CANONICAL_RUN_QUERY)) {
    add(`direct session.${name}; use the agentruntime durable query boundary`);
  }
  for (const name of callNames(src, LEGACY_RUNTIME_LEASE)) {
    add(
      `new use of legacy session.${name}; use an explicit admission/execution/recovery/mutation lease API`,
    );
  }
  for (const name of callNames(src, LEGACY_ATTACHMENT_DELIVERY)) {
    add(
      `new use of legacy attachment delivery API ${name}; use DeliveryCoordinator/DeliveryOperation`,
    );
  }
  const runStore = /(?:runStore|RunStore)\s*\.\s*(create|update|finish)\s*\(/;
  const runStoreMatch = runStore.exec(src);
  if (runStoreMatch) {
    add(
      `direct agentruntime.RunStore.${
        runStoreMatch[1]
      }; use ExecutionRuntime durable lifecycle methods`,
    );
  }
  return violations;
}

export function productionViolations(root: string): Violation[] {
  const violations: Violation[] = [];
  for (const file of walkSourceFiles(root)) {
    const rel = relativeSlash(root, file);
    if (isTestPath(rel)) continue;
    if (isGuardPackage(rel)) continue;
    const src = Deno.readTextFileSync(file);
    violations.push(...scanFile(rel, src));
  }
  violations.sort((a, b) =>
    a.file === b.file
      ? a.message.localeCompare(b.message)
      : a.file.localeCompare(b.file)
  );
  return violations;
}

// The public SDK (`sdk/`) and the examples must never import `src/`; wiring
// belongs in `src/bootstrap/`.
export function publicSdkInternalImports(root: string, dir: string): string[] {
  const violations: string[] = [];
  const base = join(root, dir);
  for (const file of walkSourceFiles(base)) {
    const rel = relativeSlash(root, file);
    if (isTestPath(rel)) continue;
    const src = Deno.readTextFileSync(file);
    for (const specifier of importSpecifiers(src)) {
      if (
        specifier.includes("/src/") || specifier.startsWith("src/") ||
        specifier === "src" || specifier.includes("../src/")
      ) {
        violations.push(`${rel} imports ${specifier}`);
      }
    }
  }
  violations.sort();
  return violations;
}

// Adapter tests must use the canonical runtime boundaries instead of seeding
// canonical run/lease state through the legacy session APIs or building a
// low-level agent directly. Owner packages and the guard itself are exempt.
export const legacyTestExemptDirs = [
  "src/agentruntime/",
  "src/session/",
  "src/dao/",
  "src/db/",
  "src/agent/",
  "src/architecture/",
];

// Documents adapter test files that still construct canonical run/lease state
// through the legacy APIs. Each entry must state why it cannot migrate yet; the
// list may only shrink.
export const legacyTestAllowlist: Record<string, string> = {
  // The 1:1 translation of `manage_delivery_test.go`: a delivery plan validates
  // that its Run belongs to the session, so the adapter fixture seeds one
  // completed Run through `session.createSessionRun` exactly as the Go test's
  // `session.CreateSessionRun` does. Remove once a test-only RunStore fixture
  // exists that adapter tests can use without the legacy session API.
  "src/acp/manage_test.ts":
    "seeds a completed Run so the Runtime delivery-plan ownership check passes",
  // The 1:1 translation of `watchdog_test.go`: the fixture seeds one running
  // Run through `session.saveSessionRun`, reads it back with
  // `session.getSessionRun`, and holds `session.lockRuntime` exactly as the Go
  // test does. Remove once a test-only RunStore fixture exists.
  "src/serve/channels/watchdog_test.ts":
    "seeds and reads one running Run and holds the legacy runtime lock like the Go watchdog fixtures",
  // The 1:1 translation of `delivery_recovery_test.go`: the fixture seeds one
  // completed Run through `session.createSessionRun` exactly as the Go test
  // does, so the recovery coordinator's durable projection is exercised against
  // real session rows. Remove once a test-only RunStore fixture exists.
  "src/serve/delivery_recovery_test.ts":
    "seeds a completed Run so the recovery coordinator replays its durable delivery",
  // The 1:1 translation of `session_lifecycle_test.go`: the fixture holds
  // `session.lockRuntime` exactly as the Go test does to prove the lifecycle
  // service refuses a busy session and rotates past it with force. Remove once
  // a test-only admission fixture exists.
  "src/serve/session_lifecycle_test.ts":
    "holds the legacy runtime lock to reproduce the Go busy-session rotate fixtures",
  // The 1:1 translation of the deferred `dispatcher_test.go` halves: the
  // stale-run recovery fixture seeds one running Run through
  // `session.saveSessionRun` and reads the stale/recovered rows with
  // `session.getSessionRun` exactly as the Go test does. Remove once a
  // test-only RunStore fixture exists.
  "src/serve/channels/dispatcher_message_test.ts":
    "seeds and reads one stale running Run like the Go dispatcher fixtures",
};

function isLegacyTestExempt(rel: string): boolean {
  return legacyTestExemptDirs.some((prefix) => toSlash(rel).startsWith(prefix));
}

export function legacyTestBoundaryViolations(
  root: string,
): Violation[] {
  const violations: Violation[] = [];
  for (const file of walkSourceFiles(root)) {
    const rel = relativeSlash(root, file);
    if (!isTestPath(rel)) continue;
    if (rel in legacyTestAllowlist) continue;
    if (isLegacyTestExempt(rel)) continue;
    const src = Deno.readTextFileSync(file);
    const details: string[] = [];
    for (const name of callNames(src, CANONICAL_RUN_PERSISTENCE)) {
      details.push(
        `session.${name}; use agentruntime.RunStore/SessionRunEventSink`,
      );
    }
    for (const name of callNames(src, CANONICAL_RUN_QUERY)) {
      details.push(`session.${name}; use agentruntime.GetDurableRun`);
    }
    for (const name of callNames(src, LEGACY_RUNTIME_LEASE)) {
      details.push(
        `session.${name}; use agentruntime.AcquireExecutionAdmission`,
      );
    }
    if (NEW_AGENT.test(src)) {
      details.push(
        "agent.New; use SessionRuntime.BuildAgent/BuildTransientAgent/NewAgentManager",
      );
    }
    if (details.length > 0) {
      violations.push({ file: rel, message: details.join("; ") });
    }
  }
  violations.sort((a, b) => a.file.localeCompare(b.file));
  return violations;
}
