#!/usr/bin/env node
// Minimal MCP (stdio, newline-delimited JSON-RPC) server exposing TDAI memory tools.
// 基础 8 个工具；Wiki（知识库）工具组默认关闭，配置 wikiEnabled=true 后才注册。
import { loadConfig } from "../lib/config.mjs";
import { logError } from "../lib/log.mjs";
import { createClient, searchMemory } from "../lib/tdai.mjs";
import { guessCwd, withAgent } from "../lib/agent.mjs";

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const DEFAULT_PROTOCOL = "2024-11-05";
const SERVER_INFO = { name: "tdai-memory", version: "0.3.0" };
const TOOL_TEXT_MAX = 8000;

const TOOLS = [
  {
    name: "tdai_search",
    description:
      "在 TDAI 长期记忆中检索：相关记忆原子（L1）与历史对话（L0）。返回纯文本列表，没有命中时返回空提示。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "检索关键词或自然语言描述" },
        limit: { type: "number", description: "最多返回条数，默认取插件配置 recallLimit" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "tdai_remember",
    description:
      "把一条信息写入 TDAI 的 L0 对话记录，记忆抽取管线会异步将其沉淀为长期记忆（L1/L2/L3）。用户说“记住/记一下”时使用。",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "要记住的原文内容" },
        session_id: { type: "string", description: "可选，关联的会话标识" },
      },
      required: ["content"],
      additionalProperties: false,
    },
  },
  {
    name: "tdai_scene_read",
    description: "按 path 读取 L2 场景全文。当自动注入的【历史场景索引】里某个场景看起来相关时使用。",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "场景 path，取自场景索引" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "tdai_skill_search",
    description: "搜索团队技能库（由历史对话抽取的可复用工作流）。涉及团队规范、既有做法、踩坑经验时优先检索。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "检索关键词" },
        top_k: { type: "number", description: "返回条数，默认 5" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "tdai_skill_view",
    description: "查看技能详情，默认返回 SKILL.md 正文（可能被截断）。参数 skill_id 来自 tdai_skill_search 的结果。",
    inputSchema: {
      type: "object",
      properties: {
        skill_id: { type: "string", description: "技能 id" },
        include_manifest: { type: "boolean", description: "是否同时返回 manifest" },
      },
      required: ["skill_id"],
      additionalProperties: false,
    },
  },
  {
    name: "tdai_skill_files_read",
    description: "读取技能附带的资源文件（path 相对于该技能目录）。",
    inputSchema: {
      type: "object",
      properties: {
        skill_id: { type: "string", description: "技能 id" },
        path: { type: "string", description: "技能内相对路径" },
      },
      required: ["skill_id", "path"],
      additionalProperties: false,
    },
  },
  {
    name: "tdai_skill_extract",
    description:
      "从给定对话内容中抽取可复用技能（服务端异步生成）。仅在用户明确要求“把这次的做法沉淀成技能”时调用。",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "要抽取技能的对话/步骤内容" },
        reason: { type: "string", description: "可选，抽取理由" },
      },
      required: ["content"],
      additionalProperties: false,
    },
  },
  {
    name: "tdai_status",
    description: "检查 TDAI 配置与连通性（endpoint、身份三元组、agent 绑定、健康探测）。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

const WIKI_TOOLS = [
  {
    name: "tdai_wiki_list",
    description: "列出团队知识库（wiki 列表，含 wiki_id / 名称 / 状态 / 页数）。其余 wiki 工具都需要 wiki_id。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "tdai_wiki_search",
    description: "在指定知识库里检索页面，返回标题、ref 与片段。查团队文档、规范、沉淀资料时优先用它。",
    inputSchema: {
      type: "object",
      properties: {
        wiki_id: { type: "string", description: "知识库 id" },
        query: { type: "string", description: "检索关键词" },
        limit: { type: "number", description: "返回条数，默认 5" },
      },
      required: ["wiki_id", "query"],
      additionalProperties: false,
    },
  },
  {
    name: "tdai_wiki_page_read",
    description: "按 ref 数组读取知识库页面全文（ref 来自 tdai_wiki_search 的结果）。",
    inputSchema: {
      type: "object",
      properties: {
        wiki_id: { type: "string", description: "知识库 id" },
        refs: { type: "array", items: { type: "string" }, description: "页面引用列表" },
      },
      required: ["wiki_id", "refs"],
      additionalProperties: false,
    },
  },
  {
    name: "tdai_wiki_page_write",
    description:
      "写入或更新知识库页面（会带 locked frontmatter）。这是对团队共享知识库的写操作，务必先跟用户确认内容与目标 wiki。",
    inputSchema: {
      type: "object",
      properties: {
        wiki_id: { type: "string", description: "知识库 id" },
        pages: {
          type: "array",
          items: {
            type: "object",
            properties: {
              ref: { type: "string", description: "页面路径/引用" },
              content: { type: "string", description: "页面正文（Markdown）" },
              title: { type: "string", description: "可选标题" },
            },
            required: ["ref", "content"],
            additionalProperties: false,
          },
          description: "要写入的页面数组",
        },
      },
      required: ["wiki_id", "pages"],
      additionalProperties: false,
    },
  },
  {
    name: "tdai_wiki_raw_write",
    description:
      "上传原始素材到知识库（加工第一步）：素材先在 raw 区，随后用 tdai_wiki_ingest 让服务端 LLM 生成页面。",
    inputSchema: {
      type: "object",
      properties: {
        wiki_id: { type: "string", description: "知识库 id" },
        files: {
          type: "array",
          items: {
            type: "object",
            properties: {
              filename: { type: "string", description: "文件名" },
              content: { type: "string", description: "文件内容" },
            },
            required: ["filename", "content"],
            additionalProperties: false,
          },
          description: "要上传的素材文件",
        },
      },
      required: ["wiki_id", "files"],
      additionalProperties: false,
    },
  },
  {
    name: "tdai_wiki_ingest",
    description: "触发知识库的 LLM 异步加工（raw/sources → 页面 + 索引）。上传素材后调用，处理需要时间。",
    inputSchema: {
      type: "object",
      properties: { wiki_id: { type: "string", description: "知识库 id" } },
      required: ["wiki_id"],
      additionalProperties: false,
    },
  },
  {
    name: "tdai_wiki_create",
    description: "创建知识库（同 team + 同名是幂等的，会返回已存在的那个）。仅在用户明确要求新建知识库时调用。",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "知识库名称" } },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "tdai_wiki_delete",
    description:
      "批量删除知识库（不可恢复，影响全团队）。只有用户明确点名要删除的具体 wiki_id 才能调用，禁止自行推测。",
    inputSchema: {
      type: "object",
      properties: {
        wiki_ids: { type: "array", items: { type: "string" }, description: "要删除的知识库 id 列表" },
      },
      required: ["wiki_ids"],
      additionalProperties: false,
    },
  },
];

