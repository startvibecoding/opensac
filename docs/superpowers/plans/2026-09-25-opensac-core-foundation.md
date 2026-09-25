# OpenSAC Core Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the independently testable first slice of the single-global-Core architecture: Core settings, JSON-RPC 2.0 protocol primitives, Core discovery/registration/locking, a Core HTTP server/client, and an `opensac core` lifecycle command without migrating TUI, CLI, or ACP yet.

**Architecture:** Add a focused `src/core/` subsystem. `CoreServer` uses ordinary JSON-RPC 2.0 over HTTP POST and owns health/capabilities/lifecycle responses in this first slice. `CoreClient` reads the registration file, performs health/version/auth checks, and can launch the Core through an injected launcher abstraction. A `core.lock` provides normal single-instance exclusion; `session_runtime_leases` remains unchanged and is not reimplemented in this phase. Later plans will add the real SessionRuntime host and migrate ACP, TUI, CLI, and WebUI to the client.

**Tech Stack:** Deno 2.9+, TypeScript 6, Deno standard Web APIs, `Deno.serve`, `Deno.Command`, `Deno.mkdir`, `Deno.rename`, `fetch`, JSON-RPC 2.0, existing `@std/assert` and `@std/path` imports.

**Spec:** `docs/proposal/opensac-core-runtime-design.md`

## Global Constraints

- Core is unique per user, machine, and `OPENSAC_DIR` state root.
- Default Core host is `127.0.0.1`; default port is `4096`; port `0` requests an OS-selected port.
- `auth: false` disables password validation; `auth: true` requires a non-empty `passwords` array; any configured password matches.
- Passwords never appear in the registration file or URL.
- Use JSON-RPC 2.0; do not add HTTP/3, WebTransport, or an external HTTP framework.
- Real-time events must be independent JSON-RPC notifications, never batched with streaming deltas; event sequencing and cursor replay are part of the protocol contract.
- Do not reimplement or change `session_runtime_leases` in this phase.
- TUI, CLI, ACP, and WebUI remain on their current paths until the Core foundation and protocol tests pass.
- Do not import `src/` from `sdk/`; do not add direct Agent construction in `src/core/`.
- Tests that read or write Core state must use a temporary directory and must not mutate process-wide environment variables.
- Run focused Deno tests from `/home/free/src/opensac`; do not run tests from a parent repository root.
- Do not commit changes unless the user explicitly requests commits.

## Review Focus

- Two clients racing to discover/start Core must never produce two healthy registered Core processes.
- A stale registration or reused PID must not cause a client to kill or trust an unrelated process.
- `auth: true` with an empty password list must fail closed before the server starts.
- JSON-RPC streaming notifications must remain individually ordered and replayable after a cursor reconnect.
- A Core client must fail clearly when the configured port is occupied by an unrelated process instead of silently choosing another Core.

---

### Task 1: Add Core settings and resolved configuration

**Files:**
- Create: `src/core/config.ts`
- Modify: `src/config/settings.ts:29-268, 757-903, 986-1032`
- Modify: `src/config/mod.ts:3-84`
- Test: `src/config/settings_test.ts`
- Test: `src/core/config_test.ts`

**Interfaces:**
- Produces `CoreSettings` and `ResolvedCoreConfig` consumed by every later Core task.
- Produces `resolveCoreConfig(settings: Settings): ResolvedCoreConfig`.

- [ ] **Step 1: Write failing settings serialization and resolution tests.**

Add tests that assert:

```ts
const settings = defaultSettings();
assertEquals(settings.core, {
  host: "127.0.0.1",
  port: 4096,
  auth: false,
  passwords: [],
});
assertEquals(resolveCoreConfig(settings), {
  host: "127.0.0.1",
  port: 4096,
  auth: false,
  passwords: [],
});
```

Also assert that a project/global settings merge preserves an explicit `core.port`, `core.host`, `core.auth`, and `core.passwords`, and that `marshalSettings` emits the `core` object.

