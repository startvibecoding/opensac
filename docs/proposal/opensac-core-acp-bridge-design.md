# OpenSAC ACP Core Bridge 设计方案

- 状态：设计提案
- 日期：2026-09-25
- 目标：将现有 ACP 入口迁移为全局 Core 的薄协议桥接层
- 前置设计：`docs/proposal/opensac-core-runtime-design.md`

## 1. 目标

第二阶段将 `opensac acp` 从“直接拥有 Agent、Session、Run、Provider、MCP 和 Runtime 生命周期的 ACP Server”迁移为：

```text
ACP Client
    │ 现有 stdio NDJSON/JSON-RPC
    ▼
opensac acp bridge
    │ Core JSON-RPC
    ▼
OpenSAC Core Runtime Host
    ├── SessionRuntime
    ├── AgentManager
    ├── ExecutionRuntime / RunStore
    ├── Provider / MCP / Registry
    ├── Approval / Question / Decisions
    └── Session / Run persistence
```

目标约束：

1. ACP wire protocol 保持兼容；
2. Desktop 仍通过 `opensac acp` 启动，不需要改 ACP 客户端协议；
3. ACP bridge 不创建 Agent、Provider、MCP、SessionRuntime 或 Durable Run；
4. Core 是 ACP、TUI、CLI 和 WebUI 未来共同使用的唯一 Runtime owner；
5. ACP 断开不关闭全局 Core；
6. ACP 重连后可以恢复 Session/Run 状态；
7. Core 的事件、审批和问题请求必须保持顺序和终态语义；
8. 不修改现有 `sessions.db` 和 `session_runtime_leases` 的持久化模型。

## 2. 非目标

本阶段不处理：

- TUI 迁移到 Core Client；
- CLI Print 迁移到 Core Client；
- WebUI；
- `sdk/` 公共 API；
- 重新设计 `sessions.db`；
- 重新设计 `session_runtime_leases`；
- 修改 ACP 外部协议版本；
- 删除现有 ACP 兼容字段和扩展方法。

## 3. 方案选择

### 3.1 采用：ACP 薄桥接 + Core 领域 RPC

ACP bridge 只做：

- stdio framing；
- ACP JSON-RPC envelope 编解码；
- ACP request ID 的原样保存和回显；
- ACP method 到 Core method 的映射；
- Core event 到 ACP notification 的映射；
- Core reverse request 到 ACP reverse request 的映射；
- ACP 错误码和结构化错误映射；
- Core 断线、重连和退出处理。

ACP bridge 不拥有任何领域状态。

### 3.2 不采用：Core 直接托管旧 `AcpServer`

这种方式虽然迁移速度快，但会让 Core 内部继续耦合 ACP wire 语义，导致 TUI、CLI 和 WebUI 需要第二套 Core API。长期会形成两个入口模型，因此不采用。

### 3.3 不采用：ACP 暂时保留 Runtime 所有权

这会直接违反 One Core 目标，也会导致 Core 和 ACP 各自拥有 Session/Run 生命周期，因此不采用。

## 4. Core Runtime Host

Core 目前已经拥有进程发现、注册、锁、HTTP JSON-RPC transport 和 `core.health/core.info`。第二阶段新增 `CoreRuntimeHost`，作为 Core 进程内的领域宿主。

Core Runtime Host 负责：

- 加载共享 Settings、Provider、Sandbox、Skills、Context；
- 解析 ACP、TUI、CLI 和 WebUI 的统一 Runtime Source/Policy；
- 创建和缓存 Provider catalog；
- 创建和复用 SessionRuntime；
- 创建和复用 AgentManager；
- 处理 Session、Run、Input、Attachment 和 Decision；
- 管理 Approval/Question 生命周期；
- 推送 canonical event；
- 恢复 orphan Run；
- 统一 shutdown。

Core Runtime Host 不应依赖 ACP 类型。ACP 专用类型只能存在于 `src/acp/`。

## 5. Core 领域 RPC

### 5.1 生命周期和能力

```text
core.health
core.info
core.shutdown
```

`core.info` 返回 Core 能力和协议版本，不返回密码、路径、PID 或 Provider 私密配置。

### 5.2 Session

```text
session.create
session.open
session.close
session.list
session.history
session.config.get
session.config.set
```

`session.create/open` 接收统一的 Runtime source、policy、workDir、provider/model、capabilities 和 input 参数。ACP 的 `session/new` 只能作为外部协议映射，不能直接决定 Runtime 内部 ownership。

### 5.3 Prompt、Run 和事件

```text
session.prompt
run.status
run.cancel
run.events.subscribe
run.events.replay
```

Core prompt 请求返回 Run 身份或 admission 结果，实际流式内容通过 Core event notification 发送。

事件必须包含：

