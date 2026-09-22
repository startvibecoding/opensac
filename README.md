# opensac

opensac is MothX ported to Deno + TypeScript. This repository is the Deno/TS
target of a 1:1 migration from the Go implementation at `/home/free/src/mothx`.

## Status

The migration is in progress. The dependency-ordered backlog and running status
ledger live in
[`docs/proposal/go-to-deno-migration.md`](docs/proposal/go-to-deno-migration.md).
`deno task check` type-checks `src/` and `sdk/` together.

Ported so far (all type-checked, linted, and tested):

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
| `internal/tools` | `src/tools` | tool Registry + standard tools (read/ls/write/edit/insert/plan/find/grep/bash/jobs/kill/question/skill_ref/a2a_dispatch/image_generation), file diff/atomic write, file locks, background jobs |
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
deno task build   # deno compile -> bin/opensac
```

Configuration lives in `deno.json` — tasks, formatter, linter, compiler options,
and the import map. There is no build step for development: Deno runs TypeScript
directly.

## Database

`src/db` owns the process-wide SQLite connection lifecycle and is the only
module that opens, configures, caches, or closes a connection. It uses the
`node:sqlite` driver built into Deno 2.9 (`DatabaseSync`), which exposes the
SQLite result codes needed for the busy/read-only classification. All SQL
construction and row mapping belongs to `src/dao` (not yet ported).

## Permissions

Deno programs are sandboxed. The compiled binary declares only the permissions
it needs rather than using `-A` in production; development tasks use `-A` for
convenience.

## Dependencies

Imports are pinned in `deno.lock`, which should be committed.
