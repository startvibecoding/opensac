# Go 残留惯用法清理与 Deno/TS 惯用化方案

> Abstract (EN): This proposal reviews the 1:1 Go → Deno/TypeScript port and
> catalogs idioms that were elegant in Go but are unidiomatic or costly in
> Deno/TS: comma-ok tuples, sentinel `Err*` errors and `errors.Is` emulation,
> pointer/value-semantics residue (`BoolPtr`, no-op clone helpers),
> `context.Context` value bags, `new*` constructor naming, hand-rolled
> defer/chan/mutex plumbing, untyped `JSON.parse(...) as` decoding, Go wording
> leaks ("nil"), and the synchronous `node:sqlite` event-loop blocking risk.
> It proposes a phased, incremental cleanup roadmap that respects the
> anti-fragmentation invariants in `AGENTS.md` and keeps the public `sdk/`
> surface stable.

- 状态: 主体完成（P0–P4 + P1-3 + §3.4-1/§3.4-2 + comma-ok/value+error 扫尾 + P2-1 ACP teardown + P3 治理余项 + provider SSE 解码 guard 已落地，2026-09-24 收尾轮）；唯一接受残差见 §4 末「余项汇总（2026-09-24）」：自有持久化 JSON 列（自写自读）
- 范围: `src/`、`sdk/`（不含 `desktop/`、生成物）
- 前置文档: `docs/proposal/go-to-typescript-migration.md`（迁移台账）、`AGENTS.md`（架构不变量）

> 范围变更记录（2026-09-22）: serve/API、WebUI、WeChat/Feishu channel、A2A
> 入口已从产品中移除（`src/serve/`、`src/messaging/`、`src/a2a/`、
> `src/cli/a2a.ts`、`src/acp/manage_serve.ts`、`src/tools/a2a_dispatch.ts` 已删除）。
> 现存入口只有 **TUI、CLI、ACP**；本文所有目标、度量和验收均已按精简后的
> 树重新校准，且不允许以任何形式重新引入被移除的适配器。

---

## 1. 背景与目标

项目由 Go（约 851 个 `.go` 文件 / 24.6 万行）1:1 迁移为 Deno 2.9 + TypeScript 6
（当前 `src/` + `sdk/` 共 852 个 `.ts` 文件 / 约 27 万行）。1:1 端口的价值是行为
保真、可对照审计，但代价是大量 Go 惯用法被原样带进了 TS 世界：

- 在 Go 里**优雅**（惯用、被社区认可）的写法，在 TS/Deno 里是**外来语**：
  读者需要脑内维护两套语言模型，新人和 AI 协作者的上下文成本持续存在；
- 有些 Go 语义在 JS 运行时里**不再成立**（值语义克隆、`int64`、RE2 正则、
  goroutine 并发），保留它们不是风格问题，而是潜在的行为/性能缺陷；
- 有些 Go 设施在 Deno 里已有**标准答案**（`using`/`Symbol.dispose`、`Error` 的
  `cause`、`@std/async`、`AsyncIterable`、Web Streams），手写仿制品是纯负债。

目标: 在**不改变行为、不破坏 `AGENTS.md` 架构不变量、不改动 `sdk/` 公开 API
形状**的前提下，把"Go 直译层"渐进收敛为惯用 Deno/TS，降低维护成本，并消除
迁移残留中真正有害的部分（阻塞、正则回溯、无校验解码、错误吞没）。

非目标:

- 不做全量重写或模块重组（目录布局 `src/<pkg>/mod.ts` 本身就是 Deno 惯用的）；
- 不追求"去 class 化"或引入新框架/新依赖（校验库等见 §4.8 的可选项）；
- 不改变 `settings.json` 字段语义、数据库 schema、ACP 协议（serve 已移除，见范围变更记录）；
- 不为风格而风格——见 §5"有意保留的映射"。

---

## 2. 评审方法与量化结果

对 `src/`、`sdk/` 全量扫描（排除 `_test`），主要信号（2026-09-23 复查校准）:

| 信号 | 数量 | 说明 |
| --- | --- | --- |
| `export function newXxx(...)` | 0 ✅（§3.4-1 已清零，2026-09-23） | Go `NewXxx` 构造器命名；已全部改为 `createXxx` |
| `newXxxWithYyy(...)` 变体 | 0 ✅（Go 式命名已清零；`createXWithYyy` 语义变体见 §3.4-2） | Go functional-options / 多构造器模式；双入口合并为 §3.4-2 余项 |
| PascalCase 导出（函数+枚举式常量） | 0 ✅（P4 已清零，2026-09-23 实测） | Go 导出大写惯例残留；188 个常量已批改 SCREAMING_SNAKE（`Err*` 哨兵另计） |
| `export const ErrXxx` 哨兵 | 0 ✅（P1-3 已清零，2026-09-23） | Go `errors.New` 哨兵 + `errors.Is` 身份比较；P1 类化 17 个，P1-3 移除 `ErrNoRows` 后归零 |
| `): [a, b]` 多返回值（含 comma-ok、value+error） | 17（2026-09-24 实测；comma-ok 与 value+error 均已清零，余为坐标/语义多值保留项） | Go 多返回值 / `, ok` 惯用法；四批累计清零 ~55 处，见余项汇总 |
| `BoolPtr` / `clone*Ptr` no-op helper | 0 ✅（P0 已清零） | Go 指针/值语义残留；`cloneString*` 防共享 helper 按 §5 保留 |
| `| null` vs `| undefined` | 807 vs 990 | 两套"空"语义混用 |
| `JSON.parse(...) as T` 无校验解码 | 33（2026-09-24 实测；外部输入边界与 provider SSE 已全部 guard，余为自有持久化 JSON 列） | Go `json.Unmarshal` 直译，类型靠断言 |
| `finally {` | 88（2026-09-24 实测，非测试代码） | Go `defer` 的手写展开；13 处 `Symbol.dispose` 已落地，热点 teardown 已分层重构 ✅（P2-1） |
| 自定义 `close(): void` 句柄 | 13 | Go `io.Closer`，可用 `Symbol.dispose` |
| `export class` vs `export function` | 227 vs 1659 | class 多为"带方法的 struct"直译 |
| `// Ported from ...go` / `Deviation:` 注释 | 溯源行已清零（539→0），余 `Deviation:` 行为说明 | 指向 Go 源树的注释，P4-c 已清扫 |
| snake_case 文件名 | 421 | Go 文件命名习惯 |
| `*_test.ts` | 239 | **这是 Deno 惯例，保留**（见 §5） |
| "nil" 出现在错误消息/调试输出 | 1（仅注释残留） | Go 词汇泄漏到用户可见文本，P0 已清零 |

---

## 3. 问题清单: 在 Go 里优雅、在 Deno/TS 里不优雅的地方

> 本节各条“现状”为 2026-09-22 评审快照；已落地项与真实余项以 §4 各阶段勾选及末尾“余项汇总”为准。

### 3.1 哨兵错误 + `errors.Is` 身份比较（Go `errors.New` 惯用法）

**现状**: 29 个 `export const ErrXxx: Error = new Error(...)` 单例（如
`src/session/delivery_store.ts:18`、`src/session/runtime_submission.ts:11`），
调用方用 `err === ErrXxx` / `isNoRows(err)` 做身份比较（`src/dao/database.ts:12`
的 `ErrNoRows`，消息逐字复制 Go 的 `"sql: no rows in result set"`）。
另有 286 个 `export class ... extends Error`，多数带 `override name = "..."`
样板（如 `src/session/runtime_lock.ts:47-78` 连续 8 个空类）。

