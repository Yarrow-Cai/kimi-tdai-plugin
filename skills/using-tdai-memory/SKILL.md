---
name: using-tdai-memory
description: 使用 TDAI 长期记忆（L0 对话 / L1 原子记忆 / L2 场景 / L3 画像 / 团队技能库 / 知识库 Wiki）。每轮对话前会自动注入相关记忆，可用 tdai_search、tdai_skill_search、tdai_wiki_search 等工具主动检索，tdai_remember 显式保存。当用户提到“之前说过/记一下/记住/上次/我的偏好/你还记得吗/我们团队怎么做/查下文档”或需要跨会话、跨项目经验时使用。
---

# 使用 TDAI 长期记忆

当前环境已接入 TDAI（TencentDB Agent Memory）。下面三件事是**自动**的，不要重复做：

- **召回**：用户每次发消息前，插件会把检索到的内容以 `<tdai_memory>` 块注入上下文（可能包含 L1 原子记忆、L0 历史对话、【用户画像】、【历史场景索引】）。看到这个块就当已知背景使用，不必说明来源。
- **捕获**：用户输入和你的最终回复会自动写入 L0。**不要**再用工具把这些内容重复保存一遍。
- **沉淀**：写入后由 TDAI 管线异步抽取 L1/L2/L3 与技能，存在延迟，刚写入的内容不会立刻被检索到。

可主动调用的工具：

| 工具 | 何时用 |
| --- | --- |
| `tdai_search` | 自动召回不够，或用户问“你还记得吗/之前那个……”时主动查 L1 + L0 |
| `tdai_scene_read` | 注入的【历史场景索引】里有相关场景，需要看全文时按 path 读取 |
| `tdai_skill_search` | 涉及团队规范、既有做法、踩坑经验；“我们之前怎么处理的” |
| `tdai_skill_view` | 查看某个技能的 SKILL.md 正文 |
| `tdai_skill_files_read` | 读取技能附带的资源文件 |
| `tdai_skill_extract` | 用户明确要求“把这次的做法沉淀成技能”时提交抽取任务 |
| `tdai_remember` | 用户明确说“记住/记一下/以后都这样”时写入 L0 |
| `tdai_status` | 检索/写入异常时排查连接、身份与 agent 绑定 |

如果工具列表里还有 `tdai_wiki_*`（知识库默认关闭，开启后可见）：

| 工具 | 何时用 |
| --- | --- |
| `tdai_wiki_list` | 先列团队有哪些知识库，拿到 `wiki_id` |
| `tdai_wiki_search` | 在某个知识库里查页面（团队文档、规范、沉淀资料） |
| `tdai_wiki_page_read` | 按 ref 读页面全文 |
| `tdai_wiki_page_write` | 写/更新页面——**团队共享内容，动手前先跟用户确认 ref 与正文** |
| `tdai_wiki_raw_write` | 上传原始素材（加工第一步） |
| `tdai_wiki_ingest` | 触发服务端 LLM 异步加工（素材 → 页面） |
| `tdai_wiki_create` | 用户明确要求时才新建知识库 |
| `tdai_wiki_delete` | **不可恢复**，只有用户点名具体 `wiki_id` 才可调用，禁止自行推测 |

其它注意事项：

- 记忆与技能内容可能过时；与当前代码、文件冲突时以现场为准，并可以向用户确认。
- 每轮最多做 3 次记忆类工具调用；不要把记忆/技能/文档内容原样回显给用户。
- 不要记忆密钥、令牌、口令等敏感内容。
- agent 是**按项目目录自动绑定**的（`kimi-<目录名>-<哈希>`），记忆按 agent 隔离，换项目就看到不同记忆；也可以配 `agentId` 固定绑定。
- 手动调试：`node bin/tdai.mjs status | health | agents | search "..." | scene "..." | skills "..." | skill <id> | wikis | wiki-search <id> "..." | wiki-read <id> <ref>`。
