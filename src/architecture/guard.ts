// Static architecture guards for the Deno/TypeScript port.
//
// This is the Deno counterpart of the Go `internal/architecture` package. The
// Go guards parse Go source with `go/ast`; the Deno guards scan `.ts`/`.tsx`
// source lines with a small, dependency-free reader. The rules are the same:
// no direct Agent construction or canonical Run persistence outside
// `src/agentruntime`, one DB→DAO direction, one decision-envelope owner, no
// legacy lease/delivery APIs, the narrow `src/core` foundation boundary, and
// the public SDK boundary.
//
// The scanner is deliberately source-level so fixtures can be scanned without
// running `deno info`; the whole-repo tests call the same functions against the
// real tree.

import { dirname, join, relative } from "@opensac/path";

export interface Violation {
  file: string;
  message: string;
}

const SKIP_DIRS = new Set([".git", "node_modules", "dist"]);
const SOURCE_FILE = /\.(?:ts|tsx|mts|cts)$/;
const TEST_FILE = /_test\.(?:ts|tsx|mts|cts)$/;

// The Core foundation is an explicitly reviewed boundary, not a broad
// exemption from the Agent/runtime rules. Keep this list file-specific: a new
// Core module must be classified before it can become production code.
export const coreBoundaryAllowlist: Record<string, string> = {
  "src/core/auth.ts": "Core HTTP transport authentication",
  "src/core/client.ts": "Core discovery client and transport lifecycle",
  "src/core/config.ts": "Core configuration",
  "src/core/endpoint.ts": "Core endpoint selection and URL validation",
  "src/core/lock.ts": "Core process lock lifecycle",
  "src/core/paths.ts": "Core state path configuration",
  "src/core/protocol.ts": "Core JSON-RPC protocol",
  "src/core/registry.ts": "Core discovery registration lifecycle",
  "src/core/private_core.ts":
    "Isolated private Core lifecycle for standalone entry points",
  "src/core/runtime.ts": "Core Runtime Host neutral contracts",
  "src/core/runtime_protocol.ts": "Core Runtime Host JSON-RPC domain schemas",
  "src/core/runtime_host.ts": "Core Runtime Host implementation boundary",
  "src/core/dispatcher.ts": "Core Runtime Host domain dispatcher",
  "src/core/event_stream.ts":
    "Core Runtime Host event and reverse-request stream",
  "src/core/server.ts": "Core HTTP transport and listener lifecycle",
  "src/core/main.ts": "Dedicated Core process entrypoint",
};

const ACP_BRIDGE_FILE = /^src\/acp\/bridge(?:_[^/]+)?\.ts$/;
const ACP_FORBIDDEN_RUNTIME_ROOTS = [
  "src/agent",
  "src/agentruntime",
  "src/provider",
  "src/session",
  "src/tools",
  "src/mcp",
  "src/db",
  "src/dao",
];

const CORE_FORBIDDEN_RUNTIME_ROOTS = [
  "src/agent",
  "src/agentruntime",
  "src/provider",
  "src/session",
  "src/tools",
  "src/mcp",
  "src/workflow",
  "src/expert",
  "src/sandbox",
  "src/skills",
  "src/cron",
  "src/esm",
  "src/context",
  "src/ai",
  "src/db",
  "src/dao",
];

// Core production dependencies are deliberately narrower than the repository's
// runtime dependency graph. The settings and allow-policy files are the reviewed
// configuration boundary; every other local dependency must stay in src/core.
const CORE_ALLOWED_LOCAL_FILES = new Set([
  "src/cli/core.ts",
  "src/config/allow.ts",
  "src/config/env.ts",
  "src/config/mcp.ts",
  "src/config/mod.ts",
  "src/config/settings.ts",
  "src/doctor/doctor.ts",
  "src/skillhub/mod.ts",
  "src/memory/store.ts",
  "src/stats/stats.ts",
]);
// The Node-backed `@opensac/*` compat modules plus npm packages are the
// external dependencies a reviewed Core file may carry; JSR and `@std/*` are
// no longer used, so a reintroduction is flagged.
const CORE_ALLOWED_EXTERNAL_PREFIXES = ["@opensac/", "npm:"];

