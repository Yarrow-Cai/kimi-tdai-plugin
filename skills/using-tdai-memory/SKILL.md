---
name: using-tdai-memory
description: TDAI 长期记忆的工具与配置手册（L0 对话 / L1 原子记忆 / L2 场景 / L3 画像 / 团队技能库 / 知识库 Wiki）。需要调整召回行为（每会话一次 vs 每轮、A/B 模式、关掉自动注入）、开关 Wiki 知识库、改配置文件，或排查召回/写入异常时用它；用户提到“记一下/记住/上次/我的偏好/你还记得吗/我们团队怎么做/查下文档”时也用它。
---

# TDAI 长期记忆

常驻约定（注入时机、克制原则、敏感信息、agent 作用域）写在插件的**系统提示词**里（`SYSTEM.md`），此处不重复。本技能是**工具与配置手册**，会话启动时加载一次。

## 工具

| 工具 | 何时用 |
| --- | --- |
| `tdai_search` | 主动检索 L1 原子记忆 + L0 历史对话（首条消息之后的召回全靠它） |
| `tdai_scene_read` | 注入的【历史场景索引】里有相关场景，需要看全文时按 path 读取 |
| `tdai_skill_search` | 搜团队技能库：团队规范、既有做法、踩坑经验 |
| `tdai_skill_view` | 查看某个技能的 SKILL.md 正文（可带 manifest） |
| `tdai_skill_files_read` | 读取技能附带的资源文件 |
| `tdai_skill_extract` | 用户明确要求“把这次的做法沉淀成技能”时提交抽取任务 |
| `tdai_remember` | 用户明确说“记住/记一下/以后都这样”时写入 L0 |
| `tdai_status` | 排查配置、项目 agent 绑定与连通性 |

## Wiki 知识库工具（默认关闭）

`wikiEnabled: true` 之后工具列表里会出现 8 个 `tdai_wiki_*`：

| 工具 | 何时用 |
| --- | --- |
| `tdai_wiki_list` | 先列出团队有哪些知识库，拿到 `wiki_id` |
| `tdai_wiki_search` | 在某个知识库里检索页面 |
| `tdai_wiki_page_read` | 按 ref 读取页面全文 |
| `tdai_wiki_page_write` | 写/更新页面——**团队共享内容，动手前先跟用户确认 ref 与正文** |
| `tdai_wiki_raw_write` | 上传原始素材（加工第一步） |
| `tdai_wiki_ingest` | 触发服务端 LLM 异步加工（素材 → 页面） |
| `tdai_wiki_create` | 用户明确要求时才新建知识库 |
| `tdai_wiki_delete` | **不可恢复**，只有用户点名具体 `wiki_id` 才可调用，禁止自行推测 |

## 配置

配置文件：`~/.kimi-code/tdai-plugin/config.json`（`$KIMI_CODE_HOME` 或 `TDAI_MEMORY_DATA_DIR` 可改根目录）。

**生效时机**：hook 每次事件都是独立新进程、重读配置，改完**下一条消息就生效**；而 `SYSTEM.md`、`SKILL.md`、`kimi.plugin.json` 由宿主在安装/重载时读取，要 `/plugins reload` 或开新会话。

### 召回行为（最常调）

| 想要的 | 怎么配 |
| --- | --- |
| **A（默认）**：每会话第一条消息注入完整块（L1/L0 + 画像 + 场景），之后静默 | `recallOncePerSession: true` + `staticRecall: false` |
| **B**：第一条消息只注入 L3 画像 + L2 场景索引，L1/L0 全靠按需 `tdai_search` | `recallOncePerSession: true` + `staticRecall: true` |
| 旧行为：每轮都注入（注入块留在历史里逐轮累积，吃上下文） | `recallOncePerSession: false` |
| 完全不自动注入，一切按需 | `autoRecall: false` |
| 只关掉捕获（不再写 L0） | `autoCapture: false` |

