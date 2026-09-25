# OpenSAC 单一 Core 进程与多端适配架构方案

- 状态：设计提案
- 日期：2026-09-25
- 目标仓库：OpenSAC
- 适用范围：`src/agentruntime`、`src/session`、`src/acp`、`src/cli`、TUI、WebUI、SDK 和架构约束

## 1. 背景

OpenSAC 当前已经具备“一个 Agent Core、一个前端无关的 Agent Runtime”的代码结构，但运行形态仍然是多个入口各自创建 Runtime：

- TUI 自己创建 `TUISession` / Agent 资源；
- CLI 自己创建 Session、Provider、Agent 和 Run；
- ACP 自己创建长生命周期 ACP server、SessionRuntime 和 AgentManager；
- 入口之间的 Agent 构造、执行、恢复和资源清理路径仍然可能各自承担一部分职责。

这会导致以下问题：

1. 多个入口可能重复创建 Provider、MCP、Registry、Scheduler 和 Session 资源；
2. 客户端重启后，核心状态和连接生命周期难以统一管理；
3. WebUI 如果直接接入现有 Runtime，很容易演变成第二套后端；
4. ACP 虽然是标准协议，但当前 ACP 进程仍然拥有过多 Runtime 所有权；
5. 进程级重复启动无法通过一个统一的 Core 生命周期解决。

本方案将 OpenSAC 的目标架构调整为：

> 同一用户、同一台机器默认只有一个全局 Core 进程。TUI、CLI、WebUI 和 ACP 都是 Core 的客户端或协议适配器，而不是独立的 Agent Runtime 宿主。

Core 的唯一性是默认运行模式；显式 Standalone 模式仍然保留，用于测试、CI、调试和故障隔离。

## 2. 目标与非目标

### 2.1 目标

1. 默认情况下，同一用户、同一机器只运行一个 Core 进程；
2. TUI、CLI、WebUI、ACP 共享同一套 Agent、Session、Run、MCP、权限和事件语义；
3. 保留现有 `sessions.db`、Session Run、Decision、Attachment 和 Runtime Lease；
4. 保留 ACP stdio NDJSON/JSON-RPC 兼容性；
5. 支持 `127.0.0.1` 默认监听和用户显式配置的 `0.0.0.0` 监听；
6. 支持可选的密码数组认证；
7. 支持 Standalone/Private Core；
8. 防止旧 Core、异常进程或手动启动的第二个 Core 重复执行同一个 Session；
9. 保持 Core 不依赖 TUI、CLI、WebUI、ACP 或具体 UI 框架；
10. 允许未来增加新的客户端，而不复制 Runtime 语义。

### 2.2 非目标

1. 本阶段不重新设计 `sessions.db` 的持久化模型；
2. 本阶段不删除现有 `session_runtime_leases`；
3. 本阶段不把 ACP 改造成另一套 Agent Core；
4. 本阶段不让 WebUI 直接访问数据库、Session 文件或 MCP；
5. 本阶段不实现多租户 RBAC、TLS 或远程设备管理；
6. 本阶段不要求所有外部客户端都使用同一种传输；JSON-RPC 2.0 是统一应用协议，HTTP、WebSocket/SSE 和 ACP stdio 只是传输适配器。

## 3. 总体架构

```text
┌──────────────┐       ┌──────────────┐       ┌──────────────┐
│ OpenSAC TUI  │       │ OpenSAC CLI  │       │ WebUI        │
│ UI Projection│       │ UI Projection│       │ UI Projection│
└──────┬───────┘       └──────┬───────┘       └──────┬───────┘
       │                      │                      │
       └──────────────┬───────┴──────────────┬───────┘
                      │ Core Client         │
                      │ JSON-RPC 2.0         │
                      │ HTTP + Event Stream  │
                      ▼                      │
              ┌──────────────────────────────┐
              │        OpenSAC Core          │
              │                              │
              │ Core Runtime Host             │
              │ ├─ SessionRuntime             │
              │ ├─ AgentRuntime/AgentManager  │
              │ ├─ Provider                   │
              │ ├─ MCP                        │
              │ ├─ Permissions/Decisions     │
              │ ├─ Scheduler/Recovery         │
              │ ├─ Session/Run DB             │
              │ └─ Canonical Event Stream     │
              └──────────────────────────────┘

┌──────────────┐
│ ACP Client   │
└──────┬───────┘
       │ stdio NDJSON/JSON-RPC
       ▼
┌──────────────┐       Core Client       ┌──────────────────────────────┐
│ opensac acp  │ ──────────────────────▶ │ OpenSAC Core                │
│ ACP bridge   │ ◀────────────────────── │ JSON-RPC + Event Stream      │
└──────────────┘                         └──────────────────────────────┘
```