**为什么不优雅**:
- TS/JS 的惯用错误契约是 **class + `instanceof`（或判别字段）+ `Error.cause`**；
  身份比较的单例错误没有栈、不能携带上下文、跨打包/热加载后 `===` 会失效，
  逼出 `isNoRows`/`errIsXxx` 这类 helper（全库已有 20+ 个 `isXxxError`）。
- 变体错误用**消息字符串拼接**表达（`src/session/runtime_submission.ts:43-44`
  `${ErrRuntimeSubmissionConflict.message}: existing Run ...`）是 `%w` 包装的
  直译；TS 有原生 `new Error(msg, { cause })`。

**建议**:
1. 每类错误一个 class，带稳定的 `name`（或 `code` 字段）和 `cause`；空类体
   收敛为一个 `export class XxxError extends OpError {}` 简写或工厂生成。
2. 哨兵 `ErrXxx` 逐步替换为 `throw new XxxError(...)`；确需哨兵语义的场景用
   类本身（`err instanceof XxxError`）表达。
3. 上下文拼接改为 `new Error("run already exists", { cause: err, ...fields })`；
   统一 `isAbortError`/`isTimeoutError` 到一处（现存 3 组各自实现:
   `src/db/db.ts:359`、`src/provider/retry.ts:20`、`src/agentruntime/error_info.ts:400/406`、
   `src/acp/server.ts:6998/7003`——同一个 7000 行模块内又实现了一遍）。
4. `ErrNoRows` 惯例改为 DAO 返回 `T | undefined`（可选长期项，见 §4 风险与缓解）。

### 3.2 comma-ok 返回值与元组返回（Go `, ok` / 多返回值）

**现状**:
- `{ entry: T | null; ok: boolean }`、`{ db: Database | null; ok: boolean }`
  （`src/session/root_db.ts:74`、`src/session/session_events.ts:123`、
  `src/session/manager.ts:1353`、`src/tools/bash.ts:523`、`src/tools/tool.ts:97` …）；
- 具名元组 `): [release: () => void, ok: boolean]`
  （`src/session/runtime_lock.ts:1052/1064/1116`）；
- 反例中也有好样板: `src/contextfiles/contextfiles.ts:157` 返回判别式联合
  `{ ok: true; path: string } | { ok: false; path: string }`。

**为什么不优雅**: TS 有更精确的表达——可选返回（`T | undefined`）、判别式联合、
或直接 `throw`。`{ x | null, ok }` 把"值"和"是否存在"拆成两个需要人工保持一致
的槽位（`{ value: "", ok: false }` 这种占位值就是坏味道），而且 `ok: false` 时
`x` 的类型仍是 `T | null`，调用方要二次收窄。

**建议**（按场景选型，写进代码规范）:
- "查不到就算了" → 返回 `T | undefined`；
- "查不到是业务分支" → 判别式联合 `{ ok: true; value: T } | { ok: false; reason: ... }`；
- "查不到是错误" → `throw` typed error（配合 §3.1）；
- 元组 `[release, ok]` → 返回 `{ release(): void }` guard 对象或判别式联合。

### 3.3 指针/值语义残留（Go 三态字段、值拷贝）

**现状**: `src/config/settings.ts:279-320` 的 "Clone helpers" 段:
`BoolPtr(v)`（返回值原样！）、`cloneBoolPtr`、`cloneFloat64Ptr`（对原始类型
`x === undefined ? undefined : x` —— **no-op**）、`cloneStringSlice`/`cloneStringMap`
（Go 传值防共享的直译）。`| null` 与 `| undefined` 各约 1200 处混用。

**为什么不优雅**: JS 原始类型本来就是值复制，"拷贝指针指向的值"这个概念不存在；
no-op helper 只制造阅读噪音和假安全感。`null`/`undefined` 混用则把 Go 的"nil
多值语义"带进了 TS，而 TS 社区约定是**内部域用 `undefined` + 可选属性，wire/DB
边界才显式 `null`**（SQLite、JSON 序列化需要区分"缺省"和"置空"的场景保留 `null`）。

**建议**:
1. 删除 `BoolPtr`/`cloneBoolPtr`/`cloneFloat64Ptr`（先替换调用点）；
   `cloneStringSlice`/`cloneStringMap` 仅在确有"防调用方改内部状态"语义处保留，
   并改用 `ReadonlyArray`/`Readonly<Record<...>>` + `Object.freeze` 表达意图。
2. 三态字段（"未设置 / 显式置空 / 有值"）确有需要的（settings patch）保留
   `?: T | null`，并在类型注释里写明语义；其余统一 `?: T`。
3. `normalizeSamplingPtr` 这类"0 视为未设置"的 Go 语义，改为显式
   `temperature?: number` + 序列化时 `!== undefined` 判断，并在注释记录
   行为兼容要求。

### 3.4 构造函数与导出命名的 Go 拼写

**现状**: `export function newXxx` 132 处（`newManager`、`newStream`、
`newNode`、`newRenderer` …）+ 35 处 `newXxxWithOptions/newXxxWithYyy` 变体
（其中 29 处与同名基础构造器构成双入口）；
残留 Go 导出大小写: `NewBashToolWithJM`（`src/tools/bash.ts:593`）、
`IsMaintenanceCronJobID`（`src/agentruntime/maintenance_cron.ts:82`）、
`BoolPtr`、常量 `ProjectDirName`/`TypeAgent`/`RoleLead` 等 PascalCase 常量
（`src/config/paths.ts:6`、`src/expert/expert.ts:7-16`）。

**为什么不优雅**: TS 惯例是 class 直接 `new`，工厂叫 `createXxx`/名词性
（`acquireRuntimeLeaseGuard` 这类动词工厂就很好）；导出函数 lowerCamelCase、
常量 SCREAMING_SNAKE（或 lowerCamel，但要一致）；`newXxx`+`newXxxWithOptions`
双入口应合并为**一个带默认值的 options 对象**。

**建议**:
1. 纯重命名（`newXxx` → `createXxx` 或 class 构造器）是机械改动，可按目录
   分批做；**`sdk/` 公开面不动**。
2. `newXxx` / `newXxxWithOptions` 合并为 `createXxx(options: XxxOptions = {})`；
   校验/默认值在函数内完成。优先收敛 sandbox（4 个双入口）、skills、tsm。
3. `NewBashToolWithJM`、`IsMaintenanceCronJobID`、`BoolPtr` 及 PascalCase 常量
   统一改名（附带 grep 确认无协议/持久化字符串依赖——`TypeAgent` 等是持久化
   字面量的话只改绑定名不改值）。

### 3.5 `context.Context` 值袋直译（`RunContext.values` / `ToolContext.values`）

**现状**: `src/agent/run_context.ts` 把 Go 的 `context.WithValue` 值袋逐字移植:
`values: Map<symbol, unknown>` + `contextKey<T>()` + `contextWithValue()` +
`contextValue<T>()`（以 `as T | undefined` 强制收窄）；`src/tools/tool.ts:61-78`
的 `ToolContext.values` 同构，注释直言"Go threads value bag through
context.Context"。