- [ ] **Step 2: Run the focused tests and verify they fail.**

Run:

```bash
cd /home/free/src/opensac
deno test -A src/config/settings_test.ts src/core/config_test.ts
```

Expected: FAIL because `Settings.core`, `resolveCoreConfig`, and the new serialization fields do not exist.

- [ ] **Step 3: Add the configuration types and resolver.**

Implement these public types in `src/core/config.ts`:

```ts
export interface CoreSettings {
  host?: string
  port?: number
  auth?: boolean
  passwords?: string[]
}

export interface ResolvedCoreConfig {
  host: string
  port: number
  auth: boolean
  passwords: string[]
}

export const defaultCoreConfig = (): ResolvedCoreConfig => ({
  host: "127.0.0.1",
  port: 4096,
  auth: false,
  passwords: [],
});

export function resolveCoreConfig(settings: Settings): ResolvedCoreConfig
```

The resolver must reject non-string hosts, non-integer ports, ports outside `0..65535`, non-boolean `auth`, non-string password entries, and `auth: true` with an empty password list. It must copy the passwords array rather than retaining the settings object.

- [ ] **Step 4: Integrate Core settings into the existing settings schema.**

Modify `Settings` to include `core?: CoreSettings`, add `core` to `defaultSettings()`, add `core` to the nested-object parsing key map, and add a `jsonCore()` serializer that always preserves the explicit `auth` and `host` values while writing the configured port and passwords. Export the Core types and resolver from `src/config/mod.ts` without creating a second config loading path.

- [ ] **Step 5: Run the focused tests and verify they pass.**

Run:

```bash
cd /home/free/src/opensac
deno test -A src/config/settings_test.ts src/core/config_test.ts
```

Expected: PASS, including serialization round trips and invalid `auth: true`/empty-password rejection.

---

### Task 2: Define strict Core JSON-RPC protocol primitives

**Files:**
- Create: `src/core/protocol.ts`
- Create: `src/core/protocol_test.ts`

**Interfaces:**
- Produces `CoreRpcRequest`, `CoreRpcResponse`, `CoreRpcNotification`, and `CoreRpcError`.
- Produces `CoreHealth` with `healthy`, `version`, and `protocolVersion`.
- Produces `CoreInfo` with `version`, `protocolVersion`, `coreProtocolVersion`, and `features`.
- Produces `parseCoreRpcMessage(input: unknown): CoreRpcMessage | undefined`.
- Produces `coreResult(id: unknown, result: unknown): CoreRpcResponse`.
- Produces `coreError(id: unknown, code: number, message: string, data?: unknown): CoreRpcResponse`.
- Produces `coreNotification(method: string, params: unknown): CoreRpcNotification`.

- [ ] **Step 1: Write failing parser and envelope tests.**

Cover:

```ts
assertEquals(parseCoreRpcMessage({ jsonrpc: "2.0", id: 1, method: "core.health" })?.method, "core.health");
assertEquals(parseCoreRpcMessage({ jsonrpc: "2.0", method: "run.text_delta", params: { sequence: 1 } })?.method, "run.text_delta");
assertEquals(parseCoreRpcMessage({ jsonrpc: "1.0", id: 1, method: "core.health" }), undefined);
assertEquals(parseCoreRpcMessage({ id: 1, result: {} }), undefined);
assertEquals(parseCoreRpcMessage({ jsonrpc: "2.0", id: 1, error: { code: -32603, message: "boom" } })?.error?.code, -32603);
```

Also test that notification envelopes have no `id`, errors have numeric codes, IDs preserve string-vs-number identity, and malformed JSON/non-object values are rejected.

- [ ] **Step 2: Run the protocol tests and verify they fail.**

Run:

```bash
cd /home/free/src/opensac
deno test -A src/core/protocol_test.ts
```

