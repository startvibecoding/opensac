# opensac

MothX ported to Deno + TypeScript. This repository is the Deno/TS target of a
1:1 migration from the Go implementation at `/home/free/src/mothx`.

## Status

The migration is in progress. The dependency-ordered backlog and running status
ledger live in
[`docs/proposal/go-to-deno-migration.md`](docs/proposal/go-to-deno-migration.md).

Ported so far (all type-checked, linted, and tested):

| Go package | TS target | Notes |
| --- | --- | --- |
| `internal/util` | `src/util` | UTF-8 truncation, symlink-aware path helpers |
| `internal/version` | `src/version` | build/VCS version resolution |
| `internal/ua` | `src/ua` | User-Agent strings |
| `internal/platform` | `src/platform` | OS/arch, dirs, shells, sandbox paths |
| `internal/systeminit` | `src/systeminit` | `/systeminit` prompt |
| `internal/db` | `src/db` | process-wide SQLite lifecycle over `node:sqlite` |
| `internal/sandbox` | `src/sandbox` | policy, git rules, manager (bwrap/seatbelt/windows pending) |

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
deno task build   # deno compile -> bin/mothx
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