**为什么不优雅**:
- 这是**连 Go 官方都反对**的模式（"Do not store context values to pass optional
  parameters"），1:1 端口把 Go 里的反模式也保真了过来；
- `Map<symbol, unknown>` 丢失类型关系，取出即 `as T`，是全库少有的无保护断言
  热点；symbol 键无文档、无枚举、无结构，运行时才能发现缺失。

**建议**:
1. 把真实在用的槽位（agent id、event sink、parent run、iteration budget、
   questionAsker、operationId）**摊平为显式类型字段**:
   `interface RunContext { signal?: AbortSignal; agentId?: AgentID; budget?: IterationBudget; ... }`。
   迁移期可保留 `values` 作为桥，逐槽位搬走后删除（AGENTS.md 的"迁移桥需有
   拆除条件"）。
2. 若确实需要跨深层调用的隐式上下文（避免层层传参），Deno/TS 的对应物是
   `AsyncLocalStorage`（node:async_hooks），而不是 symbol 值袋——仅在摊平
   不可行的路径使用。

### 3.6 `defer`、`chan`、`sync.Mutex` 的手写仿制

**现状**:
- **defer**: 大函数用可变局部变量 + 闭包 teardown 模拟 Go 的 `defer` LIFO
  （此类结构原集中在 `src/serve/openaiapi/handler_chat.ts` 等，serve 移除时已随
  之消失；现存热点是 `src/acp/server.ts` 的 Run 生命周期编排与
  `src/agentruntime/execution.ts`、`src/agentruntime/session_lifecycle.ts`，后者
  注释仍写着 "Go's `defer guard.Release()` maps to `try/finally`"）；全库 83 个
  `finally {`，0 处使用 TS 的 `using`/`Symbol.dispose`。
- **chan**: `src/agent/event_channel.ts` 手写 waiters/缓冲队列模拟
  `chan Event`（注释已记录偏差: Go 容量 100 → 这里无界）。
- **sync.Mutex**: `src/session/lock_registry.ts` 的 `CountedMutex`（异步队列
  互斥量）、`src/tools/file_lock.ts`（Go 的 `mu sync.Mutex` 直译成公开字段的
  案例原在 serve 层的 `sess!.mu`，已随 serve 移除，同类写法不得回流）。
- **errgroup**: `src/agent/parallel.ts` 手写 `boundedParallel`。

**为什么不优雅**:
- TS 6/Deno 2.9 原生支持显式资源管理（`using x = ...` + `[Symbol.dispose]`），
  它就是 `defer` 的标准答案；手写闭包 teardown 容易漏序、漏幂等
  （现在靠 `tornDown` 标志手工保证）。
- 单线程事件循环下，多数互斥量保护的"临界区"根本不需要互斥（注释自己也承认
  `sync.RWMutex` is dropped）；`CountedMutex` 只应在**跨 await 让出**的会合点
  真正需要串行化时存在。`mu` 这种名字还泄漏到跨模块 API。
- 无界 `EventChannel` 偏离了 Go 的背压语义（注释已声明），是有意取舍，但应
  用有界队列或显式丢弃策略把契约写死，而不是依赖"消费者总会醒来"。

**建议**:
1. 为 13 个 `close(): void` 句柄补 `[Symbol.dispose]`/`[Symbol.asyncDispose]`
   （可与 `close()` 共存），热点路径（`src/acp/server.ts` Run 生命周期、
   `src/agentruntime/execution.ts`、`session_lifecycle.ts`）的 teardown 重构为
   `try { ... } finally` 分层或 `using` 组合，删除"Go defer LIFO"式注释，
   改为命名清晰的释放函数。
2. `boundedParallel` 改用 `@std/async` 的 `pooledMap`（项目已依赖 `@std/async`），
   或保留但注明语义差异（保序、全量 drain）并作为唯一并发原语导出。
3. `EventChannel` 保留（AsyncIterable 是对的），但补上有界缓冲/溢出策略的
   显式决策与测试；`sess!.mu` 收敛为私有字段 + 命名清晰的 `lock()/unlock()`
   guard 或直接移除（单线程 + 事务串行化下可能根本不需要）。
4. `CountedMutex` 逐调用点审计: 纯同步临界区直接删锁；仅保留真正跨 await 的
   会合点（如 DB 事务 + IO 混合段）。

### 3.7 同步 DAO 层阻塞事件循环（Go `database/sql` 惯用法的性能陷阱）

**现状**: `src/db`/`src/dao` 基于 `node:sqlite` 的 `DatabaseSync`，所有查询
同步执行（`src/session/manager.ts:9` 注释:"the synchronous DAO layer in this
port"）。Go 里同步 DB API 跑在各自 goroutine 中是完全惯用的；Deno 单线程事件
循环里，一条慢查询/大结果集扫描会**同时阻塞流式输出、心跳续租、其他会话**。

**为什么不优雅**: 这是"Go 优雅、TS 有害"的典型——不是写法问题而是运行时模型
差异。AGENTS.md 的长任务可靠性要求（心跳持续续租、流式不中断）与同步全表扫描
天然冲突。

**建议**（不改 DAO 边界，AGENTS.md 的 DB→DAO→业务方向不变）:
1. 先度量: 给 DAO 慢查询加统一的耗时统计/告警（`src/db` 已有 busy 统计可挂），
   找出 >50ms 的查询。
2. 治理手段按优先级: 结果集分页/分片（循环内每 N 行 `await` 让出一次）、
   限制全表扫描入口、把 compaction/统计类离线扫描挪到 `Deno.Worker`
   （AGENTS.md 明确允许 Worker）。
3. 长期项: `src/db` 内部为扫描型 API 提供 `AsyncIterable` 分片读取契约，
   让 DAO 的调用方自然流式化——仍由 `src/db` 拥有连接，不违反数据库边界。
4. **不要**为此引入第二个 DB 栈或把 DAO 改 async 全量重写（收益不抵风险）。

### 3.8 无校验的 JSON 解码（Go `json.Unmarshal` 直译）

**现状**: 50 处 `JSON.parse(...) as T`；`src/dao` 行映射直接取 `row.xxx`
（`Record<string, unknown>`）由各 DAO 手工断言；wire/配置解析多处
`as Settings`/`as XxxPayload`。

**为什么不优雅**: Go 的 `json.Unmarshal` 至少会按 struct 类型做形状检查并返回
error；`as` 断言**什么都不检查**，坏数据会一路潜伏到运行期。TS 完全可以廉价
获得形状校验。

**建议**:
1. 引入一个统一的手写 guard/decode 模块（如 `src/util/decode.ts`:
   `decodeXxx(v: unknown): Xxx` 抛 `DecodeError`），优先覆盖**外部输入边界**:
   HTTP body、channel 消息、MCP payload、`settings.json`、`*.json` 持久化列。
2. 是否引入校验库（zod/valibot 等）单独评估: 项目零运行时依赖倾向 +
   `deno compile` 体积是加分项；边界面大时库的收益才超过成本。允许新增依赖
   需显式批准。
3. DAO 行映射保持 `src/dao` 内聚，但把"列 → record"的断言集中为每表一个
   `mapRow`（目前 0 处），让列名变化只改一处。

### 3.9 时间、单位与整数精度残留