核心原则：

```text
Core 拥有语义
Adapter 拥有协议
UI 拥有渲染
```

任何 UI 或协议适配器都不能重新实现以下逻辑：

- Agent 构造；
- Session 资源装配；
- Run 状态机；
- Provider 调用；
- Tool 执行；
- MCP 生命周期；
- 权限和审批；
- 事件语义；
- Session 恢复；
- Run 终止状态。

## 4. Core 进程模型

### 4.1 Core 是独立进程

新增一个 Core 宿主入口。它负责启动完整 Runtime，但自身不实现领域语义。可以使用内部命令或服务命令承载，例如：

```text
opensac core
```

该命令属于 Core 宿主入口，不是 TUI/CLI/ACP 的替代实现。普通入口通过 discovery 机制自动发现或启动它。

Core 进程内部拥有：

- `SessionRuntime`；
- `AgentManager`；
- Provider factory 和 Provider 实例；
- Registry、Tools、Skills 和 Context；
- MCP 客户端；
- Sandbox、Permissions、Decisions；
- Session manager 和数据库访问；
- Cron、后台任务、恢复协调器；
- Canonical Event Stream。

Core 进程关闭时，必须按照统一的 runtime shutdown 顺序取消 Run、等待终态、释放 MCP、关闭数据库并注销 Core。

### 4.2 Core 的全局唯一范围

默认唯一范围是：

```text
同一用户 + 同一机器 + 同一 OpenSAC state 根目录
```

不同用户、不同 `OPENSAC_DIR` 或不同机器可以拥有不同 Core。

Core 唯一性不依赖工作区或项目。不同项目仍然由 Core 根据 Session 的持久化目录和 Runtime Location 进行隔离。

### 4.3 Standalone/Private Core

保留显式 Standalone 模式：

```text
opensac --standalone
```

Standalone 不复制 Runtime，也不把 Runtime 直接嵌入 TUI/CLI/ACP，而是启动一个隔离的 Private Core：

- 使用独立 state/session 目录；
- 使用独立端口；
- 使用独立认证配置；
- 不注册到全局 Core discovery；
- 不参与全局 Core 锁；
- 仍然使用完全相同的 Core 协议和 Runtime 实现。

这样可以保证测试、CI、调试和故障隔离不污染正常用户数据。

## 5. Core 发现、单实例和生命周期

### 5.1 Core 状态文件

Core 状态放在用户 state 目录下，例如：

```text
~/.local/state/opensac/core.json
~/.local/state/opensac/core.lock
```

`core.json` 记录发现信息：

```ts
interface CoreRegistration {
  id: string
  version: string
  pid: number
  protocolVersion: number
  bindHost: string
  port: number
  startedAt: number
}
```

`passwords` 不写入注册文件。注册文件只保存 Core 的发现和协议信息，认证配置从当前配置来源读取。

### 5.2 单实例锁

与只依赖 `core.json` 的方案不同，OpenSAC Core 启动必须先获得独占 Core 锁：

```text
获取 core.lock
    ↓
检查已注册 Core 是否健康
    ↓
已有健康 Core：释放锁，客户端直接复用
    ↓
没有健康 Core：启动 Core
    ↓
Core 注册并进入 ready
    ↓
保持锁直到 Core 退出
```

锁实现应具备：

- 原子创建或操作系统级互斥语义；
- owner token；
- PID 和进程身份；
- 正常退出时释放；
- 异常退出后的 stale 检测；
- 无法确认旧进程状态时 fail closed，而不是冒险启动第二个 Core。

`core.json` 的写入使用临时文件加原子 rename。每个 Core 实例拥有随机 `id`，注册后持续确认自己仍然是当前注册者；如果被另一个实例覆盖，旧实例退出并清理自己的资源。

### 5.3 客户端发现流程

TUI、CLI、WebUI 和 ACP bridge 统一执行：

```text
读取 core.json
    ↓
检查协议版本和 OpenSAC 版本
    ↓
请求 /health
    ↓
检查认证配置
    ↓
健康则复用
    ↓
不健康或不存在则尝试启动 Core
    ↓
等待 ready
    ↓
建立 Core Client
```