Expected: FAIL because the Core protocol module does not exist.

- [ ] **Step 3: Implement strict protocol decoding and encoding.**

Use a discriminated union rather than accepting arbitrary records. The decoder must require `jsonrpc: "2.0"`, validate request/response/notification shape, preserve `id` values without coercing `"1"` to `1`, and reject an envelope that contains both `method` and `result`/`error` in an invalid combination. Error data may remain `unknown`; do not use `any`.

Define the initial Core method names as constants:

```ts
export const CORE_METHODS = {
  health: "core.health",
  info: "core.info",
} as const;
```

- [ ] **Step 4: Run the protocol tests and verify they pass.**

Run:

```bash
cd /home/free/src/opensac
deno test -A src/core/protocol_test.ts
```

Expected: PASS with no dependency on MCP or ACP protocol modules.

---

### Task 3: Implement Core paths, registration, and the single-instance lock

**Files:**
- Create: `src/core/paths.ts`
- Create: `src/core/registry.ts`
- Create: `src/core/lock.ts`
- Create: `src/core/registry_test.ts`
- Create: `src/core/lock_test.ts`

**Interfaces:**
- Produces `CorePaths.fromStateDir(stateDir: string): CorePaths`.
- Produces `CoreRegistry.read()`, `write(registration)`, `remove(id)`, and `isCurrent(registration)`.
- Produces `CoreLock.acquire(paths: CorePaths): Promise<CoreLockHandle>`.
- Produces `CoreLockHandle.release(): Promise<void>`.
- Produces `CoreRegistration` with `id`, `version`, `protocolVersion`, `pid`, `host`, `port`, and `startedAt`.

- [ ] **Step 1: Write failing isolated filesystem tests.**

Use a temporary directory per test, not `OPENSAC_DIR`. Assert:

```ts
const paths = CorePaths.fromStateDir(await Deno.makeTempDir());
assertEquals(paths.registrationFile.endsWith("core.json"), true);
assertEquals(paths.lockFile.endsWith("core.lock"), true);
```

Test that registration writes are atomic by writing a temporary sibling and then reading the complete JSON value, that `remove(id)` does not remove a newer registration, and that two lock acquisitions cannot both succeed. Release the first lock, then assert the second acquisition succeeds. Also test stale lock recovery only after the owner metadata is demonstrably stale.

- [ ] **Step 2: Run the lock/registry tests and verify they fail.**

Run:

```bash
cd /home/free/src/opensac
deno test -A src/core/registry_test.ts src/core/lock_test.ts
```

Expected: FAIL because the Core path, registry, and lock modules do not exist.

- [ ] **Step 3: Implement state paths and atomic registration.**

`CorePaths.fromStateDir()` must create neither files nor directories implicitly. The registry must:

1. create the state directory only when writing;
2. write `<registration>.tmp` or a unique temporary sibling;
3. rename the temporary file over `core.json`;
4. read and validate the registration shape;
5. remove only the registration whose `id` matches the caller.

The registration must never contain `passwords`.

- [ ] **Step 4: Implement an ownership-aware lock.**

Use `Deno.mkdir(lockDir, { mode: 0o700 })` as the atomic acquisition primitive. On `AlreadyExists`, read the lock metadata and return `CoreLockBusyError` unless a stale-owner check proves the old process is not alive and the registered Core is not healthy. Store an owner token, PID, hostname, and timestamp in `meta.json`; a normal release removes the lock directory only when the token matches. If liveness cannot be established, fail closed and do not delete the lock.

- [ ] **Step 5: Run the lock/registry tests and verify they pass.**

Run:

```bash
cd /home/free/src/opensac
deno test -A src/core/registry_test.ts src/core/lock_test.ts
```

Expected: PASS, including token mismatch protection and stale-lock refusal.

---

### Task 4: Build the Core HTTP JSON-RPC server and authentication boundary

