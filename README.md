# kimi-tdai-plugin — Kimi Code 的 TDAI 长期记忆插件

路线 A 的实现：Kimi Code 插件（hooks 自动召回 / 自动捕获 + MCP 工具），直连 TDAI MemoryCore 的 HTTP API，不依赖 Memory Proxy。

参考实现：[vaynebobby-crypto/pi-tdai-team-memory](https://github.com/vaynebobby-crypto/pi-tdai-team-memory)（pi coding agent 的同类扩展）。本插件沿用了它的这些做法：写库前清洗注入块、ISO 时间戳、按服务端上限分片、失败回合跳过、L2/L3 召回与缓存、Gateway 双凭证鉴权、按项目目录派生并绑定 agent、团队技能库与 Wiki 知识库接口。

```
会话开始 ──▶ SessionStart      初始化状态 + 绑定项目 agent
用户发言 ──▶ UserPromptSubmit  L1 原子记忆 + L0 历史对话 + L3 画像 + L2 场景索引
                               → 以 <tdai_memory> 块注入上下文（画像/场景走 10 分钟缓存）
模型收尾 ──▶ Stop              本轮用户消息 + 最终回复 → /v3/conversation/add（L0）
                               同时喂 /v3/skill/conversation/add（触发技能抽取）
中断/失败 ─▶ Interrupt/StopFailure  丢弃本轮，不写 L0
压缩/结束 ─▶ PreCompact/SessionEnd  兜底刷新，清状态
随时      ──▶ MCP 工具：记忆/场景/技能库 8 个（Wiki 知识库 8 个默认关闭）
```

## 目录

| 路径 | 作用 |
| --- | --- |
| `kimi.plugin.json` | 插件清单（skills / commands / mcpServers / 7 个 hooks） |
| `hooks/hook.mjs` | 所有 hook 的统一入口，按 argv[2] 分派事件 |
| `core/mcp_server.mjs` | 零依赖 MCP stdio server（基础 8 工具 + 可选 8 个 Wiki 工具） |
| `lib/tdai.mjs` | MemoryCore HTTP 客户端：数据层 / meta 层 / Wiki 层三套鉴权，清洗·截断·分片，hub 端口推导 |
| `lib/agent.mjs` | 项目级 agent 自动绑定：按 cwd 派生名字、查/建、落盘缓存 |
| `lib/sanitize.mjs` | 写 L0 前的文本清洗（剥离注入块、过滤命令与噪声） |
| `lib/cache.mjs` | L3 画像 / L2 场景索引的落盘缓存（TTL 内不再重复请求） |
| `lib/session.mjs` | 定位会话目录、解析 `agents/main/wire.jsonl` 取最后一条完整回复 |
| `skills/using-tdai-memory/` | 会话启动时自动加载，教模型用这些工具、别重复保存 |
| `commands/` | `/tdai-memory:recall`、`/tdai-memory:remember` |
| `bin/tdai.mjs` | 手动调试 CLI（不入 hook 链路） |

## 前置条件

1. **TDAI MemoryCore 可访问**，默认 `http://127.0.0.1:8420`，`GET /health` 能通。
2. **Node ≥ 18**（hook 与 MCP 都以 `node` 启动，需在 PATH 上）。
3. **`apiKey`**：直连模式作数据层 Bearer；开了 `autoAgent` 时还用于 meta 层 `x-tdai-user-key`（agent 查/建）。
4. 要用 **Wiki 知识库**：直连模式需 hub 容器可达（默认 `core 端口 → 8424`，可用 `hubPort` 改）；Gateway 模式下由网关统一路由，不用管端口。

## 安装

```text
# 方式一：从 GitHub 安装（推荐，之后可随仓库更新）
/plugins install https://github.com/Yarrow-Cai/kimi-tdai-plugin

# 方式二：从本地目录安装
/plugins install <本仓库目录>

/reload          # 或 /new，插件变更不热更新到当前会话
/plugins info tdai-memory
```

## 配置

复制 `config.example.json` 到 `~/.kimi-code/tdai-plugin/config.json`，至少填 `teamId` / `userId`（外加 `apiKey`；`agentId` 可留空走自动绑定）：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `endpoint` | `http://127.0.0.1:8420` | MemoryCore 地址（尾部斜杠自动去掉） |
| `hubPort` | 8424 | Wiki 层端口（直连模式由 `endpoint` 推导；Gateway 模式忽略） |
| `apiKey` | 空 | 数据层 Bearer + meta 层 `x-tdai-user-key` |
| `gatewayToken` | 空 | **填了就切 Gateway 模式**：所有层 Bearer 用它，`apiKey` 只用于 meta 层 |
| `serviceId` | `default` | 作为 `x-tdai-service-id` 头 |
| `teamId` / `userId` | 空 | 记忆归属（必填） |
| `agentId` | 空 | **固定绑定**；填了就不再自动解析项目 agent |
| `autoAgent` | true | 按项目目录自动查/建 agent（`agentId` 为空时生效） |
| `wikiEnabled` | false | 是否注册 Wiki 知识库工具（8 个；开启后模型可读写团队知识库） |
| `recallLimit` | 6 | 每轮召回 L1 条数 |
| `recallMaxChars` | 2000 | 注入块总字符上限 |
| `timeoutMs` | 4000 | 单次 HTTP 超时 |
| `maxMessageChars` | 4000 | 单条消息写入 L0 前的截断长度 |
| `includePersona` / `includeSceneNav` | true | 是否注入 L3 画像 / L2 场景索引 |
| `includePersonaMaxChars` / `includeSceneMaxLines` | 800 / 12 | 画像与场景索引的注入上限 |
| `profileCacheTtlMs` | 600000 | 画像/场景缓存 TTL（新会话开始时重置） |
| `autoRecall` / `autoCapture` | true | 分别开关召回、捕获 |

环境变量覆盖：`TDAI_MEMORY_ENDPOINT`、`TDAI_MEMORY_API_KEY`、`TDAI_MEMORY_GATEWAY_TOKEN`、`TDAI_MEMORY_INSTANCE_ID`、`TDAI_MEMORY_TEAM_ID`、`TDAI_MEMORY_USER_ID`、`TDAI_MEMORY_AGENT_ID`、`TDAI_MEMORY_HUB_PORT`；另有 `TDAI_MEMORY_AUTO_AGENT=0`、`TDAI_MEMORY_WIKI=1`、`TDAI_MEMORY_DISABLED=1`、`TDAI_MEMORY_DEBUG=1`、`TDAI_MEMORY_DATA_DIR`。

## 项目级 agent 自动绑定

`agentId` 留空且 `autoAgent` 打开时，插件按会话工作目录（hook payload 的 `cwd`）派生 agent 名：

```
kimi-<目录名，保留字母数字-_，截断 24 字符>-<cwd 的 SHA-256 前 8 位>
例：E:\proj\gd32-can  →  kimi-gd32-can-2d60179d
```

先查（`/v3/meta/agent/list`）→ 命中 active 复用 → 没有就建（`/v3/meta/agent/create`，同名并发冲突重查一次）→ 结果写 `~/.kimi-code/tdai-plugin/agents.json`，之后每个 hook 只读缓存。不同项目目录 → 不同 agent → 记忆隔离；想统一就填 `agentId`。

## 工具（MCP server `tdai`）

基础 8 个：

| 工具 | 用途 |
| --- | --- |
| `tdai_search` | 检索 L1 原子记忆 + L0 历史对话 |
| `tdai_remember` | 把一条信息写入 L0（异步沉淀） |
| `tdai_scene_read` | 按 path 读 L2 场景全文 |
| `tdai_skill_search` | 搜团队技能库 |
| `tdai_skill_view` | 看技能 SKILL.md（可选 manifest） |
| `tdai_skill_files_read` | 读技能资源文件 |
| `tdai_skill_extract` | 从给定内容抽取技能（服务端异步） |
| `tdai_status` | 配置 / agent 绑定 / 连通性排查 |

`wikiEnabled=true` 时额外注册 8 个知识库工具（`tdai_wiki_*`）：`list`（列团队知识库）、`search`（库内检索）、`page_read`（按 ref 读页）、`page_write`（写/更新页）、`raw_write`（上传素材）、`ingest`（触发 LLM 加工）、`create`（幂等新建）、`delete`（批量删除，破坏性）。未开启时调用会返回明确的错误提示。

**Wiki 层细节**：直连模式请求发往 hub 地址（默认由 core 端口推导成 8424）；Gateway 模式走同一 `endpoint` 由网关路由。鉴权用 Bearer + `x-tdai-service-id`，body 只带 `team_id`（不带 agent 三元组）；成功码接受 `code=0` 或 `code=200`。

## 验证

```bash
node bin/tdai.mjs status          # 配置 + 模式 + hub 地址 + 项目 agent 名
node bin/tdai.mjs health | agents
node bin/tdai.mjs search "关键词" [--limit N]
node bin/tdai.mjs remember "内容"
node bin/tdai.mjs scene "projects/xxx"
node bin/tdai.mjs skills "关键词" | skill <skill_id> [--manifest]
node bin/tdai.mjs wikis | wiki-search <wiki_id> "关键词"
node bin/tdai.mjs wiki-read <wiki_id> <ref...>
node bin/tdai.mjs wiki-create "知识库名"
node bin/tdai.mjs wiki-page-write <wiki_id> <ref> <md 文件路径>
node bin/tdai.mjs wiki-ingest <wiki_id>

# 模拟 hook（不依赖 Kimi Code）
echo '{"hook_event_name":"UserPromptSubmit","session_id":"s1","prompt":"上次那个问题怎么解决的","cwd":"E:\\proj\\demo"}' | node hooks/hook.mjs UserPromptSubmit
```

召回注入块只在 `UserPromptSubmit` 打到 stdout，其余事件静默；一切失败 fail-open，日志在 `~/.kimi-code/tdai-plugin/logs/`。

## 写入 L0 的处理链

剥离 `<tdai_memory>` 等注入标签块（防 recall→capture 回流）→ 去掉 `/` 开头的命令与框架噪声 → 合并多余空行 → 按 `maxMessageChars` 截断 → 补 ISO 时间戳（后端拒收数字时间戳）→ 按 100 条/请求分片（技能缓冲 500 条/请求）→ 清洗后没有用户消息则整轮丢弃。被中断或失败的回合不写。

## 已知限制

- **只捕获用户输入 + 最终回复**，工具调用不进 L0；要加就补 `PostToolUse` hook（`/v3/conversation/add` 只收 user/assistant，工具事件要走 skill 通道）。
- **代码块不剥离**（与参考项目相反，有意为之）：代码 agent 的关键结论常在代码块里，靠 `maxMessageChars` 截断兜底。
- `tdai_remember` 写的是 **L0**，TDAI 管线异步抽取成 L1/L2/L3，刚写入的内容不会立刻被检索到。
- **Wiki 工具默认关闭**：写页面/删库是对团队共享知识库的写操作，开启前请确认服务端权限与使用规范。
- MCP 进程没有会话信息，项目 agent 靠 `process.cwd()` 或最近一次 hook 记录的目录推断；多项目并发时若 cwd 不可用可能绑错，这种情况建议配固定 `agentId`。
- 插件运行的是 `$KIMI_CODE_HOME/plugins/managed/tdai-memory/` 下的**托管副本**：改桌面这份源码后需要重新 `/plugins install`。