实际连接地址来自注册信息，不能由客户端自行猜测端口。

### 5.4 端口和监听地址

Core 配置模型：

```ts
interface CoreConfig {
  host: string
  port: number
  auth: boolean
  passwords: string[]
}
```

默认配置：

```json
{
  "core": {
    "host": "127.0.0.1",
    "port": 4096,
    "auth": false,
    "passwords": []
  }
}
```

规则：

- 默认 `host` 为 `127.0.0.1`；
- 用户可以配置 `0.0.0.0`；
- 默认端口为 `4096`；
- 用户可以配置固定端口；
- `port: 0` 表示由操作系统选择空闲端口；
- 固定端口冲突时，若占用者是已注册的健康 Core，则复用；否则报告端口冲突，不启动第二个 Core；
- Core 注册文件保存实际端口；
- 监听 `0.0.0.0` 时，loopback 客户端使用实际可达地址连接，远程客户端使用其配置的网络地址连接。

### 5.5 认证

认证由两个字段明确控制：

```ts
interface CoreConfig {
  auth: boolean
  passwords: string[]
}
```

语义：

- `auth: false`：不校验密码，`passwords` 不参与认证；
- `auth: true`：`passwords` 必须至少包含一个字符串；
- 请求携带的密码只要匹配数组中的任意一个即可；
- `auth: true` 且 `passwords: []`：Core 配置无效并拒绝启动；
- 密码不放入 URL；
- HTTP 使用认证请求头，ACP bridge 从本地配置读取密码；
- WebUI 在用户明确提供密码后建立连接，不把密码放进页面 URL。

`0.0.0.0` 不会自动开启认证。用户必须根据部署环境显式设置 `auth: true`。

## 6. Core 内部协议和事件模型

### 6.1 JSON-RPC 与传输层

Core 对外提供统一的 JSON-RPC 2.0 应用协议：

- HTTP POST：普通请求、查询、健康检查和能力获取；
- WebSocket 或 SSE：实时事件、Run 输出、审批请求和控制事件；
- ACP stdio：由 `opensac acp` bridge 转换为 Core JSON-RPC 请求和事件。

JSON-RPC 2.0 是 Core Client 与 Core 之间的唯一领域协议。HTTP、WebSocket/SSE 和 ACP stdio 只负责传输，不重新解释 Run 语义。

普通请求使用标准 JSON-RPC request/response；实时事件使用 JSON-RPC notification。每个事件仍必须携带 Session ID、Run ID、事件序号和事件类型。

### 6.2 Core API 的所有权

Core API 只暴露领域操作，例如：

- 创建、打开、关闭 Session；
- 提交输入；
- 开始、恢复、取消 Run；
- 处理 Approval/Question；
- 查询 Session/Run 状态；
- 订阅事件；
- 管理附件和 Artifact；
- 获取能力和配置快照。

API 不允许客户端直接执行：

- Agent 构造；
- Provider prompt 构造；
- SQL；
- Session 文件写入；
- Tool registry 修改；
- Runtime lease 修改。

### 6.3 Canonical Event Stream

所有 UI 和 ACP 都从 Core 接收同一类 canonical event：

```text
RunStarted
InputAccepted
TextDelta
ReasoningDelta
ToolCallStarted
ApprovalRequested
ToolResult
RunFinished
SessionError
```

不同适配器只能改变 wire format 和渲染方式，不能改变：

- Run ID；
- Session ID；
- event ID/sequence；
- 事件顺序；
- terminal 状态；
- approval/question 语义。

事件至少需要携带可重连所需的 Session ID、Run ID、事件序号和事件类型。客户端重连时通过 cursor 或 last-event ID 请求补发，避免把 Core 变成仅适用于单连接的广播器。

### 6.4 实时性设计

JSON-RPC 只定义消息格式，不决定实时性。Core 使用传输方式区分普通命令和实时事件：

- HTTP POST JSON-RPC：用于创建、查询、提交命令、取消和审批响应；
- WebSocket JSON-RPC：用于双向实时事件、服务端反向请求和控制事件；
- SSE JSON-RPC notification：用于不需要客户端反向请求的单向事件流；
- ACP stdio NDJSON/JSON-RPC：用于 ACP bridge 与 Core 的本地双向流。

