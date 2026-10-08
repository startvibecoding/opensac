# opensac

opensac is MothX ported to Deno + TypeScript. This repository is the Deno/TS
target of a 1:1 migration from the Go implementation at `/home/free/src/mothx`.

## Status

The Go→Deno port is functionally complete for the shipping surface: `src/`
holds the agent core, runtime, providers, tools, sessions, TUI, CLI, ACP, and
Core host, and CI runs `check`, `lint`, `fmt --check`, `test`, and
`test:architecture` on every push and pull request. The dependency-ordered
backlog and migration ledger live in
[`docs/proposal/go-to-deno-migration.md`](docs/proposal/go-to-deno-migration.md).

Not yet in this repository: the planned `desktop/` Electron app, the `pypi/`
installer, a WebUI, and the bilingual `docs/en`/`docs/zh` trees. `AGENTS.md`
describes those as target architecture; treat them as planned rather than
existing code.

Local checks:

```bash
deno task check          # type-check src/, sdk/, examples/, scripts/
deno task lint           # deno lint
deno fmt --check         # formatting
deno task test           # full suite (includes src/architecture guards)
deno task test:architecture  # boundary guards alone
```

Ported packages (all type-checked, linted, and tested):

| Go package | TS target | Notes |
| --- | --- | --- |
| `internal/util` | `src/util` | UTF-8 truncation, symlink-aware path helpers |
| `internal/version` | `src/version` | build/VCS version resolution |
| `internal/ua` | `src/ua` | User-Agent strings |
| `internal/platform` | `src/platform` | OS/arch, dirs, shells, sandbox paths |
| `internal/systeminit` | `src/systeminit` | `/systeminit` prompt |
| `internal/db` | `src/db` | process-wide SQLite lifecycle over `node:sqlite` |
| `internal/sandbox` | `src/sandbox` | policy, git rules, manager, bwrap/seatbelt/windows backends |
| `internal/config` | `src/config` | settings.json/env.json/mcp.json/allow.json schemas, provider presets, sparse load/patch |
| `internal/imageproc` | `src/imageproc` | prepare/resize/crop, provider family inference; imagescript + @jsquash/webp codecs |
| `internal/skills` | `src/skills` | skill discovery (builtin/global/project), references, enable/disable toggles |
| `internal/contextfiles` | `src/contextfiles` | well-known context-file discovery (global/parent/project), `.opensac/rule.md` load/ensure, system-prompt assembly |
| `internal/expert` | `src/expert` | expert bundle format (manifest + persona frontmatter), layered builtin/global/project ExpertCenter, writable CRUD manager, embedded seed bundles |
| `internal/tools` | `src/tools` | tool Registry + standard tools (read/ls/write/edit/insert/plan/find/grep/bash/jobs/kill/question/skill_ref/image_generation), file diff/atomic write, file locks, background jobs |
| top-level `agent` (public SDK) | `sdk/agent` | public `Agent`/`Provider`/`Builder`/`ExternalTool` interfaces + types (must not import `src/`) |
| `bootstrap` | `src/bootstrap` | provider bridge wiring `Builder.withProviderByName` to `src/provider` (builder hook deferred to `src/agent`) |

TUI framework decision: the Go `bubbletea`/`lipgloss` TUI is replaced by **Ink
(`npm:ink@^5`) + React 18 (`npm:react@^18`)**. `src/tui` holds the toolchain smoke
test plus the scrollback/streaming skeleton (`markdown.ts` + `transcript.tsx`:
completed blocks go to the terminal's own scrollback via `<Static>`, so
selection/copy/wheel use the terminal natively; only the active streaming block
stays in the managed view). The full transcript/input/agent wiring lands after
`src/agent`/`src/agentruntime` are ported. See
[`docs/proposal/go-to-deno-migration.md`](docs/proposal/go-to-deno-migration.md).

The streaming-Markdown renderer `github.com/startvibecoding/GoStreamingMarkdown`
is ported to `src/tsm` (`node`/`parser`/`renderer`/`stream`); it is byte-for-byte
compatible with the Go library for well-formed Markdown (see the module for the
one deliberate code-point deviation).

## Requirements

Deno 2.9 or later (installed at `~/.deno/bin/deno`).

```sh
deno --version
deno upgrade   # if older than 2.9
```

## Usage

```sh
deno task check   # type check src/
deno task test    # deno test -A
deno task lint    # deno lint
deno task fmt     # deno fmt
deno task start   # run src/main.ts
deno task build:node  # esbuild -> dist/node (platform-independent npm package)
 deno task pack:node   # build + npm pack into dist/npm/
```

Configuration lives in `deno.json` — tasks, formatter, linter, compiler options,
and the import map. There is no build step for development: Deno runs TypeScript
directly.

## Releases

A `v*` git tag is the release. It is published as a **single,
platform-independent npm package** (plain JavaScript, no per-platform
binaries), bundled with [esbuild](https://esbuild.github.io/) and run on Node >= 22.5:

```sh
make node-build                    # esbuild -> dist/node
make node-pack                     # tarball into dist/npm/, publishing nothing
make node-publish NODE_SCOPE=@you  # publish @you/opensac under the latest tag
```

npmjs.org requires a scope: the bare name `opensac` is rejected by npm's
name-similarity guard (too close to `openai`), so `NODE_SCOPE=@<your-npm-username>`
is required and publishes `@<your-npm-username>/opensac` with public access.
GitHub Packages (`make node-publish-github NODE_SCOPE=@owner`) is scoped the same way.

The pushed tag produces a GitHub Release, the npm package, and the container
image. `ghcr-publish.yml` still ships `ghcr.io/<owner>/opensac` for the shared
Core host.

> The earlier per-platform `opensac-installer-*` packages, their platform
table (`scripts/platforms.ts`), and the `deno compile` binary pipeline have
been removed; the single npm package is the only release artifact.

### Container image

The image runs the shared Core host rather than the TUI, which has no terminal to
draw in, and exposes the Core HTTP API on port 27183:

```sh
docker run --rm -p 27183:27183 -v "$PWD:/workspace" -v opensac-state:/opensac \
  ghcr.io/startvibecoding/opensac:v0.1.0
```

`/workspace` is where the agent works; `/opensac` holds settings, sessions, and
credentials, so mount it as a volume to keep them. The image ships a
`settings.json` that binds the Core to `0.0.0.0`, because the default
`127.0.0.1` is unreachable from outside the container. There is no
authentication by default: set `core.auth` and a password in your own
`settings.json`, or terminate TLS in front of the port.

## Database

`src/db` owns the process-wide SQLite connection lifecycle and is the only
module that opens, configures, caches, or closes a connection. It uses the
`node:sqlite` driver built into Deno 2.9 (`DatabaseSync`), which exposes the
SQLite result codes needed for the busy/read-only classification. All SQL
construction and row mapping belongs to `src/dao` (not yet ported).

## Permissions

Deno programs are sandboxed. Development tasks use `-A` for convenience; the
published Node package runs on the Node runtime and needs no Deno permission
flags.

## Dependencies

The project targets the **Node runtime**: it depends on `node:` builtins, npm
packages, and the project-owned `src/compat/` shims that replaced JSR `@std/*`.
There are no `jsr:` imports; the CLI parser is the project-owned
`src/cli/command_parser.ts` and the package is bundled with esbuild. Imports are
pinned in `deno.lock`, which should be committed.