// Every SQLite spelling that turns foreign key enforcement ON: `foreign_keys(1)`
// /`(ON)`/`(TRUE)` DSN pragmas and `PRAGMA foreign_keys = 1/ON/TRUE`,
// case-insensitively. Values that disable enforcement do not match. Only
// `src/db` may contain it; the canonical session database policy keeps
// enforcement OFF and exposes an explicit opt-in for private derived stores.
export const foreignKeyEnforcementPattern =
  /foreign_keys\s*(?:\(\s*(?:1|on|true)\s*\)|=\s*(?:1|on|true))/i;

const STATIC_IMPORT =
  /import\s+(?:type\s+)?(?:[^"'`]*?from\s+)?["']([^"']+)["']/g;
const STATIC_EXPORT =
  /export\s+(?:type\s+)?(?:\*(?:\s+as\s+[A-Za-z_$][\w$]*)?|\{[^}]*\})\s+from\s*["']([^"']+)["']/g;
const DYNAMIC_IMPORT = /import\s*\(\s*["']([^"']+)["']\s*\)/g;

// Direct SQLite handles. The receiver-name check keeps HTTP/URL `query` and
// unrelated `*.prepare` methods (for example `delivery.prepare`) out of scope.
const DIRECT_SQL_CALL =
  /\b(db|tx|database|sqlDB|rootDB|sessionDB|first|second|reopened)\s*\.\s*(prepare|exec|query)\s*\(/;

const NEW_AGENT = /\bnew\s+(Agent|AgentLoop)\s*\(/;

// TUI/CLI front-end ownership (Task 6/7 of the TUI service abstraction): the
// interactive and print entries are thin `TUIService`/Core Client projections.
// They may never depend on Agent, SessionRuntime, session-lifecycle/fork,
// provider-construction, session-store, or DAO modules; the canonical event
// vocabulary arrives through `src/agentruntime/events.ts`.
export const TUI_FORBIDDEN_IMPORT_ROOTS = [
  "src/agent/",
  "src/agentruntime/session_runtime.ts",
  "src/agentruntime/session_lifecycle.ts",
  "src/agentruntime/fork.ts",
  "src/provider/",
  "src/session/",
  "src/dao/",
];

/** `src/tui/service.ts` is a pure port: no runtime implementation imports. */
export const TUI_SERVICE_FORBIDDEN_IMPORT_ROOTS = [
  "src/agent/",
  "src/agentruntime/",
  "src/provider/",
  "src/session/",
  "src/dao/",
];

/** Extra import roots banned from the CLI print entry (Core Client only). */
export const CLI_PRINT_FORBIDDEN_IMPORT_ROOTS = [
  ...TUI_FORBIDDEN_IMPORT_ROOTS,
  "src/agentruntime/execution.ts",
  "src/agentruntime/execution_admission.ts",
  "src/agentruntime/session_run.ts",
  "src/agentruntime/input_materializer.ts",
];

/** Constructor classes the TUI/CLI front-end may never instantiate. */
export const TUI_FORBIDDEN_NEW_CLASSES = [
  "Agent",
  "AgentLoop",
  "AgentManager",
  "Builder",
  "ExecutionRuntime",
  "DecisionService",
];

/** Runtime factory calls the TUI/CLI front-end may never invoke directly. */
export const TUI_FORBIDDEN_CALLS = [
  "createAgentManager",
  "createSessionExecutionRuntime",
  "createSessionRunDescriptor",
  "acquireExecutionAdmission",
  "createSessionRuntime",
];

/** Entry modules where the plan names the bare `createSession` construction. */
export const TUI_ENTRY_FILES = [
  "src/tui/tui_session.ts",
  "src/cli/root_tui.ts",
  "src/cli/root_print.ts",
];

const BARE_CREATE_SESSION = /(?<![.\w$])createSession\s*\(/;

/** Reports whether a production file belongs to the TUI/CLI front-end graph. */
export function isTuiFrontendPath(rel: string): boolean {
  const slash = toSlash(rel);
  return slash.startsWith("src/tui/") ||
    slash === "src/cli/root_tui.ts" || slash === "src/cli/root_print.ts";
}

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

export function isACPBridgePath(rel: string): boolean {
  return ACP_BRIDGE_FILE.test(toSlash(rel));
}

export function isCorePath(rel: string): boolean {
  return toSlash(rel).startsWith("src/core/");
}

function isCoreBoundaryAllowlisted(rel: string): boolean {
  return Object.prototype.hasOwnProperty.call(
    coreBoundaryAllowlist,
    toSlash(rel),
  );
}

function isForbiddenCoreRuntimeImport(
  rel: string,
  specifier: string,
): boolean {
  if (toSlash(rel) === "src/core/runtime_host.ts") return false;
  const target = resolveImportTarget(rel, specifier);
  if (target === undefined) return false;
  return CORE_FORBIDDEN_RUNTIME_ROOTS.some(
    (root) => target === root || target.startsWith(`${root}/`),
  );
}

function isAllowedCoreImport(rel: string, specifier: string): boolean {
  const target = resolveImportTarget(rel, specifier);
  if (target !== undefined) {
    if (toSlash(rel) === "src/core/runtime_host.ts") {
      return target.startsWith("src/core/") ||
        CORE_ALLOWED_LOCAL_FILES.has(target) ||
        CORE_FORBIDDEN_RUNTIME_ROOTS.some(
          (root) => target === root || target.startsWith(`${root}/`),
        );
    }
    return target.startsWith("src/core/") ||
      CORE_ALLOWED_LOCAL_FILES.has(target);
  }
  return CORE_ALLOWED_EXTERNAL_PREFIXES.some((prefix) =>
    specifier.startsWith(prefix)
  );
}

function resolveImportTarget(
  rel: string,
  specifier: string,
): string | undefined {
  if (specifier.startsWith(".")) {
    return toSlash(join(dirname(rel), specifier));
  }
  if (specifier.startsWith("src/")) return toSlash(specifier);
  return undefined;
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
  for (const match of src.matchAll(STATIC_EXPORT)) out.push(match[1]);
  for (const match of src.matchAll(DYNAMIC_IMPORT)) out.push(match[1]);
  return out;
}

// Finds a non-literal dynamic import without treating an expression that
// starts with a quoted string as a literal. The previous negative-lookahead
// regex missed forms such as `import("../agent/" + name + ".ts")` because the
// expression began with a quote. A small source walk keeps comments and string
// contents out of the candidate set and accepts only one complete quoted
// specifier as safe.
function hasNonLiteralDynamicImport(src: string): boolean {
  let index = 0;
  while (index < src.length) {
    const character = src[index];
    if (character === "/" && src[index + 1] === "/") {
      index = skipLineComment(src, index);
      continue;
    }
    if (character === "/" && src[index + 1] === "*") {
      index = skipBlockComment(src, index);
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      index = skipQuoted(src, index, character);
      continue;
    }
    if (!isIdentifierStart(character)) {
      index++;
      continue;
    }

    const wordStart = index;
    index++;
    while (index < src.length && isIdentifierPart(src[index])) index++;
    if (src.slice(wordStart, index) !== "import") continue;

    const open = skipWhitespaceAndComments(src, index);
    if (src[open] !== "(") continue;
    const close = findClosingParenthesis(src, open + 1);
    if (
      close === undefined || !isPlainStringLiteral(src.slice(open + 1, close))
    ) {
      return true;
    }
    index = close + 1;
  }
  return false;
}

function skipLineComment(src: string, start: number): number {
  const newline = src.indexOf("\n", start + 2);
  return newline === -1 ? src.length : newline + 1;
}

function skipBlockComment(src: string, start: number): number {
  const end = src.indexOf("*/", start + 2);
  return end === -1 ? src.length : end + 2;
}

function skipQuoted(src: string, start: number, quote: string): number {
  let index = start + 1;
  while (index < src.length) {
    if (src[index] === "\\") {
      index += 2;
      continue;
    }
    if (src[index] === quote) return index + 1;
    index++;
  }
  return src.length;
}

function skipWhitespaceAndComments(src: string, start: number): number {
  let index = start;
  while (index < src.length) {
    if (/\s/.test(src[index])) {
      index++;
      continue;
    }
    if (src[index] === "/" && src[index + 1] === "/") {
      index = skipLineComment(src, index);
      continue;
    }
    if (src[index] === "/" && src[index + 1] === "*") {
      index = skipBlockComment(src, index);
      continue;
    }
    break;
  }
  return index;
}

function findClosingParenthesis(
  src: string,
  start: number,
): number | undefined {
  let depth = 1;
  let index = start;
  while (index < src.length) {
    const character = src[index];
    if (character === "/" && src[index + 1] === "/") {
      index = skipLineComment(src, index);
      continue;
    }
    if (character === "/" && src[index + 1] === "*") {
      index = skipBlockComment(src, index);
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      index = skipQuoted(src, index, character);
      continue;
    }
    if (character === "(") depth++;
    if (character === ")") {
      depth--;
      if (depth === 0) return index;
    }
    index++;
  }
  return undefined;
}

function isPlainStringLiteral(value: string): boolean {
  const quote = value[0];
  if (quote !== '"' && quote !== "'") return false;
  let index = 1;
  while (index < value.length) {
    if (value[index] === "\\") {
      index += 2;
      continue;
    }
    if (value[index] === quote) return index === value.length - 1;
    index++;
  }
  return false;
}

function isIdentifierStart(character: string): boolean {
  return /[A-Za-z_$]/.test(character);
}

function isIdentifierPart(character: string): boolean {
  return /[A-Za-z0-9_$]/.test(character);
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

  if (isACPBridgePath(rel)) {
    for (const specifier of importSpecifiers(src)) {
      const target = resolveImportTarget(rel, specifier);
      if (
        target !== undefined && ACP_FORBIDDEN_RUNTIME_ROOTS.some(
          (root) => target === root || target.startsWith(`${root}/`),
        )
      ) {
        add(`ACP bridge imports runtime implementation module ${specifier}`);
      }
    }
  }

  if (isCorePath(rel)) {
    if (!isCoreBoundaryAllowlisted(rel)) {
      add(
        "Core production files must be explicitly classified in the Core protocol/transport/lifecycle/configuration allowlist",
      );
    }
    for (const specifier of importSpecifiers(src)) {
      if (isForbiddenCoreRuntimeImport(rel, specifier)) {
        add(
          `Core foundation imports runtime implementation module ${specifier}; wait for the runtime-host migration design`,
        );
      } else if (!isAllowedCoreImport(rel, specifier)) {
        add(
          `Core foundation dependency ${specifier} is not in the reviewed Core dependency allowlist`,
        );
      }
    }
    if (hasNonLiteralDynamicImport(src)) {
      add(
        "Core foundation uses a non-literal dynamic import; use a literal module specifier",
      );
    }
  }

  if (isTuiFrontendPath(rel)) {
    const slash = toSlash(rel);
    const banned = slash === "src/tui/service.ts"
      ? TUI_SERVICE_FORBIDDEN_IMPORT_ROOTS
      : slash === "src/cli/root_print.ts"
      ? CLI_PRINT_FORBIDDEN_IMPORT_ROOTS
      : TUI_FORBIDDEN_IMPORT_ROOTS;
    for (const specifier of importSpecifiers(src)) {
      const target = resolveImportTarget(rel, specifier);
      if (
        target !== undefined &&
        banned.some((root) =>
          root.endsWith("/") ? target.startsWith(root) : target === root
        )
      ) {
        add(
          `TUI front-end imports runtime implementation module ${specifier}; use the TUIService/Core Client surface`,
        );
      }
    }
    const newOwner = new RegExp(
      `\\bnew\\s+(${TUI_FORBIDDEN_NEW_CLASSES.join("|")})\\s*\\(`,
    );
    const newMatch = newOwner.exec(src);
    if (newMatch) {
      add(
        `TUI front-end constructs ${
          newMatch[1]
        }; runtime owners are built only by the Core runtime host`,
      );
    }
    for (const name of TUI_FORBIDDEN_CALLS) {
      const bareCall = new RegExp(`(?<![.\\w$])${name}\\s*\\(`);
      if (bareCall.test(src)) {
        add(
          `TUI front-end invokes runtime owner ${name}; use the TUIService/Core Client surface`,
        );
      }
    }
    if (
      TUI_ENTRY_FILES.includes(slash) && BARE_CREATE_SESSION.test(src)
    ) {
      add(
        "TUI front-end constructs createSession; persisted session identity is Core-owned",
      );
    }
  }

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

/** TUI/CLI front-end ownership violations (the Task 6/7 boundary). */
export function tuiBoundaryViolations(root: string): Violation[] {
  return productionViolations(root).filter((violation) =>
    isTuiFrontendPath(violation.file)
  );
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
  "src/acp/ownership_test.ts":
    "contains synthetic source fixtures that intentionally exercise ACP bridge ownership rejection",
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