**Files:**
- Create: `src/core/auth.ts`
- Create: `src/core/server.ts`
- Create: `src/core/server_test.ts`

**Interfaces:**
- Produces `CoreAuth.authenticate(request: Request, config: ResolvedCoreConfig): boolean`.
- Produces `CoreServerOptions` with `config`, `version`, and `protocolVersion`.
- Produces `CoreServer.start(): Promise<CoreServerHandle>`.
- Produces `CoreServerHandle.address`, `url`, and idempotent `stop()`.
- Produces JSON-RPC methods `core.health` and `core.info`.
- Core lock and registration lifecycle remain owned by Task 6, not by the HTTP server.

- [ ] **Step 1: Write failing server and authentication tests.**

Start a server on port `0` and assert:

```ts
const handle = await server.start();
const health = await fetch(new URL("/health", handle.url));
assertEquals(health.status, 200);
const body = await health.json();
assertEquals(body.healthy, true);
```

Test `POST /rpc` with a valid `core.health` request, an invalid JSON-RPC request, an unknown method, and an authentication failure. Assert:

- `auth: false` accepts a request without a password;
- `auth: true` rejects a missing password with HTTP 401;
- `auth: true` accepts any one password from the configured array;
- `auth: true` with `passwords: []` fails during `start()`;
- the response body is JSON-RPC and never includes the password list.

- [ ] **Step 2: Run the server tests and verify they fail.**

Run:

```bash
cd /home/free/src/opensac
deno test -A src/core/server_test.ts
```

Expected: FAIL because the Core server and auth module do not exist.

- [ ] **Step 3: Implement password extraction and validation.**

Read only the configured authentication header. Do not accept passwords from query parameters, JSON-RPC params, or the URL. Use constant-time comparison for configured password values where practical. Return false for missing/empty values and never log submitted passwords.

- [ ] **Step 4: Implement the HTTP server using Deno Web APIs.**

Use `Deno.serve` with the configured host and port. Expose:

- `GET /health` for unauthenticated liveness only, returning no password or private state;
- `POST /rpc` for JSON-RPC `core.health` and `core.info`;
- a 404 JSON-RPC error for unknown routes;
- a 401 response for protected RPC requests when `auth` is enabled.

`core.info` returns only protocol version, OpenSAC version, Core protocol version, and feature names. It must not return the registration path, PID, passwords, session paths, or provider configuration.

Use `onListen` to capture the actual selected port when `port: 0`, and expose an idempotent `stop()` that closes only the HTTP server. The command lifecycle in Task 6 owns registration removal and lock release.

- [ ] **Step 5: Run the server tests and verify they pass.**

Run:

```bash
cd /home/free/src/opensac
deno test -A src/core/server_test.ts
```

Expected: PASS on an ephemeral port with clean server shutdown.

---

### Task 5: Add Core discovery and a reusable Core Client

**Files:**
- Create: `src/core/client.ts`
- Create: `src/core/client_test.ts`

**Interfaces:**
- Produces `CoreClientOptions` with `stateDir`, `version`, `protocolVersion`, `config`, optional `launcher`, and bounded `startTimeoutMs`.
- Produces `CoreClient.discover(): Promise<CoreDiscoveryResult>`.
- Produces `CoreClient.call<T>(method: string, params?: unknown): Promise<T>`.
- Produces `CoreClient.health(): Promise<CoreHealth>`.
- Produces `CoreClient.close(): Promise<void>`.
- Produces `CoreLauncher` as `type CoreLauncher = () => Promise<void>` so tests do not depend on the development process layout.

- [ ] **Step 1: Write failing discovery/client tests.**

Use a temporary state directory and a live test server. Assert that a client discovers the registered server, calls `core.info`, receives a version/protocol mismatch error, and handles a dead registration without issuing a request to a reused PID.