**现状**: 手写 Go 时间格式 `formatRFC3339Nano`（`src/stats/stats.ts:223`）、
`nowRFC3339Nano`（`src/dao/bindings.ts:279`）拼 `.999…` 纳秒尾巴；时间单位
Go 式混用（`runtimeLeaseTTL = 15; // seconds` 与 `runtimeHeartbeatEveryMs`
同文件并存，`src/session/runtime_lock.ts:27-28`）；`src/db/busy.ts:45-79` 在
ms 与 ns 之间来回换算（`elapsedMs * 1_000_000`）。

**为什么不优雅**: `Date.prototype.toISOString()` 就是 RFC3339(UTC)；纳秒尾巴
可用 `crypto.randomUUID()`/单调计数器解决排序需求而不是伪造精度。JS number
对 ns 时间戳会**丢精度**（`Date.now() * 1e6` 超过 2^53），现有字符串时间戳
存储恰好规避了它——但 `busy.ts` 的 ns 计数器值得复查。

**建议**:
1. 时间戳统一 `toISOString()`（持久化格式保持兼容，RFC3339 字符串可词法排序
   这点继续利用）；需要稳定排序/唯一性的列用既有 `generateID`，不造纳秒。
2. 常量命名强制单位后缀（`_MS`/`_S`），消除注释单位（`runtimeLeaseTTL` →
   `runtimeLeaseTTLSecs` 或换算成 ms 常量）；删掉 ms↔ns 换算，内部统一 ms。
3. 全库审计 JS number 承载 Go `int64` 的点（usage tokens、seq、epoch）——
   当前 `SessionRunEventRecord.seq: number` 等需确认上界安全，超界用
   `bigint` 或字符串。

### 3.10 Go 词汇与调试输出泄漏

**现状**: 用户/日志可见文本里的 Go 词: `"database handle is nil"`（15+ 处）、
`"expert: nil fs.FS"`（`src/expert/bundle.ts:41`）、`formatUsage` 返回 `"nil"`
（`src/provider/types.ts:315`）、`"<nil>"`（`src/provider/debug.ts:121`）、
`"sql: no rows in result set"`。测试钩子直译: `resetForTest`/`listenAddrForTest`
等导出（原 `src/debugpprof/pprof.ts`，已随 P3-3 改名为 `src/debugendpoints/`）。

**建议**: 错误消息改写为 TS 语境（`"... is null"` 或描述性文案如
"no active database connection"`）；`fs.FS` 等 Go 类型名从消息中移除。
`ForTest` 钩子收敛为测试专用导出路径或注入点，避免污染公共面。

### 3.11 "Ported from / Deviation" 注释债与 Go 指纹

**现状**: 630 处 `// Ported from internal/x/y.go` / `Deviation: Go's … maps to …`
注释。它们在迁移期是审计资产，迁移完成后变成**指向已不存在代码库**的噪音，
并让读者误以为 Go 源仍是 source of truth。

**建议**: 迁移收尾后做一次"注释去 Go 化"清理: 每文件保留**为什么**（语义决策、
兼容约束、偏差原因），删掉**从哪来**（Go 文件路径、Go API 名对照）。Go→TS 对照
知识集中保留在 `docs/proposal/go-to-typescript-migration.md` 一处。判据: 注释解释
当前代码的意图 → 保留；注释解释两个代码库的差异 → 收编或删除。

### 3.12 文件命名 snake_case（Go 风格）——低优先级

**现状**: 556 个 snake_case 文件（`session_runtime.ts`、`provider_defaults.ts`）。
Deno std 两种都有，但 TS 生态主流是 camelCase/kebab-case。

**建议**: **默认不改**（纯 churn，git blame 受损，收益极低）。若决定统一，
放到最后阶段按目录批量 `git mv` + 一次 import 修正，并在本文件记录决定。
命名一致性真正要做的是 §3.4 的**导出**命名，不是文件名。

---

## 4. 实施路线图

原则: 每一步都是独立可合入的小改动（AGENTS.md: "Disciplined, minimal change"），
带确定性测试；`deno task test:architecture` 在触碰构造/持久化/解析路径时必须过；
`deno lint`/`deno fmt`/`deno check` 保持干净。所有阶段都不改 `sdk/` 公开签名、
不改 schema、不改 `settings.json`/`serve.json` 语义。

### P0 — 纯卫生（低风险、机械替换）✅ 已完成（2026-09-22）
1. ✅ 删 no-op 指针克隆 helper（§3.3）: `BoolPtr`/`cloneBoolPtr`/`cloneFloat64Ptr`
   （`settings.ts` 与 `openai/wire.ts` 两套）及 `cloneRawMessage` 已删除并内联调用点；
   `tui/dialogs.ts` 私有 `#cycleBoolPtr`/`#readBoolPtr` → `#cycleOptionalBool`/`#readOptionalBool`；
2. ✅ "nil" Go 词清零（§3.10）: 错误消息改为 TS 语境（"… is not open"/"… is required"），
   `formatUsage` → `"none"`，debug/ACP 标量渲染 `"<nil>"` → `"null"`（`goSprint` → `renderScalar`）；
3. ✅ 命名残留（§3.4-3）: 16 个 PascalCase 导出函数改 lowerCamel（`newBashToolWithJobManager`、
   `isMaintenanceCronJobID`、`fallbackTitle`/`normalizeTitle`、`installSkill`、
   `knowledgeLibrarianSessionIDForBase` 等）；14 个 "Go 导出别名"（`CreateKnowledgeBase =
   createKnowledgeBase` 式）删除并统一到 lowerCamel 目标名；`ProjectDirName`、
   `DefaultToolExecutionMaxConcurrency`、`DefaultSkillHubOfficialHandle`、`DecisionSourceTUI`、
   expert 的 `Type*/Role*/Source*`、`SchemaVersion`（→ `expertSchemaVersion`）改名；
4. ✅ 单位清理（§3.9-2）: `runtimeLeaseTTL` → `runtimeLeaseTTLSecs`，`db/busy.ts` 计数器
   去掉 ms↔ns 换算，内部统一 ms。

验证: `deno task test` 1846 passed、`deno task test:architecture` 8 passed、
`deno check`/`deno lint`/`deno fmt` 干净。

P0 发现的后续项（归入 P1/P4）:
- 仍有 223 个 PascalCase 导出，主体是枚举式常量词汇（`Mode*`/`Event*`/`RunState*`/
  `Thinking*`/`Failure*`/`Phase*`/`SessionExecution*`/`ConfigOption*` 等）与 `Err*` 哨兵。
  P1 先处理 `Err*`（改为 error class）；常量词汇需先定一个约定（命名空间 `as const` 对象 /
  SCREAMING_SNAKE / lowerCamel），再一次性批改，禁止混用。
- `session/manager.ts` 的 `CurrentVersion` 与 `store.ts` 的 `currentVersion` 概念疑似重复，
  改名前先确认语义归属（可能合并）。
- `knowledge_librarian.ts` 原有两个同名导出（Go 名与 lowerCamel 包装）已合并为
  `knowledgeLibrarianSessionID` + `knowledgeLibrarianSessionIDForBase`；
  `manage_knowledge_bases.ts` 的本地包装函数同理收敛为 `handleKnowledgeBaseCronJob`。
- 验证: `deno task lint && deno task check && deno task test`（相关模块聚焦测试）。