```text
sessionId
runId
sequence
eventType
payload
```

流式事件规则：

- `TextDelta` 和 `ReasoningDelta` 独立发送；
- 不把流式事件放入 JSON-RPC batch；
- sequence 在单个 Run 内单调递增；
- 断线后使用 `run.events.replay(cursor)` 补发；
- terminal event 只能发送一次。

### 5.4 Approval 和 Question

```text
approval.request
approval.resolve
question.request
question.resolve
```

Core 发出 server-to-client JSON-RPC request，Core Runtime Host 等待带同一 request ID 的客户端 response。response 之后由 Core 更新 DecisionService，不允许 ACP bridge 自己决定最终状态。

### 5.5 附件、项目和扩展

现有 ACP 扩展先通过 Core 领域 API 提供：

```text
attachment.list
attachment.fetch
project.*
manage.*
```

ACP bridge 只负责将 Core 返回值转换为现有 ACP wire shape。Core 不返回 ACP 专用对象，ACP 也不直接访问数据库或 Session 文件。

## 6. ACP Bridge 结构

建议新增：

```text
src/acp/bridge.ts
src/acp/bridge_client.ts
src/acp/bridge_protocol.ts
src/acp/bridge_test.ts
```

职责划分：

### `bridge.ts`

负责 ACP 进程生命周期：

1. 解析 CLI options；
2. discovery/连接全局 Core；
3. 启动 ACP stdio dispatch loop；
4. Core 断开时进入可诊断状态；
5. EOF、SIGINT、SIGTERM 时关闭 ACP bridge，但默认不关闭全局 Core。

### `bridge_protocol.ts`

负责 ACP wire 映射：

- ACP request → Core request；
- Core response → ACP response；
- Core notification → ACP `session/update`；
- Core approval/question request → ACP reverse request；
- ACP response → Core response；
- ACP error → Core error；
- Core error → ACP error。

### `bridge_client.ts`

负责 Core 连接：

- CoreClient discovery；
- Core health/info 校验；
- JSON-RPC request/response；
- event subscription；
- reverse request correlation；
- reconnect 和 cursor replay。

### 旧 `run.ts` / `server.ts`

迁移后不再创建领域 Runtime。保留必要的 ACP transport、初始化和兼容入口，避免一次性重写所有 ACP wire 类型。

## 7. ACP 方法映射

| ACP 方法 | Core 方法 | 说明 |
|---|---|---|
| `initialize` | `core.info` + bridge capability negotiation | 返回兼容 capabilities |
| `session/new` | `session.create` | ACP session ID 映射 Core Session ID |
| `session/load` | `session.open` | 重新连接已有 Session |
| `session/prompt` | `session.prompt` | 返回 admission/Run 身份，事件异步推送 |
| `session/cancel` | `run.cancel` | 取消 Core 当前 Run |
| `session/set_config_option` | `session.config.set` | 通过 Core policy resolver |
| `session/set_mode` | `session.config.set` | Core 统一解析 mode |
| `session/updates` | `run.events.subscribe/replay` | ACP notification 投影 |
| `permission/request` | `approval.request/resolve` | Core 反向请求 |
| `question/request` | `question.request/resolve` | Core 反向请求 |
| `fs/read_text_file` | Core attachment/file API | 不允许 bridge 直接读文件 |
| `fs/write_text_file` | Core file/attachment API | 不允许 bridge 直接写文件 |
| `opensac/manage/*` | `manage.*` | ACP 扩展映射 |

## 8. 事件投影

Core event 不直接等于 ACP event。Core 维护 canonical event，bridge 使用确定性 projection：

```text
Core TextDelta
    → ACP session/update: agent_message_chunk

Core ToolCallStarted
    → ACP session/update: tool_call

Core ApprovalRequested
    → ACP session/requestPermission reverse request

Core QuestionRequested
    → ACP session/requestQuestion reverse request

Core RunFinished
    → ACP session/update: run status + prompt response terminal state
```

Projection 必须保持：

- Session ID；
- Run ID；
- message ID；
- tool call ID；
- sequence；
- terminal state；
-错误/取消/超时语义。

## 9. 生命周期和错误处理

### 9.1 启动

```text
读取 Core 配置
    ↓
Core discovery
    ↓
Core health/info 校验
    ↓
Core JSON-RPC handshake
    ↓
建立 Core event subscription
    ↓
进入 ACP initialize gate
```

ACP 在 Core 不可用时：

- 不创建本地 Agent；
- 不静默退回旧 Runtime；
- 输出结构化启动错误；
- 允许客户端修复 Core 后重试。

### 9.2 ACP EOF

ACP bridge 退出时：

- 关闭 Core Client；
- 取消本地 event subscription；
- 不关闭全局 Core；
- 不删除 Core registration；
- 不终止 Core 中其他客户端的 Run。