实时 Run 不等待完整 HTTP response 才向客户端返回文本。客户端先通过普通 JSON-RPC 请求启动或提交输入，Core 随后立即通过事件通道发送 `TextDelta`、`ReasoningDelta`、工具事件和终态事件。

流式事件不使用 JSON-RPC batch。每个 `TextDelta` 和 `ReasoningDelta` 都应作为独立 notification 立即发送，避免等待 batch 完成后才渲染。普通互不依赖的查询请求可以使用 batch，但不得把实时流事件放入 batch。

Core 发起的 Approval/Question 使用服务端 JSON-RPC request，客户端使用相同 request ID 返回结果。事件流必须携带 sequence；断线重连时，客户端通过 `events.replay` 或 `events.subscribe` 携带 cursor 恢复事件。

ACP bridge 虽然增加一个本地进程转发层，但只做协议映射和转发，不复制 Runtime 状态，也不改变事件顺序。Core、ACP client 和 UI 都直接消费同一套 canonical events，因此 bridge 不应成为事件缓冲或重排序层。

这套设计不会因为使用 JSON-RPC 而降低实时性。实际延迟主要由 Provider 响应、工具执行、MCP 通信和网络路径决定，而不是由本地 JSON 序列化决定。

## 7. TUI、CLI 和 WebUI 的职责

### 7.1 TUI

TUI 只负责：

- 终端输入输出；
- 键盘和快捷键；
- Core Client 连接；
- 将 Core 事件渲染成终端 UI；
- 保存纯 UI 临时状态。

TUI 不再创建：

- Agent；
- AgentManager；
- Provider；
- MCP；
- SessionRuntime；
- Durable Run。

### 7.2 CLI

CLI 只负责：

- 参数解析；
- 构造 Core Client；
- 选择 TUI、Print 或 Utility 模式；
- 将 Core 事件投影为 stdout/stderr；
- 退出码和信号处理。

`-P` Print 模式仍然支持一次性运行，但它只创建一个客户端，不直接创建 Agent Core。

### 7.3 WebUI

WebUI 是新的 UI projection，不是新的 backend：

- 浏览器只访问 Core 的 JSON-RPC HTTP/WebSocket/SSE 接口；
- WebUI 不直接访问 `sessions.db`；
- 不读取 Session 文件；
- 不启动 MCP；
- 不直接调用 Provider；
- 不拥有权限和审批状态；
- 不保存 canonical Desktop facts。

WebUI 的浏览器状态只保存当前连接、显示状态和用户输入草稿。Session、Run、Provider、配置、审批和 Artifact 等事实全部来自 Core。

## 8. ACP 设计

### 8.1 兼容目标

继续支持：

```text
opensac acp
```

继续使用现有 ACP stdio NDJSON/JSON-RPC wire protocol。现有 ACP 客户端和 Desktop 不需要因为 Core 迁移而改变协议。

### 8.2 ACP 进程的新职责

`opensac acp` 变为 ACP bridge：

```text
ACP Client
    │ stdio
    ▼
opensac acp bridge
    │ Core Client
    ▼
OpenSAC Core
```

bridge 只负责：

- 读取和写入 stdio；
- 维护 ACP request ID；
- 转发 ACP 请求；
- 转发 Core canonical events；
- 将取消映射为 Core cancel；
- 将 Approval/Question 映射为 ACP reverse request；
- 处理断线、重连和 Core 退出；
- 将 Core terminal state 映射为 ACP terminal response。

bridge 不负责：

- Agent 构造；
- Provider 创建；
- SessionRuntime 创建；
- Run 状态机；
- 工具执行；
- MCP 生命周期；
- 事件语义。

### 8.3 ACP 生命周期

1. bridge 启动；
2. discovery 找到或启动 Core；
3. bridge 连接 Core；
4. `initialize` 能力由 Core 返回；
5. ACP session/new/prompt/cancel 请求转发到 Core；
6. Core events 转换为 ACP notifications 或 reverse requests；
7. ACP client 断开时，不销毁 Core；
8. ACP bridge 退出时，不关闭全局 Core；
9. Standalone 模式下，bridge 退出时关闭其 Private Core。

### 8.4 从 OpenCode 借鉴和需要加强的部分

借鉴 OpenCode 的部分：

- 客户端自动发现共享后台 Core；
- 健康检查和版本兼容；
- Core Client SDK；
- Standalone 模式；
- service 生命周期命令；
- 统一事件流和取消语义。