### P1 — 错误模型与返回值形状 ✅ 已完成（2026-09-23，含 P1-3）
1. ✅ 统一错误分类（§3.1-3）: 新建 `src/util/errors.ts` 唯一实现
   `isAbortError`/`isTimeoutError`（按 name 严格判定）与 `isAbortLike`/`isTimeoutLike`
   （retry 用宽判定，含 message/cause 链），替换 `db/db.ts`、`provider/retry.ts`、
   `agentruntime/error_info.ts`、`acp/server.ts` 四份自留副本；
2. ✅ 哨兵 → typed error class（§3.1）: 17 个 `ErrXxx` 全部类化（`instanceof` 替代
   身份比较，消息保持不变），含 `esm/store` 4 个、`esm/runtime_core` 3 个、
   `session/delivery_store` 3 个、`runtime_submission` 2 个、knowledge 2 个、
   `idempotency` 2 个、`JobAlreadyRunningError`、`EmptyTitleError`、
   `KnowledgeBaseServiceMissingError`；`expertSwitchRequiresForkMessage` 是字符串
   常量，仅改名；`RuntimeSubmissionError.unwrap()`（Go `Unwrap` 直译）删除，
   改用原生 `Error.cause`；测试断言从身份比较改为 `instanceof`；
3. ✅ comma-ok 清理（§3.2，`src/session` + `src/tools`）: `openExistingSessionDB(+ReadOnly)`
   → `Database | null`、`loadSessionCapabilities` → `SessionCapabilities | null`、
   `latestModelChangeByID` → `ModelChangeEntry | null`、`tryLockRuntime(s)` →
   `(() => void) | null`、`operationIDFromContext` → `string | undefined`、
   `timeoutSecondsParam` → `number | undefined`、`Registry.get` → `Tool | undefined`
   （顺带消除一处 `as Tool` 断言）。session/tools 两域 `ok: boolean` 归零。

验证: `deno task test` 1851 passed、`test:architecture` 8 passed、check/lint/fmt 干净。

P1-3 完成记录（2026-09-23）:
- **P1-3 `ErrNoRows` → DAO 可选返回 ✅ 已完成**（按原配方独立一轮）:
  `queryOne` 并入 `queryOptional`（不再抛），`execReturning` 返回 `T | undefined`，
  `esm.ts`/`recovery.ts`/`cron.ts` 的 `if (changed === 0) throw ErrNoRows` 改返回
  `boolean`，`bindings.ts` 的 Go 消息映射删除；生产侧 ~137 处引用 / 37 文件的
  三形态 try/catch 全部改为可选返回判断（无法成立的 INSERT/UPDATE 后读回改为
  显式 guard 抛描述性错误），7 个 `isNoRows*` 包装与 `ErrNoRows`/`isNoRows`
  全部删除（grep 归零）。回归: `deno task test` 1876 passed、
  `test:architecture` 8 passed、check/lint/fmt 干净。
- 其余域仍有 17 行 `ok: boolean`（`update/semver` 4、`memory` 2、`browser` 2 等）与
  25 个多返回值元组（含 `manager.get(): [Agent, boolean]`），按同一选型表在后续扫尾。
- 验证: 每模块行为回归 + `deno task test:architecture`。

### P2 — 生命周期与并发惯用化 ✅ 主体完成（2026-09-22）
1. ✅ `Symbol.dispose`（§3.6-1）: 全部 13 个 `close(): void` 句柄补
   `[Symbol.dispose]()`（与幂等 `close()` 共存），`HttpClient` 接口加可选成员；
   余项已清: ACP Run teardown 分层重构 ✅（P2-1，2026-09-24，见 §4 余项汇总）；
2. ✅ 值袋摊平（§3.5）: `RunContext`/`ToolContext` 的 symbol 值袋删除，改为显式
   类型字段（`agentID`/`eventSink`/`parentRunContext`/`parentMode`/`iterationBudget`），
   `contextKey`/`contextWithValue`/`toolContextWithValue` 机制整体移除，
   `EventSink` 类型迁至 `run_context.ts`（`agent.ts` 保留 re-export）。
   `tools/tool.ts` 对 `src/agent` 仅 type-only 引用（运行时无环，架构守卫通过）。
   比计划更彻底：迁移桥未保留，直接拆除；
3. ✅ 并发原语决策（§3.6-2/3/4）: `boundedParallel` 保留为唯一并发出口（保序 +
   全量 drain 契约，`@std/async` `pooledMap` 不能同时满足），理由已写入模块注释；
   `CountedMutex` 逐点审计后仅保留 `runtime_lock`/`identity_lock` 两个真实跨 await
   会合点；`EventChannel` 保持 AsyncIterable 投影（无界取舍已在注释记录，
   ✅ 契约测试已补: `src/agent/event_channel_test.ts`，2026-09-23）。

验证: `deno task test` 1851 passed、`test:architecture` 8 passed、check/lint/fmt 干净。

### P3 — 正确性与性能治理（针对 §3.7/§3.8）部分完成（2026-09-22）
1. ✅ 外部输入 JSON 解码 guard（§3.8）: 新建 `src/util/json.ts` 字段读取器
   （`asJsonRecord`/`parseJsonRecord`/`optString|Number|Boolean|StringArray|StringMap`），
   边界 lie-cast 清零: MCP wire 5 处改用 `parseRPCMessage`（非对象/坏 JSON 不再把
   read loop 打崩，字段类型验证 + `"id" in request` presence 语义保留），
   `allow.json`/`env.json`/`mcp.json` 改字段读取（错型字段→`undefined` 回退默认，
   坏条目跳过）；DAO `mapRow` 评估结论: 已每表集中（`*FromRecord` + 记录接口 +
   `queryOne<T>`，行映射本就内聚在 DAO/session），无需重构；
   余项（接受的残差）: 自有持久化 JSON 列（自写自读）、
   `settings.ts` 自带字段级解码无需迁移。provider SSE 解码 ✅ 已治
   （2026-09-24 收尾轮）: 三家 provider 的 SSE 解码改字段读取器解码器
   （`decodeAnthropicStreamEvent`/`decodeGoogleStreamChunk`/
   `decodeOpenAIStreamChunk`/`decodeResponsesEvent`+
   `decodeResponsesCompletedObject`，复用 `src/util/json.ts` 字段读取器，
   不引 schema 库），wire-presence 保持（真实部分携带的 usage/delta 字段
   缺失读 `undefined`，消费点 `?? 0` 兼容），错型字段降级 `undefined`、
   坏条目跳过、未知事件类型/字段宽容（前向兼容），`null` 可空字段保留
   `null`；非对象 payload 从 TypeError 炸流改为形状错误干净退出；
   `ResponsesCompletedObject.output` 声明修正为 `Array<string | Record>`
   （原 `string[]` 与消费点 `decodeResponsesOutputItem` 不符）；
   10 个确定性测试（合法样本逐字段 parity、坏 JSON、错型字段、未知类型）；
   验收: `src/provider` 非测试 `JSON.parse as` → 0。
