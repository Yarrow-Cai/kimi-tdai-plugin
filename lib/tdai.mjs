import { sanitizeText, shouldCapture } from "./sanitize.mjs";

const MAX_ITEM_CHARS = 300;
const MAX_PERSONA_CHARS = 800;
const MAX_SCENE_SUMMARY_CHARS = 160;

/** 服务端契约：L0 每次最多 100 条消息，技能缓冲每次最多 500 条。 */
export const L0_MAX_MESSAGES_PER_REQUEST = 100;
export const SKILL_MAX_MESSAGES_PER_REQUEST = 500;

/** Wiki（知识库）层部署在 hub 容器，默认端口 8424，由 core 端口推导。 */
export const DEFAULT_HUB_PORT = 8424;

function collapse(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

function shorten(text, max = MAX_ITEM_CHARS) {
  const value = collapse(text);
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function chunk(items, size) {
  const batches = [];
  for (let index = 0; index < items.length; index += size) batches.push(items.slice(index, index + size));
  return batches;
}

/** 由 core 地址推导 hub（Wiki 层）地址：优先改端口，解析不了就正则替换末尾端口。 */
export function hubEndpoint(endpoint, hubPort = DEFAULT_HUB_PORT) {
  const value = String(endpoint || "").replace(/\/+$/, "");
  if (!value) return value;
  try {
    const url = new URL(value);
    if (!/^https?:$/i.test(url.protocol)) throw new Error("not http(s)");
    url.port = String(hubPort);
    return url.toString().replace(/\/+$/, "");
  } catch {
    return value.replace(/:\d+$/, `:${hubPort}`).replace(/\/+$/, "");
  }
}

/**
 * 规范化待写入的消息：清洗注入块、过滤命令/噪声、截断超长内容、补 ISO 时间戳。
 * 后端要求 timestamp 为 ISO 字符串，数字会被 HTTP 400 拒绝。
 */
export function normalizeMessages(messages, maxChars) {
  const out = [];
  for (const message of messages ?? []) {
    if (!message || (message.role !== "user" && message.role !== "assistant")) continue;
    const cleaned = sanitizeText(message.content);
    if (!cleaned || !shouldCapture(cleaned)) continue;
    const clipped = cleaned.length > maxChars ? `${cleaned.slice(0, Math.max(0, maxChars - 6))}…[截断]` : cleaned;
    out.push({
      role: message.role,
      content: clipped,
      timestamp: typeof message.timestamp === "string" ? message.timestamp : new Date().toISOString(),
    });
  }
  return out;
}

export function createClient(cfg) {
  const base = String(cfg.endpoint).replace(/\/+$/, "");
  const bearer = cfg.gatewayToken || cfg.apiKey;
  const timeoutMs = cfg.timeoutMs ?? 4000;
  // Gateway 模式：网关统一路由 /v3/*，Wiki 也走同一个地址；直连模式才推导 hub 端口
  const wikiBase = cfg.gatewayToken ? base : hubEndpoint(base, cfg.hubPort);

  function headersFor(layer) {
    const headers = { "content-type": "application/json", "x-tdai-service-id": cfg.serviceId };
    if (bearer) headers.authorization = `Bearer ${bearer}`;
    // meta 层用 apiKey 作 x-tdai-user-key；Gateway 模式下 Bearer 是 gatewayToken，两者互不干扰
    if (layer === "meta" && cfg.apiKey) headers["x-tdai-user-key"] = cfg.apiKey;
    return headers;
  }

  async function request(route, { method = "POST", body, layer = "data" } = {}) {
    const requestBase = layer === "wiki" ? wikiBase : base;
    const response = await fetch(`${requestBase}${route}`, {
      method,
      headers: headersFor(layer),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const raw = await response.text();
    let json = null;
    try {
      json = raw ? JSON.parse(raw) : null;
    } catch {
      // 非 JSON body，下面按状态码报错
    }
    if (!response.ok) {
      throw new Error(`${method} ${route} HTTP ${response.status}: ${collapse(raw).slice(0, 200)}`);
    }
    const code = json?.code;
    // Wiki 层的成功码是 0 或 200，其余层只认 0
    const ok = layer === "wiki" ? code === 0 || code === 200 : code === 0;
    if (typeof code === "number" && !ok) {
      throw new Error(`${method} ${route} code=${code} ${json?.message || ""}`.trim());
    }
    return json && json.data !== undefined ? json.data : json;
  }

  const identity = () => {
    const ids = { team_id: cfg.teamId, user_id: cfg.userId };
    if (cfg.agentId) ids.agent_id = cfg.agentId;
    return ids;
  };

  /** Wiki 层 body 只带 team_id（调用方给了就以调用方为准），不带 agent_id。 */
  const wikiBody = (body) => (body && body.team_id ? { ...body } : { team_id: cfg.teamId, ...body });

  async function writeMessages(route, sessionId, messages, perRequest) {
    const normalized = normalizeMessages(messages, cfg.maxMessageChars);
    if (!normalized.length) return { total_count: 0, skipped: true };
    // 清洗后没有用户消息（例如整轮只有 /命令 与回复）就不写，避免只落一条 assistant 的孤儿记录
    if (!normalized.some((message) => message.role === "user")) {
      return { total_count: 0, skipped: true };
    }
    let total = 0;
    for (const batch of chunk(normalized, perRequest)) {
      const data = await request(route, {
        body: { ...identity(), session_id: sessionId, messages: batch },
      });
      total += Number(data?.total_count) || batch.length;
    }
    return { total_count: total, skipped: false };
  }

  return {
    health: () => request("/health", { method: "GET" }),
    conversationAdd: (sessionId, messages) =>
      writeMessages("/v3/conversation/add", sessionId, messages, L0_MAX_MESSAGES_PER_REQUEST),
    skillConversationAdd: (sessionId, messages) =>
      writeMessages("/v3/skill/conversation/add", sessionId, messages, SKILL_MAX_MESSAGES_PER_REQUEST),
    skillExtract: (messages, reason) => {
      const normalized = normalizeMessages(messages, cfg.maxMessageChars);
      return request("/v3/skill/extract", {
        body: { ...identity(), messages: normalized, ...(reason ? { reason } : {}) },
      });
    },
    conversationSearch: (query, limit) =>
      request("/v3/conversation/search", { body: { ...identity(), query, limit } }),
    atomicSearch: (query, limit) => request("/v3/atomic/search", { body: { ...identity(), query, limit } }),
    readCore: () => request("/v3/core/read", { body: { ...identity() } }),
    listScenarios: () => request("/v3/scenario/ls", { body: { ...identity() } }),
    readScenario: (routePath) => request("/v3/scenario/read", { body: { ...identity(), path: routePath } }),
    searchSkills: ({ query, topK, scope } = {}) =>
      request("/v3/skill/search", {
        body: { ...identity(), query, ...(topK ? { top_k: topK } : {}), ...(scope ? { scope } : {}) },
      }),
    getSkill: ({ skillId, includeContent = true, includeManifest = false } = {}) =>
      request("/v3/skill/get", {
        body: {
          ...identity(),
          skill_id: skillId,
          include_content: includeContent,
          include_manifest: includeManifest,
        },
      }),
    readSkillFile: ({ skillId, filePath, encoding } = {}) =>
      request("/v3/skill/files/read", {
        body: { ...identity(), skill_id: skillId, path: filePath, ...(encoding ? { encoding } : {}) },
      }),
    // meta 层：x-tdai-user-key 鉴权，body 由调用方给出 team_id / owner_user_id
    listAgents: (input) => request("/v3/meta/agent/list", { body: input, layer: "meta" }),
    createAgent: (input) => request("/v3/meta/agent/create", { body: input, layer: "meta" }),

    // ---- Wiki（知识库）层：hub 端口 / Gateway 路由，Bearer + service-id，只带 team_id ----
    wikiList: () => request("/v3/wiki/list", { body: wikiBody({}), layer: "wiki" }),
    wikiCreate: ({ name, teamId } = {}) =>
      request("/v3/wiki/create", { body: wikiBody({ name, ...(teamId ? { team_id: teamId } : {}) }), layer: "wiki" }),
    wikiDelete: (wikiIds) => request("/v3/wiki/delete", { body: wikiBody({ wiki_ids: wikiIds }), layer: "wiki" }),
    wikiSearch: ({ wikiId, query, limit } = {}) =>
      request("/v3/wiki/search", {
        body: wikiBody({ wiki_id: wikiId, query, ...(limit ? { limit } : {}) }),
        layer: "wiki",
      }),
    wikiPageRead: ({ wikiId, refs } = {}) =>
      request("/v3/wiki/page/read", { body: wikiBody({ wiki_id: wikiId, refs }), layer: "wiki" }),
    wikiPageWrite: ({ wikiId, pages } = {}) =>
      request("/v3/wiki/page/write", { body: wikiBody({ wiki_id: wikiId, pages }), layer: "wiki" }),
    wikiRawWrite: ({ wikiId, files } = {}) =>
      request("/v3/wiki/raw/write", { body: wikiBody({ wiki_id: wikiId, files }), layer: "wiki" }),
    wikiIngest: ({ wikiId } = {}) =>
      request("/v3/wiki/ingest", { body: wikiBody({ wiki_id: wikiId }), layer: "wiki" }),
  };
}

/** L1 原子记忆 + L0 历史对话检索，返回纯文本列表（无命中返回空串）。 */
export async function searchMemory(cfg, query, limit = cfg.recallLimit) {
  const client = createClient(cfg);
  const [atoms, turns] = await Promise.allSettled([
    client.atomicSearch(query, limit),
    client.conversationSearch(query, Math.min(4, Math.max(2, limit))),
  ]);
  const lines = [];
  const items = atoms.status === "fulfilled" ? atoms.value?.items ?? [] : [];
  for (const item of items.slice(0, limit)) {
    lines.push(`- [记忆/${item.type || "atom"}] ${shorten(item.content)}`);
  }
  const messages = turns.status === "fulfilled" ? turns.value?.messages ?? [] : [];
  for (const message of messages.slice(0, 4)) {
    lines.push(`- [对话/${message.role || "?"}] ${shorten(message.content)}`);
  }
  if (!lines.length) {
    const failures = [atoms, turns].filter((r) => r.status === "rejected").map((r) => r.reason?.message);
    if (failures.length) throw new Error(failures.join("; "));
    return "";
  }
  return lines.join("\n");
}

/** L3 画像 + L2 场景索引；字段为 undefined 表示拉取失败（调用方不应写缓存）。 */
export async function loadProfile(cfg) {
  const client = createClient(cfg);
  const [core, scenes] = await Promise.allSettled([
    cfg.includePersona ? client.readCore() : Promise.resolve(null),
    cfg.includeSceneNav ? client.listScenarios() : Promise.resolve(null),
  ]);
  return {
    persona: core.status === "fulfilled" ? core.value?.content ?? null : undefined,
    scenes: scenes.status === "fulfilled" ? scenes.value?.entries ?? [] : undefined,
  };
}

/** 组装注入块：L1/L0 检索结果 + L3 画像 + L2 场景索引。 */
export function composeRecallBlock({ memories, persona, scenes }, cfg) {
  const parts = [];
  if (memories) parts.push(memories);
  if (cfg.includePersona && persona && persona.trim()) {
    const text = persona.trim();
    const clipped =
      text.length > cfg.includePersonaMaxChars ? `${text.slice(0, cfg.includePersonaMaxChars)}…` : text;
    parts.push(`【用户画像】\n${clipped}`);
  }
  if (cfg.includeSceneNav && Array.isArray(scenes) && scenes.length) {
    const lines = scenes
      .filter((scene) => scene && typeof scene.path === "string" && scene.path.trim())
      .slice(0, cfg.includeSceneMaxLines)
      .map((scene) => `- \`${scene.path}\` — ${shorten(scene.summary || "(无摘要)", MAX_SCENE_SUMMARY_CHARS)}`);
    if (lines.length) parts.push(`【历史场景索引】\n${lines.join("\n")}`);
  }
  if (!parts.length) return "";
  let body = parts.join("\n\n");
  if (body.length > cfg.recallMaxChars) body = `${body.slice(0, cfg.recallMaxChars)}\n…（截断）`;
  return [
    "<tdai_memory>",
    "以下是从 TDAI 长期记忆库自动检索到的可能相关的内容（未必完整，可用 tdai_search 工具继续查）：",
    body,
    "</tdai_memory>",
  ].join("\n");
}