需要加强的部分：

- OpenCode 的注册文件竞争不是严格的进程锁，OpenSAC 增加 `core.lock`；
- OpenSAC 保留 `session_runtime_leases`，防止异常旧进程写入；
- ACP 继续是薄适配器，不拥有第二套 Runtime；
- Core 注册信息和实际端口分离，支持自动端口和固定端口；
- 认证使用显式 `auth + passwords` 配置，而不是隐式 token 规则。

## 9. Session、Run 和跨进程安全

Core 进程锁只解决正常启动时的 Core 唯一性。Session 所有权仍由现有 Runtime Lease 负责。

保留以下防线：

```text
core.lock
  → 防止正常启动重复 Core

session_runtime_leases
  → 防止同一个 Session 出现重复 owner

ownerId + epoch + tokenHash
  → 防止旧进程在失去所有权后继续写入
```

Core 迁移期间，旧的直接运行入口必须逐步改为 Core Client。没有迁移的旧入口暂时仍可依赖 Runtime Lease，但不得被当作最终架构。

Session lease 的 heartbeat、恢复和 fenced write 语义保持不变。Core 只是这些机制的主要宿主，不重新定义 lease 协议。

## 10. 迁移方案

迁移分为以下阶段，每阶段保持可运行和可回滚。

### 阶段 1：建立 Core 宿主

- 增加 Core 进程入口；
- 增加 Core lock、注册和 discovery；
- 增加 health、version、auth 和实际端口信息；
- 保留现有入口行为；
- 暂不改变 TUI/CLI 的业务语义。

### 阶段 2：提取 Core Client SDK

- 提供 TUI、CLI、WebUI 共用的连接、重连、请求和事件 API；
- 支持 JSON-RPC 请求、WebSocket/SSE 事件、取消和 cursor；
- 处理 Core 退出、版本不兼容和认证失败；
- 暂时允许旧入口通过适配器使用同一套 Core 能力。

### 阶段 3：迁移 TUI

- TUI 改为 Core Client；
- 保留 TUI 的终端渲染和输入体验；
- 删除 TUI 直接创建 Agent/Provider/MCP 的路径；
- 验证事件、审批、取消、恢复和重连。

### 阶段 4：迁移 CLI

- Print、doctor、speedtest 等命令区分 Core Client 模式和本地纯工具模式；
- 迁移需要 Session/Provider 的命令；
- 保留无需 Core 的诊断和配置命令。

### 阶段 5：迁移 ACP

- 保留 ACP stdio 协议；
- 将 ACP server 改为 bridge；
- 迁移 Session、Prompt、Cancel、Approval、Question 和事件投影；
- 保持 ACP wire tests 和 Desktop 兼容。

### 阶段 6：加入 WebUI

- WebUI 只连接 Core；
- 实现 Session/Run 视图、事件流、审批和取消；
- 不访问数据库和文件；
- 支持 `127.0.0.1` 和用户配置的 `0.0.0.0`；
- 认证遵循 Core 的 `auth/passwords` 配置。

### 阶段 7：收紧架构边界

- 更新 `AGENTS.md` 中“禁止 serve/Web UI 后端”的旧约束；
- 更新 architecture guard，禁止 UI、ACP 和 WebUI 直接构造 Agent；
- 禁止业务模块绕过 Core 直接操作 Session/Run 状态；
- 保留明确的迁移 allowlist，直到旧路径完全删除。

## 11. 错误处理和重连

### 11.1 Core 不可用

客户端遇到以下情况时不能静默创建本地 Runtime：

- Core 未启动；
- Core 版本不兼容；
- Core health 失败；
- 认证失败；
- Core lock 无法确认；
- 固定端口冲突且没有健康 Core。

客户端应：

1. 尝试有限次数 discovery；
2. 显示可操作的错误；
3. 保留当前 UI 状态；
4. 提供重试或 Standalone 启动选项；
5. 不绕过 Core 直接执行 Agent。

### 11.2 Core 崩溃

- 客户端检测连接断开；
- 保留未提交或待确认的 UI 状态；
- 重新发现 Core；
- 使用 Session/Run ID 和 cursor 重新连接；
- 由 Core 恢复 Session 和 Run；
- 不由客户端自行重放不确定的工具副作用。

### 11.3 ACP 断开