4. ✅ 同步 DAO 慢查询基线（§3.7-1）: 新建 `src/db/query_stats.ts`，在
   `src/dao/database.ts` 的 5 个统一查询入口计时（`queryAll`/`queryOne`/
   `queryOptional`/`execChanges`/`execReturning`），≥50ms 计入 slow 并保留最慢
   SQL（截断 200 字符，参数化语句无字面量），汇总进 `sqliteStatsSnapshot`
   （`/debug/vars` 可见）；4 个确定性测试。
   余项: 用基线数据定位真实热点后做分片让出 + 离线扫描进 Worker（§3.7-2/3）。
   ✅ 已完成（2026-09-24 收尾轮）: 基线探针实测定位热点——DAO 查询均
   <50ms（50k 行内 8–38ms），真正热点是**无界离线扫描**: stats 聚合
   124–258ms@200k 行（`request_stats` 无界增长）与 grep 单文件 16MB 同步行
   循环；token 估算 cold 首轮 263ms 是一次性分词器装载（warm 后 0.5ms，
   LRU memo 已治理），判定为非热点、无需 Worker 化。
   治理落地: ①离线扫描进 Worker（§3.7-2）: 新建 `src/stats/stats_call.ts`
   （共享 dispatch，两种执行位共用同一 `stats.DB`/`StatsDAO` 查询实现）+
   `src/stats/stats_worker.ts`（模块 Worker，`openReadOnlyStandalone` 离线
   只读连接）+ `src/stats/query_offload.ts`（host runner: 传输级故障
   spawn/crash/timeout → 回退进程内，查询错误照常冒泡；`StatsQueryError`
   判别两种失败面）；`Server.handle` 改 async + executor 生命周期收进
   `shutdown`/`finished`；build 任务补 `--include src/stats/stats_worker.ts`；
   ②分片让出（§3.7-2）: grep 行循环改批量匹配（每块一次 worker 请求即一个
   事件循环让出点，512 行/块，16MB 单文件不再独家占线程）。
   判定记录: `serializeConversation`/估算热循环 warm 后 O(map 查找)，
   无需治理；compaction 扫描在 LRU memo 生效后非热点。
   验证: 8 个确定性测试（worker↔inline 结果一致、spawn 失败/超时回退、
   查询错误不回退、close 幂等）+ 编译产物 smoke（worker 在 `deno compile`
   二进制内直连协议跑通，不走回退面）；
2. ✅ 正则加固（§3.8 RE2→JS 回溯）: 新建 `src/util/regex.ts`，按威胁模型分两个入口:
   `compileUserRegExp`（grep 的用户原始模式: 512 字符限额 + 嵌套无界量词检测，
   拦截 `(a+)+` 族灾难性回溯形状，逃逸/字符类不受误伤）与 `compileGeneratedRegExp`
   （find/globset 的 glob 生成源: 只验语法，不受用户限额，避免 gitignore 长行回归）；
   grep 的既有"无效正则→字面量回退"契约顺带覆盖不安全形状，描述文案已同步；
   新增 6 个确定性测试（合法/超额/evil 形状/逃逸/语法错误/生成源）。
   余项: 形状检测是防御纵深而非证明，彻底隔离需受限 Worker + 超时（后续）；
   ✅ RE2 完全隔离已完成（2026-09-24 收尾轮）: 新建
   `src/util/regex_match.ts` + `src/util/regex_worker.js`（文本内联 +
   data: URL 受限 Worker，与 `js.ts` 同模式，编译产物可用），
   `UserRegExpMatcher` 每次请求带墙钟预算（默认 5s，可注入），超时即
   terminate worker 并抛 `RegExpMatchTimeoutError`——穿过形状检测的灾难模式
   （`(a|a)+$` 族，红证据: 32 字符行直接挂死事件循环）从挂死变为有界超时；
   grep 集成: 超时 → 全量重扫为字面量（两模式结果不混）+ 独立提示文案，
   `GrepToolOptions.matchTimeoutMs` 注入缝供测试；保留项: find/globset 的
   glob 生成源只跑 `compileGeneratedRegExp`（有界输入路径字符串，非用户
   原始模式），判定不入 Worker。8 个 matcher 测试 + 3 个 grep 集成测试；
3. ✅ `debugpprof` 决策: 保留为本地调试端点（`/debug/vars` SQLite 竞争指标有真实
   用途），模块去 Go 化: `src/debugpprof/pprof.ts` → `src/debugendpoints/debugendpoints.ts`，
   `newHandler`→`createDebugHandler`、`startForDebug`→`startDebugServer`，日志文案去
   "pprof"；URL 路径 `/debug/pprof/*` 与 `VIBECODING_PPROF_ADDR` 作为兼容面保留，
   Go profile/trace 端点继续 501 并指向 Deno `--inspect`。

验证: `deno task test` 1857 passed、`test:architecture` 8 passed、check/lint/fmt 干净。

### P4 — 收尾清理 ✅ 已完成（2026-09-22）
1. ✅ 注释去 Go 化（§3.11）: 539 处 `Ported from/Translated from` 溯源行清零；
   `路径: 描述`形态保留描述、`路径 (理由`形态保留理由，`Deviation:` 行为说明全部保留；
2. ✅ 命名扫描（§3.4/§3.12）: 188 个枚举式 PascalCase 常量 → SCREAMING_SNAKE
   （lowerCamel 与既有标识符大量撞名，已验证 SCREAMING 零冲突，一次批改）；
   PascalCase 方法（`Get`/`SetStatus`/`Delete`）→ lowerCamel；`resetForTest`/
   `listenAddrForTest` → `resetDebugServer`/`debugListenAddr`；
   `CurrentVersion`/`currentVersion` 同概念重复已合并（store 拥有）；
   文件命名决定: **保留 snake_case**（churn > 收益，§3.12 定案）；
3. ✅ 迁移文档 `go-to-typescript-migration.md` 保留为历史台账；Go 源树不再是
   source of truth（溯源注释已移除即为宣告）。

### 风险与缓解
- **行为兼容风险**（P1 的 ErrNoRows、P2 的 teardown 重排）: 先补刻画测试
  （characterization tests）再重构；teardown 顺序逐条对照现有注释里的 LIFO 清单。
- **架构边界风险**（P2 的值袋摊平、P3 的 DAO mapRow）: 只在既有 owner 内动
  （`src/agentruntime`/`src/dao`），不新增第二条路径；`test:architecture` 随批。
- **冲突面风险**: 命名/机械替换类改动避开大 PR 并行期，按目录原子合入。

### 余项汇总（2026-09-24 复查校准）

P0–P4 主体落地后的真实剩余工作（状态行以此为准）:

- ✅ **P1-3 已完成**（2026-09-23）: `ErrNoRows`/`isNoRows` 与 7 个包装删除、
  DAO 可选返回、`bindings.ts` Go 消息映射清理，详见 P1-3 完成记录；
- ✅ **§3.4-1 `newXxx` → `createXxx` 已完成**（2026-09-23，例外全部清零）: 全部
  机械重命名（231 文件；含 2 个 Go 式方法 `newToolRegistry`/`newSessionExecution`），
  `sdk/` 8 个公开工厂按约定保留。撞名家族已随 §3.4-2 合并定名:
  `newProvider` 家族 → `createAnthropicProvider`/`createOpenAIProvider`/
  `createGoogleProvider*`；`newAgent` 家族 → `createAgent`/`createAgentWithLoopConfig`
  （`agent/factory.ts` 的自由 `createAgent` 转为模块私有 `createAgentFromFactory`）。
  `newSession()`（TUI 对话动作方法）与 `newText`/`newId` 等局部变量名属正常
  命名，不在范围内。