For launcher tests, inject a function that records each launch call and resolves when the child has been spawned. Assert that `ensureStarted()` launches exactly once for concurrent callers and that the second caller reuses the first healthy Core.

- [ ] **Step 2: Run the client tests and verify they fail.**

Run:

```bash
cd /home/free/src/opensac
deno test -A src/core/client_test.ts
```

Expected: FAIL because the client and discovery modules do not exist.

- [ ] **Step 3: Implement discovery and health validation.**

Discovery must:

1. read and validate `core.json`;
2. request the registered URL with the configured authentication header;
3. verify `core.info` version and protocol version;
4. return a typed result for missing, stale, incompatible, or unauthenticated Core;
5. never trust a PID as proof of Core identity.

`CoreClient.call()` must send a single JSON-RPC request to `/rpc`, parse a single response envelope, reject response/request ID mismatches, and surface JSON-RPC errors as typed errors. Do not use JSON-RPC batching in this first client.

- [ ] **Step 4: Implement serialized auto-start.**

Coalesce concurrent `ensureStarted()` calls with one in-flight promise. The launcher must launch the current OpenSAC executable/script with the `core` command and must not pass passwords on the command line. After launch, poll discovery with a bounded retry budget. If startup fails, clear the in-flight promise and return the typed startup error.

- [ ] **Step 5: Run the client tests and verify they pass.**

Run:

```bash
cd /home/free/src/opensac
deno test -A src/core/client_test.ts
```

Expected: PASS, including concurrent ensure-started coalescing and version mismatch behavior.

---

### Task 6: Wire the `opensac core` command and service lifecycle tests

**Files:**
- Create: `src/cli/core.ts`
- Modify: `src/cli/command.ts:389-483`
- Modify: `src/cli/cli_test.ts:120-180`
- Test: `src/cli/core_test.ts`

**Interfaces:**
- Produces `CoreCommandOptions` with optional `config` and `stateDir` overrides for tests.
- Produces `CoreCommandHandle` with `url`, `stop(): Promise<void>`, and `done: Promise<number>`.
- Produces `startCoreCommand(options, deps): Promise<CoreCommandHandle>`.
- Produces `runCoreCommand(options, deps): Promise<number>` for the Cliffy action.
- Registers `opensac core` as a lifecycle command.
- Leaves existing `acp`, TUI, print, doctor, knowledge-MCP, stats, and speedtest entry behavior unchanged.

- [ ] **Step 1: Write failing command and lifecycle tests.**

Assert that `createRootCommand().getCommands()` includes `core`, while the existing removed-command assertion still excludes `serve` and `a2a`. Assert that `runCoreCommand` starts a Core on an ephemeral port, writes a registration, and returns only after the server stops.

Use a temporary `OPENSAC_DIR` only through the command dependency/state directory argument; do not mutate the environment at module scope.

- [ ] **Step 2: Run the command tests and verify they fail.**

Run:

```bash
cd /home/free/src/opensac
deno test -A src/cli/core_test.ts src/cli/cli_test.ts
```

Expected: FAIL because `runCoreCommand` and the `core` subcommand do not exist.

- [ ] **Step 3: Implement the Core command handler.**

`startCoreCommand()` must:

1. load settings or use the supplied config override;
2. resolve Core config;
3. create Core paths from the supplied state directory;
4. acquire the Core lock;
5. start the Core HTTP server;
6. write registration;
7. return a `CoreCommandHandle` whose `stop()` is idempotent;
8. resolve `done` only after the server stops and registration/lock cleanup completes.

`runCoreCommand()` must install SIGINT/SIGTERM handlers, call `startCoreCommand()`, await `handle.done`, and return the resulting exit code. The handler must acquire and release the lock and registration exactly once.

The command must fail clearly on `auth: true` with an empty password list and on a fixed-port conflict unrelated to a healthy registered Core.

- [ ] **Step 4: Register the command in the Cliffy tree.**

