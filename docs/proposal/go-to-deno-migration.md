# Go → Deno/TypeScript 1:1 migration

Source of truth: `/home/free/src/mothx` (Go, module
`github.com/startvibecoding/mothx`). Target: this repository
(`src/` mirroring the Go `internal/` + `cmd/` layout).

## Scope

The Go tree is **851 `.go` files / ~246,151 lines** across 38 `internal/`
packages plus `cmd/mothx`. A faithful 1:1 port is a large, multi-stage effort;
this document is the ordered backlog and the running status ledger.

## Translation conventions

| Go | Deno/TS |
| --- | --- |
| `package x` | `src/x/*.ts` modules |
| `XxxYyy` exported | `xxxYyy` exported function/const |
| `struct` | `interface` + plain objects, or `class` when it has methods/lifecycle |
| `error` return | `throw` typed `Error` (or `AggregateError`); `Promise` for async |
| `context.Context` | `AbortSignal` (threaded through cancellable paths) |
| `runtime.GOOS/GOARCH` | `Deno.build.os` / `Deno.build.arch` (mapped back to GOOS/GOARCH names) |
| `os.Getenv` | `Deno.env.get` |
| `path/filepath` | `@std/path` |
| `database/sql` + `uptrace/bun` | `node:sqlite` (`DatabaseSync`) behind `src/db`; DAO owns SQL |
| `modernc.org/sqlite` driver | `node:sqlite` (built into Deno 2.9) |
| `net/http` + `Deno.serve` | `Deno.serve` and standard web APIs |
| `encoding/json` | `JSON` |
| goroutines/channels | `Promise`/async + `Deno.Worker` when real parallelism is needed |
| `testing` | `Deno.test` + `@std/assert` |
| bubbletea/lipgloss TUI | Ink (`src/tui`) |
| Go struct tags `json:"..."` | camelCase/`snake_case` mapping helpers in each module |

## Package backlog (dependency order)

Status: ✅ ported · 🟡 partial · ⬜ not started.

| # | Go package | LOC | TS target | Status |
| --- | --- | --- | --- | --- |
| 1 | `internal/util` | 150 | `src/util` | ✅ |
| 2 | `internal/version` | 63 | `src/version` | ✅ |
| 3 | `internal/ua` | 114 | `src/ua` | ✅ |
| 4 | `internal/platform` | 1277 | `src/platform` | ✅ |
| 5 | `internal/systeminit` | 130 | `src/systeminit` | ✅ |
| 6 | `internal/db` | 2170 | `src/db` | ✅ |
| 7 | `internal/imageproc` | 984 | `src/imageproc` | ⬜ |
| 8 | `internal/sandbox` | 2255 | `src/sandbox` | 🟡 |
| 9 | `internal/config` | 5331 | `src/config` | ⬜ |
| 10 | `internal/skills` | 1490 | `src/skills` | ⬜ |
| 11 | `internal/contextfiles` | 486 | `src/contextfiles` | ⬜ |
| 12 | `internal/expert` | 2288 | `src/expert` | ⬜ |
| 13 | `internal/context` | 2803 | `src/context` | ⬜ |
| 14 | `internal/provider` | 17607 | `src/provider` | ⬜ |
| 15 | `internal/dao` | 3908 | `src/dao` | ⬜ |
| 16 | `internal/session` | 21334 | `src/session` | ⬜ |
| 17 | `internal/ai` | 173 | `src/ai` | ⬜ |
| 18 | `internal/tools` | 6173 | `src/tools` | ⬜ |
| 19 | `internal/agent` | 20402 | `src/agent` | ⬜ |
| 20 | `internal/mcp` | 3299 | `src/mcp` | ⬜ |
| 21 | `internal/workflow` | 3035 | `src/workflow` | ⬜ |
| 22 | `internal/browser` | 838 | `src/browser` | ⬜ |
| 23 | `internal/esm` | 3367 | `src/esm` | ⬜ |
| 24 | `internal/memory` | 829 | `src/memory` | ⬜ |
| 25 | `internal/cron` | 3158 | `src/cron` | ⬜ |
| 26 | `internal/agentruntime` | 21399 | `src/agentruntime` | ⬜ |
| 27 | `internal/messaging` | 4546 | `src/messaging` | ⬜ |
| 28 | `internal/skillhub` | 2788 | `src/skillhub` | ⬜ |
| 29 | `internal/a2a` | 2388 | `src/a2a` | ⬜ |
| 30 | `internal/stats` | 811 | `src/stats` | ⬜ |
| 31 | `internal/debugpprof` | 187 | `src/debugpprof` | ⬜ |
| 32 | `internal/doctor` | 572 | `src/doctor` | ⬜ |
| 33 | `internal/update` | 319 | `src/update` | ⬜ |
| 34 | `internal/architecture` | 900 | `src/architecture` | ⬜ |
| 35 | `internal/acp` | 20753 | `src/acp` | ⬜ |
| 36 | `internal/serve` | 46511 | `src/serve` | ⬜ |
| 37 | `internal/tui` | 33096 | `src/tui` | ⬜ |
| 38 | `cmd/mothx` | 5493 | `src/cli` + `src/main.ts` | ⬜ |

Public SDK surface (`sdk/`, `src/bootstrap/`, `examples/`) mirrors the Go
`bootstrap` + `example/` trees and must not import `src/`.

## Known hard parts (require design decisions)

- **`bun` ORM → DAO.** Go DAOs use `bun.IDB`, `bun.NewSelect/NewInsert`,
  `bun.BaseModel`, and `bun.In`. There is no TS equivalent; `src/dao` must be
  rewritten to build SQL strings over `src/db`'s `DB` handle. `src/architecture`
  guards must be re-implemented over an import graph.
- **Image codecs (`imageproc`).** Go uses `image/png|jpeg|gif` and
  `golang.org/x/image/webp`. Deno has no built-in codecs; pick a pure-TS codec
  (`npm:imagescript`) and document the WebP gap, or vendor a WASM codec.
- **TUI (`bubbletea`/`lipgloss` → Ink).** Not a mechanical port; event/render
  model differs. Keep canonical events from `src/agent` and re-render.
- **WebSocket / SSE / Feishu SDK.** `gorilla/websocket`, `oapi-sdk-go` map to
  `Deno.upgradeWebSocket`, manual SSE, and raw HTTP respectively.
- **`goja` (JS engine in `workflow`).** Replace with Deno's own V8 sandbox
  (`new Worker` + restricted imports) rather than embedding a JS engine.
- **Vendored assets.** `src/platform/busybox_assets/` and
  `src/context/tokenizerdata/` must be copied from the Go tree and embedded with
  `deno compile --include`.

## Validation

```sh
deno task fmt      # deno fmt
deno task lint     # deno lint
deno task check    # deno check src/
deno task test     # deno test -A
```

Each ported package ships its Go tests translated to `Deno.test`.
