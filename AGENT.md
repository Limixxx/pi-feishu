# AGENT.md

本文件面向在此仓库中工作的 AI Agent / 开发者，说明 pi-feishu 的目标、结构、核心机制与修改约定。面向用户的安装与使用说明见 [README.md](./README.md)。

## 1. 项目定位

pi-feishu 是 Pi Coding Agent 的一个扩展（Pi extension），通过飞书官方 Node.js SDK 的 WebSocket 长连接，把飞书聊天作为 Pi 的远程交互渠道：

- 飞书消息 → Pi 用户消息（`pi.sendUserMessage`）
- Pi 的 assistant 文本 / 工具执行事件 → 飞书回复、进度卡片
- 双向媒体：入站图片/文件/语音/视频下载到本地，出站通过注册工具上传并发送

单包发布，入口即源码（`main: src/index.ts`），无构建产物，依靠 `tsc --noEmit` 做类型校验。

## 2. 技术栈

| 项 | 内容 |
|----|------|
| 语言 | TypeScript（ESM，`type: module`，`module: Node16`） |
| 运行时 | Node.js |
| 飞书 SDK | `@larksuiteoapi/node-sdk`（`Client` / `WSClient` / `EventDispatcher`） |
| Pi SDK | `@earendil-works/pi-coding-agent`（peerDependency，类型来源） |
| 校验 | `npm run typecheck`（`tsc --noEmit`） |

导入相对模块时必须带 `.js` 后缀（Node16 ESM 解析规则），例如 `./feishu-client.js`。

## 3. 目录结构

```
pi-feishu/
├── src/
│   ├── index.ts          # Pi 扩展入口：配置加载、事件处理、队列、卡片编排、命令与工具注册
│   ├── feishu-client.ts  # 飞书 WebSocket 客户端封装：连接、收发、媒体、Reaction、卡片构建
│   └── types.ts          # FeishuConfig / BridgeStatus / FeishuSettingsSection
├── package.json          # pi.extensions 指向 ./src/index.ts
├── tsconfig.json         # noEmit，仅类型检查
└── README.md             # 面向用户的使用文档
```

修改功能时按职责放置：涉及飞书 API 调用的放 `feishu-client.ts`；涉及 Pi 事件、会话状态、消息编排的放 `index.ts`。

## 4. 架构与消息流

```
飞书 Bot 网关 ──WebSocket(WSClient)──> FeishuClient ──onMessage──> index.ts
                                                                      │
                                                          sendUserMessage()
                                                                      v
                                                              Pi Agent Core
                                                                      │
                                     turn_end / tool_execution_* / agent_end
                                                                      v
                                                       FeishuClient.sendMessage/sendCard
                                                                      v
                                                                    飞书
```

典型一轮对话：

1. 入站消息 → 消息去重、过期过滤、解析文本与资源
2. 加入该 chat 的队列 → 空闲则出队
3. 添加 Typing Reaction → 下载媒体 → `pi.sendUserMessage`
4. `tool_execution_start` → 创建/更新进度卡片（⏳）
5. `tool_execution_end` → 更新进度卡片（✅/❌）
6. `turn_end`：
   - 含 `toolCall` → 中间文本以 reply 模式发送到用户原消息
   - 纯文本 → 最终回复以新消息发送
   - `stopReason === "error"` → 发送 LLM 错误并停止 Typing
7. `agent_end` → 移除 Typing Reaction、清理状态、刷新所有队列

## 5. 核心机制（修改时需保持的行为）

### 5.1 配置加载

优先级从高到低：CLI 标志 → 环境变量 → settings.json 的 `feishu` 段。

- 全局：`~/.pi/agent/settings.json`
- 项目级：`<cwd>/.pi/settings.json`（覆盖全局）
- 字段支持 camelCase 与 snake_case（`appId` / `app_id`）
- 连接前会再次用 `pi.getFlag(...)` 覆盖 `config`，见 [index.ts](./src/index.ts) 中 `startFeishuClient`

### 5.2 消息队列（按 chatId 隔离）

- `chatQueues: Map<chatId, { processing, queue[] }>`
- 处理中再次收到消息 → 回复“已排队”并返回
- Pi 非空闲（`ctx.isIdle()` 为 false，如压缩/流式中）→ 不出队，`processing` 置 false，等待 `agent_end` / `session_compact` / `session_start` 触发 `flushAllQueues`
- `findActiveState()` 取 `chatStates` 中最后插入的 chat 作为“当前活跃会话”，自定义工具的默认目标聊天依赖此逻辑