Add `createCoreCommand()` to `src/cli/command.ts` and register it as `core`. Keep the existing ACP command registered and keep `serve` and `a2a` absent. The command description must state that it starts the shared OpenSAC Core, not a UI-specific server.

- [ ] **Step 5: Run the command tests and verify they pass.**

Run:

```bash
cd /home/free/src/opensac
deno test -A src/cli/core_test.ts src/cli/cli_test.ts
```

Expected: PASS with `core` present and old command compatibility preserved.

---

### Task 7: Add an end-to-end Core foundation smoke test and update architecture documentation

**Files:**
- Create: `src/core/integration_test.ts`
- Modify: `AGENTS.md:5-14, 24-44, 86-106`

**Interfaces:**
- Exercises the complete `CoreLock → CoreServer → CoreRegistry → CoreClient` path.
- Documents that direct TUI/CLI/ACP migration is a later phase and must not be represented as complete by this foundation.

- [ ] **Step 1: Write the failing end-to-end test.**

Start a Core with `port: 0`, `auth: true`, and two passwords. Assert:

```ts
assertEquals((await client.health()).healthy, true);
assertEquals(await client.call("core.info"), expectedInfo);
```

Stop the server, assert the registration is removed, and assert a second client can start a new Core using a new temporary state directory. Add a second test that starts two clients concurrently and asserts one registration and one live server.

- [ ] **Step 2: Run the integration test and verify the full path is missing or fails.**

Run:

```bash
cd /home/free/src/opensac
deno test -A src/core/integration_test.ts
```

Expected: FAIL until all previous tasks are integrated.

- [ ] **Step 3: Update repository architecture guidance.**

Replace the old blanket prohibition on a Core/backend process with the narrower rule:

```text
TUI, CLI, ACP, and WebUI may not own Agent/Session/Run semantics.
opensac core is the only default shared runtime host.
Standalone may start an isolated private Core.
ACP remains a stdio bridge and is not a second Agent Core.
```

Add the new `src/core/` boundary to the architecture guard's allowlist only for protocol, transport, lifecycle, and configuration code. Do not allow `src/core/` to import Agent implementation modules until the runtime-host migration task is explicitly designed.

- [ ] **Step 4: Run focused verification.**

Run:

```bash
cd /home/free/src/opensac
deno test -A src/core/ src/cli/core_test.ts src/cli/cli_test.ts
deno check src/ sdk/ examples/ bootstrap.ts
deno lint
```

Expected: all focused tests pass, type checking passes, and lint reports no errors.

- [ ] **Step 5: Run architecture verification.**

Run:

```bash
cd /home/free/src/opensac
deno task test:architecture
```

Expected: PASS with the new Core boundary documented and no new direct Agent construction outside the allowed runtime-owner modules.

- [ ] **Step 6: Review the diff and do not commit.**

Inspect:

```bash
cd /home/free/src/opensac
git diff --stat
git diff -- src/core src/config src/cli AGENTS.md docs/proposal/opensac-core-runtime-design.md
```

Confirm the diff contains no generated artifacts, no password values, no HTTP/3 dependency, and no changes to `session_runtime_leases`. Leave changes uncommitted unless the user explicitly requests a commit.

## Follow-on Plans

After this foundation is reviewed and verified, create separate implementation plans for:

1. Core Runtime Host: move the existing ACP-owned `SessionRuntime`, provider, MCP, recovery, and shutdown bootstrap behind the Core JSON-RPC API.
2. ACP Bridge: keep `opensac acp` stdio wire compatibility while removing direct Agent/Runtime construction.
3. TUI/CLI migration: move print and interactive entry points to `CoreClient` while preserving Standalone behavior.
4. WebUI projection: add a browser client that consumes Core JSON-RPC HTTP/WebSocket/SSE and never reads local state directly.
5. Runtime lease/recovery integration: validate that the global Core, Standalone Core, and old process paths cannot produce duplicate Session owners.
