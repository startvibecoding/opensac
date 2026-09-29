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
deno task build   # deno compile -> bin/opensac (version = newest v* git tag)
```

Configuration lives in `deno.json` — tasks, formatter, linter, compiler options,
and the import map. There is no build step for development: Deno runs TypeScript
directly.

## Releases

A `v*` git tag is the release. `.github/workflows/` turns one tag into the four
artifacts a user can install from, all built from that tag's commit and all
carrying the tag as their version:

| Workflow | Result |
| --- | --- |
| `release.yml` | GitHub Release with the six platform binaries, the npm tarballs, and `checksums.txt` |
| `npm-publish.yml` | `@<owner>/opensac-installer` on GitHub Packages, and `opensac-installer` on npmjs.org |
| `ghcr-publish.yml` | `ghcr.io/<owner>/opensac` images (`ubuntu`, `debian`, and `alpine` variants) for `linux/amd64` and `linux/arm64` |

The platform list is never written into a workflow: each one reads
`scripts/platforms.ts`, the single owner of the release platform table, so adding
a platform there is enough to have it built, published, and attached.

`make` is the same interface locally, including the container image:

```sh
make build-all                     # every published platform into bin/
make npm-packages                  # generate the npmjs package tree
make npm-packages-github NPM_SCOPE=@owner   # the scoped GitHub Packages tree
make npm-pack                      # tarballs into dist/npm/, publishing nothing
make docker-build                  # build the image locally
```

GitHub Packages authenticates with the workflow's own `GITHUB_TOKEN`, so it needs
no configuration. Publishing to npmjs.org is opt-in: set the `PUBLISH_NPMJS`
repository variable to `true` and add an `NPM_TOKEN` secret.

### Container image

The image runs the shared Core host rather than the TUI, which has no terminal to
draw in, and exposes the Core HTTP API on port 4096:

```sh
docker run --rm -p 4096:4096 -v "$PWD:/workspace" -v opensac-state:/opensac \
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

Deno programs are sandboxed. The compiled binary declares only the permissions
it needs rather than using `-A` in production; development tasks use `-A` for
convenience.

## Dependencies

Imports are pinned in `deno.lock`, which should be committed.