- **§3.4-2 双入口合并**（多轮完成中，最近 2026-09-23: sandbox 4 对 +
  `decision_record`/`bash`/`session_store`/`scheduler`/`knowledgebase`×2/
  provider-factory/agent-factory/http-client×2 共 9 对已合并为单入口（尾部
  默认参数形态）；knowledgebase 的 settings/factory 默认用引用前参的默认式
  保持三形态语义，调用点零改动。同轮完成 Gemini/Vertex 6 变体合并
  （`createGeminiProvider`/`createVertexProvider`，AndProxy 调用点已改序，
  无显式 opts 时保留旧的流客户端回退语义）与
  `createToolResultMessageWithContents` 并入 `createToolResultMessage`
  （contents 尾参，调用点已改序）。同轮完成 `newProvider` 家族：
  anthropic/openai 各 5 变体链并入 `createAnthropicProvider`/`createOpenAIProvider`，
  google 低层定名 `createGoogleProvider`/`createGoogleProviderWithHTTPClient`，
  register 的配置构造器改名 `anthropicProviderFromConfig`/`openaiProviderFromConfig`；
  `createXProviderWithHTTPClient`×3 保留为注入 client 的测试缝隙变体。
  `newAgent` 家族已定名（`createAgent`/`createAgentWithLoopConfig`，2026-09-23）。
  余下 5 个待判定变体已于 2026-09-24 收尾轮全部判定/落地:
  `*WithTurn`×2 合并（`turn?` 尾参，`createSessionRunAndEvent`/
  `createExecutionIntentAndSessionRunEvent` 单入口，WithTurn 导出删除）；
  `createImageToolResultWithContent` 改回 `createImageToolResult(text, image)`
  （旧 `mimeType`/`base64` 入参变体零调用，属死双入口直接删除）；
  `createRunToolWithActive` 并入 `createRunTool`（构造器本就 `active ??
  createActiveRegistry()`，两入口行为完全等价）；
  `createManagerWithProjectDirs` 改回 `createManager(globalDir, projectDirs)`
  （变参版 `createManager(globalDir, projectDir, ...rest)` 零调用已删；
  `session_runtime.ts` 内与 sandbox 同名，用导入别名 `createSkillsManager` 消歧）；
  `createRegistryWithConfig` 判定保留（与 bare `createRegistry` 是两个操作——
  前者构造+注册默认/过滤工具且需传 skillsMgr/imageHint，后者裸构造不注册，
  非 Go functional-options 残留；余 5 个 `createXxxWithYyy` 导出 = 3 个 provider
  `WithHTTPClient` 测试缝隙 + `createAgentWithLoopConfig` + 它，均有记录理由）；
- ✅ **P2-1 ACP teardown 已完成**（2026-09-24 收尾轮，刻画测试先行）:
  新增 8 例测试（红→绿）——`prompt_test` 4 例: 终态投影顺序+admission 释放、
  失败 Run 终态化+释放、cancel 钩子抛错、终态投影写失败；`run_test` 3 例:
  EOF / transport 写失败 / 启动扫描失败三条退出路径的 Runtime host 释放
  （观察口为新增诊断导出 `recoveryCoordinatorCount`，对齐既有
  `runtimeLeaseBusListening` 先例）；`runtime_lock_test` 1 例: durable release
  抛错时进程本地锁必释放。落地内容:
  1. `handlePrompt` Run teardown 改分层 `try/finally`（`src/acp/server.ts`）:
     每步独立 try/catch 隔离（`cancel()`/终态投影两处原为裸调用），外层 catch
     兜底保证 detached IIFE 不产生 unhandled rejection，`runtimeRelease()`
     收进内层 `finally` 必达——admission 租约不再可能被中途抛出泄漏；
  2. `runACPInner` 的 `cleanup` 收编为单一 `try/finally` 所有权
     （`src/acp/run.ts`）: provider 失败 / setup 失败 / dispatch 失败 /
     正常 EOF 四条退出路径统一过 finally；`recoveryCoordinator.start` 移入
     try 内（启动扫描失败也不再泄 coordinator）；provider-catch 内显式
     `await cleanup()` 删除（双入口收敛为单入口）；
  3. `RuntimeLeaseGuard.release` 的进程本地 unlock 改 `finally` 必达
     （`src/session/runtime_lock.ts`）: durable 写失败不再卡死 `CountedMutex`；
  4. Go-defer 注释清零: `agent.ts` "Go's `defer cancelRun()`" 与 run.ts
     "LIFO:" 两处改写为 TS 语境的意图/顺序说明，`grep "LIFO\|Go's \`defer"`
     → 0。判定记录: `using` 不适用于跨 await 的 teardown（admission 释放必须
     晚于终态持久化），按 §3.6-1 选分层 `try/finally`；`execution.ts` /
     `session_lifecycle.ts` 终检为单层 `try/finally` 释放、无闭包 teardown，
     无需改动。
  验证: `deno task test` 1884 passed / 0 failed、architecture 8/8、
  check/lint/fmt 干净（2026-09-24）；
- ✅ **P3 治理余项已完成**（2026-09-24 收尾轮）:
  慢查询基线探针实测定位热点（DAO 查询 <50ms；真热点 = stats 聚合
  124–258ms@200k 行 + grep 16MB 同步行循环；估算 cold 成本为一次性装载、
  非热点），离线扫描进 `Deno.Worker`（stats 查询 executor: 共享
  `stats_call.ts` dispatch + 模块 worker `stats_worker.ts` + host 回退，
  `Server` 改 async 接线，build 补 `--include`，编译产物 smoke 通过）、
  分片让出（grep 批量匹配每块一让出点）、RE2 完全隔离（受限 worker +
  超时，`(a|a)+$` 族从挂死变有界超时 + 字面量回退）；
  唯一接受残差: provider SSE 解码 guard ✅ 已治（2026-09-24 收尾轮）:
  三家 provider 的 SSE 解码改 `src/util/json.ts` 字段读取器解码器（不引
  schema 库，复用 MCP wire 先例），wire-presence 保持 + 错型降级 + 未知
  事件/字段宽容（前向兼容），非对象 payload 从 TypeError 炸流改为干净
  形状错误；`output` 声明修正与消费点对齐；10 个解码测试锁 parity 与
  边界语义；`src/provider` 非测试 `JSON.parse as` → 0，残差只剩自有
  持久化 JSON 列（自写自读，33 处）；
