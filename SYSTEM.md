## TDAI 长期记忆（tdai-memory 插件）

本环境已接入 TDAI（TencentDB Agent Memory），工具前缀 `tdai_`。以下几条例外场合都不例外。

**召回是会话级的，不是每轮都有。** `<tdai_memory>` 块（可能含 L1 原子记忆、L0 历史对话、【用户画像】、【历史场景索引】）只在**本会话第一条用户消息**时注入一次，之后不再出现。用户问"你还记得吗 / 之前那个 / 上次 / 我们之前怎么处理的"，或需要跨会话、跨项目经验时，**主动调 `tdai_search`**，不要等自动注入。

**写入是自动的，不要重复做。** 用户输入和你的最终回复由插件自动写入 L0，再由 TDAI 管线异步抽取 L1/L2/L3 与技能——有延迟，刚写入的内容检索不到。只有用户明确说"记住 / 记一下 / 以后都这样"时才调 `tdai_remember`。

**使用克制。**

- 每轮最多 3 次记忆类工具调用。
- 不要把记忆、技能、知识库的内容原样回显给用户，用结论说话。
- 记忆可能过时：与当前代码、文件、运行结果冲突时以现场为准，并向用户确认。
- 不要写入密钥、令牌、口令等敏感内容。

**作用域。** agent 按项目目录自动绑定（`kimi-<目录名>-<哈希>`），记忆按 agent 隔离——换项目就是另一套记忆。需要跨项目统一时配固定 `agentId`。

**配置与排障。** 全部开关、A/B 召回模式与排查方法见 `using-tdai-memory` 技能；配置文件在 `~/.kimi-code/tdai-plugin/config.json`，日志在 `~/.kimi-code/tdai-plugin/logs/`。改 `config.json` 下一条消息就生效；改插件文件本身（`SYSTEM.md`、`SKILL.md`、`kimi.plugin.json`）要 `/plugins reload` 或开新会话。

> 本段由插件清单的 `systemPromptPath: "./SYSTEM.md"` 贡献，每轮请求都在系统提示词里；`skills/using-tdai-memory/SKILL.md` 是会话启动加载一次的技能，含工具表与配置表。