- ACP bridge 断开不等于 Core 关闭；
- Core 中的 Run 是否继续由 Core 生命周期策略决定；
- ACP 重连后通过 Core 查询 Session/Run 状态；
- bridge 不在本地缓存一份可独立运行的 Agent 状态。

## 12. 测试策略

### 12.1 Core 单实例测试

- 两个客户端同时 discovery，只启动一个 Core；
- Core 启动时已有健康 Core，不启动第二个；
- Core 异常退出后，下一客户端可以安全恢复；
- 旧 PID/旧注册信息不会误杀无关进程；
- 固定端口冲突时不会偷偷启动第二个 Core；
- `port: 0` 时注册实际端口并能被客户端发现。

### 12.2 Core 认证和网络测试

- `127.0.0.1` 默认行为；
- `0.0.0.0` 显式配置；
- `auth: false` 不校验密码；
- `auth: true` 且密码数组匹配；
- `auth: true` 且密码数组为空时拒绝启动；
- 错误密码不能建立 Core Client；
- 密码不出现在 URL 和注册文件。

### 12.3 ACP 兼容测试

- 现有 ACP wire fixtures 继续通过；
- ACP initialize 能力来自 Core；
- Prompt、Cancel、Approval、Question 和事件映射正确；
- ACP bridge 重启后可以重新连接 Core；
- ACP bridge 退出不会关闭全局 Core；
- Standalone ACP 退出可以关闭 Private Core。

### 12.4 Runtime 和架构测试

- TUI/CLI/ACP/WebUI 不直接构造 Agent；
- 所有 Run 持久化经过 Core Runtime；
- 所有 Session 写入经过 Core 或明确的迁移桥；
- 旧 Core 失去 lease 后不能写入；
- Standalone 与全局 Core 使用不同数据目录时互不污染；
- Core Client 重连不产生重复 Run；
- canonical event sequence 和 terminal state 保持一致。

## 13. 风险和缓解

### 13.1 迁移期间存在双路径

风险：旧入口和新 Core Client 同时存在，可能产生两套执行路径。

缓解：

- 迁移期间以 Session Lease 作为安全网；
- 每个入口迁移完成后删除直接 Runtime 构造；
- architecture guard 逐步禁止旧路径；
- 不允许“临时 fallback 直接运行 Agent”长期存在。

### 13.2 Core 成为单点故障

风险：Core 崩溃会影响所有 UI。

缓解：

- Standalone/Private Core；
- Core crash recovery；
- 持久化 Session/Run；
- WebSocket 重连和事件 cursor；
- 明确的 Core 状态和错误提示。

### 13.3 远程暴露风险

风险：`0.0.0.0` 可能把 Agent 工具执行能力暴露到网络。

缓解：

- `auth` 默认关闭但文档明确说明风险；
- 生产部署建议设置 `auth: true`；
- 密码不进入 URL；
- 后续可以在不改变 Core 协议的情况下增加 TLS、反向代理和更强身份系统。

### 13.4 Core 协议膨胀

风险：为了兼容不同 UI，Core API 逐渐变成多套协议的集合。

缓解：

- Core 只维护一套 JSON-RPC 领域协议和 canonical event；
- HTTP、WebSocket/SSE、ACP 都属于 transport adapter；
- ACP reverse request 是协议投影，不进入领域状态；
- 新增客户端优先复用 Core Client SDK。

## 14. 参考 OpenCode 的最终取舍

OpenSAC 应参考 OpenCode 的“共享后台 Core + 客户端发现 + Standalone + 统一服务 API”方向，但不应只复制注册文件机制。

推荐组合是：

```text
OpenCode 思路
  共享后台服务
  自动发现和启动
  健康检查
  Standalone
  Core Client SDK

OpenSAC 自身约束
  现有 Session/Run 数据模型
  session_runtime_leases
  ownerId + epoch + tokenHash fencing
  ACP stdio 兼容
  One Agent Core / One Agent Runtime
  TUI/CLI/WebUI/ACP 薄适配器

OpenSAC 增强
  Core 独占锁
  可配置 host/port
  auth + passwords
  ACP bridge
  Core canonical event stream
  Standalone 复用 Core
```

最终目标是：

> OpenSAC 只拥有一个真正的领域核心；用户打开多少个 TUI、CLI、WebUI 或 ACP 客户端，都只是连接到同一个 Core，而不是重新启动一套 Agent Runtime。