### 5.3 进度卡片

- 每个 chat 一轮对话只创建 **一条** 可编辑卡片（`state.progressMsgId`）
- `progressCreating` 用于防竞态：创建中的重复事件直接跳过，创建完成后再用最新状态刷新一次
- 卡片只显示最近 10 条工具记录，超出折叠
- 卡片更新失败时清空 `progressMsgId` 以便下次重建
- 卡片为飞书 v2 schema：`{ schema: "2.0", body: { elements } }`

### 5.4 Reaction 输入指示

- 开始处理：`Typing`；成功结束：仅移除；失败：移除后加 `CrossMark`
- 删除 Reaction 必须使用创建时返回的 `reaction_id`，不能用 emoji 类型反查

### 5.5 消息去重与过期

- 去重：12h TTL、最多 5000 条、5 分钟定时清理（`unref` 不阻塞退出）
- 过期：消息创建时间超过阈值直接丢弃
- 过滤 `sender_type` 为 `bot` / `app` 的消息，避免自回环

### 5.6 文本输出处理

- `downgradeHeadings`：出站 Markdown 标题层级 +2，最高 H6，且跳过代码块内内容
- `chunkText`：超过 4000 字符按换行/空格切分
- 卡片内容超过 3500 字符截断追加 `...`
- 普通文本消息统一以 `interactive` 卡片（markdown 元素）发送

### 5.7 斜杠命令分流

以 `/` 开头的入站消息不发往 LLM，由 `handleSlashCommand` 在扩展层处理：`/new`、`/stop`、`/queue`、`/compact`、`/status`、`/help`。新增本地命令需同时更新 `/help` 文案。

### 5.8 媒体

- 入站下载目录：`os.tmpdir()/feishu-media`，文件名做字符白名单清洗
- 下载路径写回给 Pi 的文本中，形如 `[收到图片: /tmp/...]`
- 出站图片/文件先 `uploadImage` / `uploadFile` 拿 key，再 `sendImage` / `sendFile`

## 6. 对外接口清单

### Pi 命令

`/feishu start|stop|status|config|help`

### 注册的工具（供 LLM 调用）

| 工具名 | 参数 |
|--------|------|
| `send_to_feishu` | `message`（必填）、`chat_id`（可选，默认活跃会话） |
| `send_image_to_feishu` | `file_path`（必填）、`chat_id` |
| `send_file_to_feishu` | `file_path`、`file_name`（必填）、`chat_id` |

### 订阅的 Pi 事件

`session_start`、`session_shutdown`、`session_compact`、`turn_end`、`agent_end`、`tool_execution_start`、`tool_execution_end`

### 订阅的飞书事件

`im.message.receive_v1`（主逻辑）及若干空处理器占位事件，见 `FeishuClient.connect`

## 7. 开发约定

- **最小改动**：仅改与需求相关的代码，不做顺带重构
- **不加构建产物**：`dist/`、`docs/`、`reference/` 均在 `.gitignore` 中；不要提交
- **类型即文档**：对外数据结构放 `types.ts`，飞书事件结构在 `feishu-client.ts` 内部定义
- **错误容忍**：飞书侧非关键调用（Reaction、卡片更新、上传）失败时记录日志并降级，不要向上抛出中断主流程；`Client.connect()` 失败需要抛出以让上层 notify
- **日志**：`_log` 受 `DEBUG` 常量控制，`_warn` 始终输出
- **私有 API 兼容**：`patchCardEvents` 覆写了 SDK 内部的 `handleEventData`，升级 `@larksuiteoapi/node-sdk` 时需重点回归卡片事件
- **业务文案**：面向用户的中文提示保持简洁；命令帮助文案与 README 表格需同步

## 8. 验证方式

```bash
npm install
npm run typecheck
pi -e ./src/index.ts --feishu-app-id=YOUR_ID --feishu-app-secret=YOUR_SECRET
```

运行时自查顺序：状态栏显示“飞书: 已连接” → 私聊发一条文本收到回复 → 触发工具调用观察到进度卡片原地更新 → 发送图片/文件验证双向媒体 → `/status` 查看连接与上下文用量。