### 9.3 Core 崩溃

ACP bridge：

- 保留未完成 request ID；
- 将连接错误投影为结构化 ACP 错误；
- 不在本地重放工具调用；
- 允许重连后通过 Session/Run cursor 查询 Core 状态；
- 如果 Core 重启后 Run 已被恢复，则继续投影同一 canonical event。

### 9.4 Approval/Question 中断

如果 ACP client 在审批期间断开：

- Core 保持 Decision pending；
- bridge 记录 pending reverse request；
- 重连后根据 Decision ID 查询状态；
- 不自动批准或拒绝；
- 超过原有 deadline 后由 Core 依据统一 policy 终止。

## 10. 迁移阶段

### 阶段 1：Core Host 基础能力

- 新增 Core Runtime Host；
- 迁移 provider/sandbox/skills/context 初始化；
- 迁移 SessionRuntime 和 AgentManager 创建；
- 保持 Core 不依赖 ACP。

### 阶段 2：Core Prompt/Run/Event

- 新增 Session/Run/Prompt RPC；
- 新增 event subscribe/replay；
- 新增 cancel；
- 覆盖真实 SessionRuntime 和 RunStore。

### 阶段 3：ACP Bridge Prompt Vertical Slice

- 改造 `runACP` 为 Core Client；
- 保留 `initialize/session/new/session/prompt/session/cancel`；
- 迁移 Text/Reasoning/Tool/Run terminal event；
- 迁移 Approval/Question reverse request。

### 阶段 4：ACP 扩展迁移

- session history/list；
- config/mode；
- attachment；
- project；
- manage；
- deadline reminder；
- external run status。

### 阶段 5：移除 ACP Runtime 所有权

- 删除 ACP 进程内 Provider/Agent/SessionRuntime 创建；
- 更新 architecture guard；
- 保留 ACP wire compatibility tests；
- 增加 Core/ACP contract tests。

### 阶段 6：Standalone

- `opensac acp --standalone` 启动隔离 Core；
- bridge 连接 Private Core；
- EOF 时关闭 Private Core；
- 全局 Core 模式下 EOF 不关闭共享 Core。

## 11. 测试策略

### 11.1 ACP wire compatibility

现有 fixtures 必须保持：

- JSON-RPC 2.0；
- initialize-first；
- raw ID echo；
- blank line tolerance；
- unknown method error；
- EOF shutdown；
- prompt response shape；
- session/update shape；
- reverse request shape。

### 11.2 Core/ACP contract

至少覆盖：

- `session/new` → `session.create`；
- `session/prompt` → `session.prompt`；
- Core event → ACP update；
- ACP cancel → Core run.cancel；
- Core approval → ACP reverse request → Core resolve；
- Core question → ACP reverse request → Core resolve；
- ACP disconnect 不关闭 Core；
- ACP reconnect 使用 cursor 恢复事件；
- Desktop ACP 启动方式不变。

### 11.3 Runtime ownership

通过静态 architecture guard 禁止：

```text
src/acp/* 直接 new Agent
src/acp/* 直接 createAgentManager
src/acp/* 直接 new SessionRuntime
src/acp/* 直接创建 Provider/MCP
src/acp/* 直接写 Session/Run/Decision
```

允许 ACP 只依赖 Core Client、wire 和 projection。

### 11.4 进程和故障测试

- Core 不可用；
- Core 版本不兼容；
- Core 认证失败；
- Core 崩溃和重启；
- ACP EOF；
- approval pending 时 ACP 断开；
- event replay；
- Standalone Core 退出；
- 多 ACP client 共享 Core。

## 12. 验收标准

第二阶段完成必须满足：

1. `opensac acp` 原有 wire protocol 和 Desktop 启动方式保持兼容；
2. ACP 进程不再创建 Agent、Provider、MCP、SessionRuntime 或 Durable Run；
3. ACP 的 prompt、cancel、event、approval、question 全部通过 Core；
4. ACP bridge 不直接访问数据库、Session 文件或 Runtime lease；
5. Core 事件到 ACP projection 的 ID、sequence 和 terminal state 保持一致；
6. ACP 断开不关闭全局 Core；
7. ACP 重连可恢复 pending Run 和事件 cursor；
8. Standalone ACP 使用隔离 Core；
9. architecture guard 和跨入口 contract tests 通过；
10. 原有 ACP wire tests、Core tests、full test suite、check、lint 和 format 全部通过。

## 13. 后续阶段

ACP Bridge 完成后：

1. TUI 迁移为 Core Client；
2. CLI Print 迁移为 Core Client；
3. WebUI 作为 Core JSON-RPC projection；
4. 评估是否需要独立 Core Client SDK 包；
5. 在所有入口迁移完成后收紧旧的直接 Runtime 构造路径。