### 其余字段

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `endpoint` / `hubPort` | `http://127.0.0.1:8420` / `8424` | MemoryCore 地址；Wiki 层由 core 端口推导到 hub 端口 |
| `apiKey` / `gatewayToken` | 空 | 数据层 Bearer；填了 `gatewayToken` 即切 Gateway 模式（所有层走网关路由） |
| `teamId` / `userId` / `agentId` | 空 | 记忆归属；`agentId` 留空且 `autoAgent: true` 时按项目目录自动绑定 |
| `recallLimit` / `recallMaxChars` | 6 / 2000 | 每轮召回条数；注入块总字符上限（省上下文主要调这个） |
| `includePersona` / `includeSceneNav` | true | 是否注入 L3 画像 / L2 场景索引 |
| `includePersonaMaxChars` / `includeSceneMaxLines` | 800 / 12 | 上面两项各自的注入上限 |
| `profileCacheTtlMs` | 600000 | 画像/场景落盘缓存 TTL（新会话清零重拉） |
| `maxMessageChars` / `timeoutMs` | 4000 / 4000 | 单条消息写入 L0 前的截断长度；单次 HTTP 超时（毫秒） |
| `wikiEnabled` | false | 是否注册上面那 8 个知识库工具 |
| `serviceId` | `default` | 作为 `x-tdai-service-id` 请求头发送 |

### 环境变量（覆盖同名配置）

地址与身份：`TDAI_MEMORY_ENDPOINT`、`TDAI_MEMORY_API_KEY`（不想把密钥明文写进 config.json 就用它）、`TDAI_MEMORY_GATEWAY_TOKEN`、`TDAI_MEMORY_INSTANCE_ID`、`TDAI_MEMORY_TEAM_ID`、`TDAI_MEMORY_USER_ID`、`TDAI_MEMORY_AGENT_ID`、`TDAI_MEMORY_HUB_PORT`、`TDAI_MEMORY_DATA_DIR`。
开关：`TDAI_MEMORY_AUTO_AGENT=0`、`TDAI_MEMORY_WIKI=1`、`TDAI_MEMORY_RECALL_ONCE=0`、`TDAI_MEMORY_RECALL_STATIC=1`、`TDAI_MEMORY_DISABLED=1`、`TDAI_MEMORY_DEBUG=1`。

## 排查

- 手动 CLI（在插件根目录跑）：`node bin/tdai.mjs status | health | agents | search "..." [--limit N] | remember "..." | scene <path> | skills "..." | skill <id> | wikis | wiki-search <id> "..." | wiki-read <id> <ref>`。
  - `status` 看配置摘要、模式、hub 地址与项目 agent 名；`health` 看服务端连通性；`agents` 看已绑定的 agent。
- 日志在 `~/.kimi-code/tdai-plugin/logs/`：`hook-events.log` 是每次 hook 触发的痕迹（事件名、payload 键名、prompt 类型与长度、进程 cwd），用来确认事件到底有没有被触发；`tdai-YYYY-MM-DD.log` 是召回/写入的错误与摘要。
- 状态与缓存：`~/.kimi-code/tdai-plugin/state/<session_id>.json`（`pending` 待上传消息、`recallDone` 本会话是否已注入过召回块）；`cache/<session_id>.profile.json`（画像/场景缓存）。
- 召回块只在 `UserPromptSubmit` 打到 stdout；其余事件静默；一切失败 fail-open（出错就跳过，不阻塞对话）。
- 手工验证 hook：`echo '{"hook_event_name":"UserPromptSubmit","session_id":"s1","prompt":"上次那个问题怎么解决的","cwd":"E:\\proj\\demo"}' | node hooks/hook.mjs UserPromptSubmit`。同一 `session_id` 再跑一次：第一条应打出 `<tdai_memory>` 块，第二条静默（`recallOncePerSession` 生效）。