const loaded = loadConfig();

function clip(text, max = TOOL_TEXT_MAX) {
  const value = String(text ?? "");
  return value.length > max ? `${value.slice(0, max)}\n…（截断）` : value;
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function textResult(text, isError = false) {
  return { content: [{ type: "text", text }], isError };
}

/** 生效配置（含项目级 agent 绑定）。MCP 进程只知道自己被拉起的 cwd，靠它或最近一次 hook 记录推断。 */
let configPromise;

function effectiveConfig() {
  // 缓存 Promise 而不是结果：同一批并发 tool_call 共享一次 agent 解析
  if (!configPromise) configPromise = resolveConfig();
  return configPromise;
}

async function resolveConfig() {
  const cfg = loadConfig();
  if (!cfg.configured) return null;
  if (cfg.agentId) return cfg;
  return await withAgent(cfg, guessCwd());
}

function formatSkillItems(items) {
  const lines = [];
  for (const item of items ?? []) {
    if (!item) continue;
    const id = item.skill_id || item.id || "?";
    const name = item.name || "(未命名)";
    const description = String(item.description || "").replace(/\s+/g, " ").slice(0, 160);
    lines.push(`- ${name} (skill_id=${id})${description ? `：${description}` : ""}`);
  }
  return lines.join("\n");
}

async function callWikiTool(client, name, args) {
  const wikiId = args?.wiki_id ? String(args.wiki_id) : "";

  if (name === "tdai_wiki_list") {
    const data = await client.wikiList();
    const items = data?.items ?? [];
    if (!items.length) return textResult("团队还没有知识库。要新建可以先跟用户确认名字，再调 tdai_wiki_create。");
    const lines = items.map(
      (item) =>
        `- ${item.name || "(未命名)"} (wiki_id=${item.wiki_id}) status=${item.status || "?"}` +
        `${item.page_count !== undefined ? ` pages=${item.page_count}` : ""}${item.summary ? ` — ${item.summary}` : ""}`,
    );
    return textResult(lines.join("\n"));
  }

  if (name === "tdai_wiki_create") {
    const wikiName = String(args?.name || "").trim();
    if (!wikiName) return textResult("name 不能为空", true);
    const data = await client.wikiCreate({ name: wikiName });
    return textResult(`知识库就绪：${data?.name || wikiName} (wiki_id=${data?.wiki_id || "?"}) status=${data?.status || "?"}`);
  }

  if (name === "tdai_wiki_delete") {
    const ids = Array.isArray(args?.wiki_ids) ? args.wiki_ids.map(String).filter(Boolean) : [];
    if (!ids.length) return textResult("wiki_ids 不能为空", true);
    const data = await client.wikiDelete(ids);
    const failed = Array.isArray(data?.failed) ? data.failed.length : 0;
    return textResult(`已删除 ${(data?.deleted_ids ?? []).length} 个知识库${failed ? `，${failed} 个失败` : ""}。`);
  }

  if (!wikiId) return textResult("wiki_id 不能为空", true);

  if (name === "tdai_wiki_search") {
    const query = String(args?.query || "").trim();
    if (!query) return textResult("query 不能为空", true);
    const data = await client.wikiSearch({ wikiId, query, limit: Number(args?.limit) || undefined });
    const results = data?.results ?? [];
    if (!results.length) return textResult("知识库里没有匹配页面。");
    const lines = results.map((item) => {
      const ref = item.ref || item.path || "?";
      const title = item.title ? `${item.title} ` : "";
      const body = item.snippet || item.content || "";
      return `- ${title}(ref=${ref})：${String(body).replace(/\s+/g, " ").slice(0, 200)}`;
    });
    return textResult(clip(lines.join("\n")));
  }

  if (name === "tdai_wiki_page_read") {
    const refs = Array.isArray(args?.refs) ? args.refs.map(String).filter(Boolean) : [];
    if (!refs.length) return textResult("refs 不能为空", true);
    const data = await client.wikiPageRead({ wikiId, refs });
    const items = data?.items ?? [];
    if (!items.length) return textResult("没有读到页面内容。");
    const blocks = items.map((item) => `## ${item.ref || "?"}\n${item.content ?? "(空)"}`);
    return textResult(clip(blocks.join("\n\n")));
  }

  if (name === "tdai_wiki_page_write") {
    const pages = Array.isArray(args?.pages) ? args.pages : [];
    if (!pages.length) return textResult("pages 不能为空", true);
    const data = await client.wikiPageWrite({
      wikiId,
      pages: pages.map((page) => ({
        ref: String(page?.ref || ""),
        content: String(page?.content ?? ""),
        ...(page?.title ? { title: String(page.title) } : {}),
      })),
    });
    const items = data?.items ?? [];
    return textResult(`已写入 ${items.length || pages.length} 个页面${items.some((i) => i?.locked_injected) ? "（含 locked 标记）" : ""}。`);
  }

  if (name === "tdai_wiki_raw_write") {
    const files = Array.isArray(args?.files) ? args.files : [];
    if (!files.length) return textResult("files 不能为空", true);
    const data = await client.wikiRawWrite({
      wikiId,
      files: files.map((file) => ({ filename: String(file?.filename || ""), content: String(file?.content ?? "") })),
    });
    const items = data?.items ?? [];
    return textResult(`已上传 ${items.length || files.length} 个素材文件。接着可以调 tdai_wiki_ingest 触发加工。`);
  }

  if (name === "tdai_wiki_ingest") {
    const data = await client.wikiIngest({ wikiId });
    return textResult(`已触发加工：wiki_id=${data?.wiki_id || wikiId} status=${data?.status || "accepted"}（异步，稍后再检索）。`);
  }

  return textResult(`未知工具：${name}`, true);
}

async function callTool(name, args) {
  const cfg = await effectiveConfig();

  if (name === "tdai_status") {
    const lines = [
      `endpoint: ${loaded.endpoint}${loaded.gatewayToken ? "（Gateway 模式：Bearer 用 gatewayToken）" : "（直连模式）"}`,
      `wiki: ${loaded.wikiEnabled ? `启用（hub 端口 ${loaded.hubPort}）` : "未启用（wikiEnabled=false）"}`,
      `serviceId: ${loaded.serviceId}`,
      `team/user: ${loaded.teamId || "(未配置)"} / ${loaded.userId || "(未配置)"}`,
      `agentId: ${loaded.agentId || (cfg?.agentId ? `${cfg.agentId}（项目自动绑定，cwd=${guessCwd()}）` : "(未绑定)")}`,
      `autoAgent: ${loaded.autoAgent}  autoRecall: ${loaded.autoRecall}  autoCapture: ${loaded.autoCapture}`,
      `recall: persona=${loaded.includePersona} scenes=${loaded.includeSceneNav} cacheTtlMs=${loaded.profileCacheTtlMs}`,
    ];
    if (cfg) {
      try {
        const health = await createClient(cfg).health();
        lines.push(`health: ${JSON.stringify(health)}`);
      } catch (error) {
        lines.push(`health: FAILED ${error.message}`);
      }
    } else {
      lines.push("health: 跳过（配置不完整或 agent 未绑定）");
    }
    return textResult(lines.join("\n"), !cfg);
  }

  if (!cfg) {
    return textResult(
      "TDAI 未配置或 agent 未绑定：请检查 ~/.kimi-code/tdai-plugin/config.json 的 endpoint/teamId/userId（以及 agentId，或打开 autoAgent 让插件按项目自动创建），或设置 TDAI_MEMORY_* 环境变量。",
      true,
    );
  }

  const client = createClient(cfg);

  if (name === "tdai_search") {
    const query = String(args?.query || "").trim();
    if (!query) return textResult("query 不能为空", true);
    const limit = Number.isFinite(Number(args?.limit)) ? Number(args.limit) : cfg.recallLimit;
    const result = await searchMemory(cfg, query, limit);
    return textResult(result || "没有检索到相关记忆。");
  }

  if (name === "tdai_remember") {
    const content = String(args?.content || "").trim();
    if (!content) return textResult("content 不能为空", true);
    const sessionId = String(args?.session_id || "mcp-manual");
    const data = await client.conversationAdd(`kimi-${sessionId}`, [{ role: "user", content }]);
    return textResult(`已写入 L0（total_count=${data?.total_count ?? "?"}），长期记忆会由 TDAI 管线异步抽取。`);
  }

  if (name === "tdai_scene_read") {
    const scenePath = String(args?.path || "").trim();
    if (!scenePath) return textResult("path 不能为空", true);
    const data = await client.readScenario(scenePath);
    return textResult(data?.content ? clip(data.content) : `场景 ${scenePath} 没有内容。`);
  }

  if (name === "tdai_skill_search") {
    const query = String(args?.query || "").trim();
    if (!query) return textResult("query 不能为空", true);
    const topK = Number.isFinite(Number(args?.top_k)) ? Number(args.top_k) : 5;
    const data = await client.searchSkills({ query, topK });
    const items = data?.items ?? [];
    if (!items.length) return textResult("技能库没有匹配项。");
    return textResult(clip(formatSkillItems(items)));
  }

  if (name === "tdai_skill_view") {
    const skillId = String(args?.skill_id || "").trim();
    if (!skillId) return textResult("skill_id 不能为空", true);
    const data = await client.getSkill({
      skillId,
      includeContent: true,
      includeManifest: args?.include_manifest === true,
    });
    const head = data?.skill?.name ? `技能：${data.skill.name}（${skillId}）` : `技能：${skillId}`;
    const body = data?.content ? clip(data.content) : "（该技能没有 SKILL.md 正文）";
    const manifest = args?.include_manifest && data?.manifest ? `\n\nmanifest:\n${clip(JSON.stringify(data.manifest, null, 2), 2000)}` : "";
    return textResult(`${head}\n\n${body}${manifest}`);
  }

  if (name === "tdai_skill_files_read") {
    const skillId = String(args?.skill_id || "").trim();
    const filePath = String(args?.path || "").trim();
    if (!skillId || !filePath) return textResult("skill_id 与 path 都不能为空", true);
    const data = await client.readSkillFile({ skillId, filePath });
    const body = data?.content ?? data?.data;
    return textResult(body ? clip(body) : `技能 ${skillId} 里没有 ${filePath}。`);
  }

  if (name === "tdai_skill_extract") {
    const content = String(args?.content || "").trim();
    if (!content) return textResult("content 不能为空", true);
    const data = await client.skillExtract([{ role: "user", content }], args?.reason);
    return textResult(`已提交技能抽取任务${data?.task_id ? `（task_id=${data.task_id}）` : ""}，结果由服务端异步生成。`);
  }

  if (name.startsWith("tdai_wiki_")) {
    if (!loaded.wikiEnabled) {
      return textResult(
        "Wiki 知识库工具未启用：在 ~/.kimi-code/tdai-plugin/config.json 设 wikiEnabled=true（或 TDAI_MEMORY_WIKI=1）后重启会话。",
        true,
      );
    }
    return await callWikiTool(client, name, args);
  }

  return textResult(`未知工具：${name}`, true);
}

async function handleMessage(message) {
  const { id, method, params } = message;
  if (method === "initialize") {
    const requested = params?.protocolVersion;
    const protocolVersion = PROTOCOL_VERSIONS.includes(requested) ? requested : DEFAULT_PROTOCOL;
    reply(id, { protocolVersion, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
    return;
  }
  if (method === "ping") {
    reply(id, {});
    return;
  }
  if (method === "tools/list") {
    reply(id, { tools: loaded.wikiEnabled ? [...TOOLS, ...WIKI_TOOLS] : TOOLS });
    return;
  }
  if (method === "tools/call") {
    let result;
    try {
      result = await callTool(params?.name, params?.arguments || {});
    } catch (error) {
      logError("mcp", error);
      result = textResult(`调用失败：${error.message}`, true);
    }
    reply(id, result);
    return;
  }
  if (typeof method === "string" && method.startsWith("notifications/")) return;
  if (id !== undefined && id !== null) replyError(id, -32601, `Method not found: ${method}`);
}

let buffer = "";
let inFlight = 0;
let stdinClosed = false;

function exitWhenIdle() {
  // 不主动 process.exit：Windows 上在流关闭期间退出会触发 libuv 断言
  // （Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), win/async.c）。
  // stdin 结束且没有在途请求后，事件循环自然清空，进程自行退出。
  if (!stdinClosed || inFlight > 0) return;
  process.stdin.pause();
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    inFlight += 1;
    handleMessage(message)
      .catch((error) => logError("mcp", error))
      .finally(() => {
        inFlight -= 1;
        exitWhenIdle();
      });
  }
});
process.stdin.on("end", () => {
  stdinClosed = true;
  exitWhenIdle();
});