- ✅ **comma-ok + value+error 扫尾已完成**（2026-09-24 收尾轮）:
  `session/store.getLatest*` ×5 改 `T | null`（接口+`MemoryStore`+私有
  `latestByType`+`latestCompactionLocked`，`emptyCompactionEntry` 零值伪造
  删除；`Manager` 侧本就是 `| null`，两侧同名接口形态就此统一，调用点
  `memory_store_test`/`replay_test` 同步改断言）；value+error 元组 4 处清零:
  `prepareRequestMessages` 返回 `Message[]` 失败抛错（loop 调用点 try/catch
  后接既有 `tryRecoverContextOverflow`/terminal 路径）；
  `claimToolExecutionWithRecovery` 改判别式联合 `ToolExecutionClaim`
  （`skipped|claimed|reused`，失败抛错，调用点 catch 后保持原 tool-error 事件）；
  `normalizeToolCallArguments` 返回 `Record | null`、非法 JSON 先保留
  `invalidArguments` 再抛（对齐 `JSON.parse` 语义；两处调用点 catch 后构建
  notice，行为不变）；`gateToolResultImages` 改对象返回 `GatedToolResult`
  （`{content, contents, isError, error?}`，消灭 4 元组）。保留项（非 comma-ok，
  形态已复查）: `ok: boolean` 结构字段 3 处（doctor/esm/platform 报告字段）、
  坐标类 `cursorPos()`/`image_coordinates`/`splitEnvVar`/`hunkRanges`、多值
  `getHistoryState()`/`requestTokenBudget()`/`consumeANSISeq()`/`think_split`/
  `selectCacheMarkers`/`error_info` 等，共 17 处元组返回；
  验证: `deno task test` 1876 passed / 0 failed、architecture 8/8、
  check/lint/fmt 干净（2026-09-24）；
- ✅ **P2-3 余项已完成**（2026-09-23）: `EventChannel` 契约测试
  `src/agent/event_channel_test.ts`（FIFO/无界缓冲/close 语义/AsyncIterable）。

---

## 5. 有意保留的映射（不要"优化"掉）

| 保留项 | 理由 |
| --- | --- |
| `src/<pkg>/mod.ts` 桶文件 | 就是 Deno std 惯例 |
| `*_test.ts` 后缀 | Deno 官方测试发现约定 |
| table-driven tests（`const cases = [...]` 循环） | Go/Deno 都惯用，密度高、好扩展 |
| `AbortSignal` ← `context.Context` 取消语义 | 标准映射，正确 |
| `AsyncIterable<StreamEvent>` ← `<-chan StreamEvent` | 标准映射，正确（只补背压决策） |
| 小接口 + 消费方定义（`Store`、`Tool`、`Provider`） | 结构化类型的优势区，Go/TS 共通 |
| `AggregateError` ← `errors.Join` | 标准映射 |
| typed `Error` class 层级本身 | 这就是 TS 惯用法，只是去掉哨兵/样板 |
| RFC3339 字符串存 SQLite 时间戳 | 可词法排序，规避 JS 精度问题（只换生成方式） |
| snake_case 文件名 | churn 大于收益（默认保留，见 §3.12） |

---

## 6. 验收标准

1. 量化目标（可 grep 度量，完成后复查）:
   - `export const ErrXxx` 哨兵: 18 → 0 ✅（含 P1-3 的 `ErrNoRows`，2026-09-23 清零）；
   - comma-ok / value+error 元组: → 0 ✅（2026-09-24 清零；`getLatest*`×5 改
     `T | null`，value+error 4 处抛错化/对象化；余 17 处元组为坐标/语义多值
     保留项与 `ok: boolean` 报告字段 3 处，见 §4 余项汇总）；
   - no-op 指针克隆 helper: 6 → 0 ✅（P0 已达成）；
   - `JSON.parse(...) as`: 边界 lie-cast → 0 ✅（MCP wire + config 族已 guard；余 42 处为 provider SSE/自有列）；
   - `using`/`Symbol.dispose` 在生命周期热点路径落地 ✅ 13 处句柄已具备；ACP Run teardown 分层重构 ✅（P2-1，2026-09-24；跨 await 的 admission 释放按 §3.6-1 选分层 `try/finally`，非 `using`）；
   - 用户可见文本中 "nil" Go 词 → 0 ✅（P0 已达成）；
   - PascalCase 导出常量词汇 → 0 ✅（188 个已批改为 SCREAMING_SNAKE，`ErrNoRows` 已随 P1-3 消亡）。
2. 行为不变: 全量 `deno task test`、`deno task test:architecture`、
   `deno task check`、`deno lint` 通过；TUI/CLI/ACP 跨入口契约测试覆盖触及面。
3. 长任务可靠性不回退: 心跳续租、流式输出在慢查询压力下不被饿死
   ✅（2026-09-24: stats 离线扫描进 Worker + grep 分片让出，慢扫描不再
   占住事件循环；基线探针 + 8 个 offload 测试锁定）；
4. 文档同步: 本文件随各阶段勾选更新；用户可见变更同步 `docs/en`、`docs/zh`。

---

## 附录 A: 复查用 grep 清单

```bash
grep -rn --include='*.ts' -E "export const Err[A-Z]" src | grep -v _test
grep -rn --include='*.ts' -E "export function new[A-Z]" src sdk | grep -v _test
grep -rn --include='*.ts' -E "ok: boolean|): \[[a-z]" src | grep -v _test
grep -rn --include='*.ts' -E "BoolPtr|clone\w*Ptr" src        # 应为 0
grep -rn --include='*.ts' -E "cloneString" src             # §5 有意保留，预期非零
grep -rn --include='*.ts' -E "JSON\.parse\([^)]*\) as " src | grep -v _test
grep -rn --include='*.ts' -E "\bnil\b" src | grep -v _test
grep -rn --include='*.ts' -E "\): \[[^]]*Error \| (null|undefined)" src | grep -v _test  # value+error 应为 0
grep -rn --include='*.ts' -E "export function create\w*With[A-Z]" src sdk | grep -v _test  # 余 5 个均有记录理由
grep -rn --include='*.ts' -E "Ported from|Deviation:" src sdk | wc -l
grep -rn --include='*.ts' -E "\[Symbol\.(async)?Dispose\]" src | wc -l
grep -rn --include='*.ts' -E "LIFO:|Go's `defer" src | grep -v _test   # 应为 0（P2-1 已清）
grep -rn "new Worker(" src --include='*.ts' | grep -v _test   # Worker 入口仅 workflow/js、util/regex_match、stats/query_offload
grep -rn --include='*.ts' -E "JSON\.parse\([^)]*\) as " src/provider | grep -v _test   # 应为 0（provider SSE 已 guard）
```

## 附录 B: 典型案例对照

| 位置 | 现状（Go 直译） | 目标（Deno/TS 惯用） |
| --- | --- | --- |
| `src/dao/database.ts:12` | `ErrNoRows` 单例 + `isNoRows` 身份比较 | DAO 返回 `T \| undefined` 或 `NotFoundError` class |
| `src/session/runtime_submission.ts:43` | 消息拼接模拟 `%w` | `new Error(msg, { cause })` |
| `src/tools/tool.ts:61` | `values: Map<symbol, unknown>` 值袋 | 显式可选字段（`budget?: IterationBudget`） |
| `src/session/runtime_lock.ts:1052` | `[release, ok]` 元组 | `guard: { release(): void } \| null` |
| `src/config/settings.ts:279` | `BoolPtr`/`cloneBoolPtr` no-op | 删除 |
| `src/acp/server.ts`（Run 生命周期编排） | 分层 `try/finally` ✅（P2-1 取代可变状态 + teardown 闭包模拟 `defer`） | 分层 `try/finally` + `using` |
| `src/agent/parallel.ts:17` | 手写 worker 池 | `@std/async` `pooledMap` |
| `src/stats/stats.ts:224` | 手写 RFC3339Nano | `d.toISOString()` |
| `src/provider/types.ts:315` | `formatUsage` 返回 `"nil"` | `"none"`/`"(none)"` 等 TS 语境文案 |
