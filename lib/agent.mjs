import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { dataDir } from "./config.mjs";
import { createClient } from "./tdai.mjs";

// 项目级 agent 自动绑定：按 cwd 派生稳定名字，查不到就创建，结果落盘缓存。
// 参考实现：vaynebobby-crypto/pi-tdai-team-memory 的 deriveAgentName / resolveProjectAgent。

const DUP_NAME_RE = /exist|duplicate|conflict|already|same name|409/i;

function cacheFile() {
  return path.join(dataDir(), "agents.json");
}

function readCacheFile() {
  try {
    const data = JSON.parse(fs.readFileSync(cacheFile(), "utf8"));
    return data && typeof data === "object" ? data : { byCwd: {} };
  } catch {
    return { byCwd: {} };
  }
}

/** 按 cwd 派生项目级 agent 名：kimi-{目录名}-{cwd 哈希前 8 位}，避免同名目录串台。 */
export function deriveAgentName(cwd) {
  const base = String(cwd || "").replace(/[\\/]+$/, "");
  const dir = base === "" ? "home" : base.split(/[\\/]/).pop() || "home";
  const sanitized = dir === "home" ? "home" : dir.replace(/[^a-zA-Z0-9_-]/g, "");
  const basename = (sanitized || "home").slice(0, 24) || "home";
  const hash = createHash("sha256").update(base).digest("hex").slice(0, 8);
  return `kimi-${basename}-${hash}`;
}

export function readAgentCache(cwd) {
  const data = readCacheFile();
  if (cwd) return data.byCwd?.[cwd] ?? null;
  return data;
}

function writeAgentCache(cwd, agentId, name) {
  try {
    const data = readCacheFile();
    data.byCwd = data.byCwd || {};
    data.byCwd[cwd] = { agentId, name, ts: Date.now() };
    data.lastCwd = cwd;
    const file = cacheFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
  } catch {
    // 缓存写失败不影响本次调用
  }
}

/** 解析（或创建）cwd 对应的项目 agent；失败抛错，由调用方决定降级。 */
export async function resolveProjectAgent(cfg, cwd) {
  if (!cwd) return null;
  const name = deriveAgentName(cwd);
  const cached = readAgentCache(cwd);
  if (cached?.agentId && cached.name === name) return cached.agentId;

  const client = createClient(cfg);
  const byName = await client.listAgents({ team_id: cfg.teamId, owner_user_id: cfg.userId, name });
  const hit = (byName?.items ?? []).find((agent) => agent && agent.status === "active");
  if (hit?.agent_id) {
    writeAgentCache(cwd, hit.agent_id, name);
    return hit.agent_id;
  }

  try {
    const created = await client.createAgent({
      team_id: cfg.teamId,
      owner_user_id: cfg.userId,
      name,
      description: `Kimi Code project agent for ${cwd}`,
      metadata_json: JSON.stringify({ cwd, source: "kimi-code-plugin" }),
    });
    const agentId = created?.agent_id ?? created?.id;
    if (agentId) {
      writeAgentCache(cwd, agentId, name);
      return agentId;
    }
    return null;
  } catch (error) {
    // 并发场景：另一个会话刚创建了同名 agent → 重查一次复用
    if (DUP_NAME_RE.test(String(error?.message || ""))) {
      const retry = await client.listAgents({ team_id: cfg.teamId, owner_user_id: cfg.userId, name });
      const retryHit = (retry?.items ?? []).find((agent) => agent && agent.status === "active");
      if (retryHit?.agent_id) {
        writeAgentCache(cwd, retryHit.agent_id, name);
        return retryHit.agent_id;
      }
    }
    throw error;
  }
}

/**
 * 得到带 agentId 的有效配置：
 * - 配置里写了 agentId（固定绑定）→ 直接用它
 * - 打开 autoAgent → 按 cwd 解析/创建项目 agent
 * - 都不可用 → 返回 null（调用方跳过本轮）
 */
export async function withAgent(cfg, cwd) {
  if (cfg.agentId) return cfg;
  if (!cfg.autoAgent) return null;
  const agentId = await resolveProjectAgent(cfg, cwd);
  return agentId ? { ...cfg, agentId } : null;
}

/** MCP server 没有 hook payload，只能靠 cwd 或最近一次 hook 记录的项目目录。 */
export function guessCwd() {
  const cwd = process.cwd();
  const pluginRoot = process.env.KIMI_PLUGIN_ROOT;
  if (cwd && (!pluginRoot || path.resolve(cwd) !== path.resolve(pluginRoot))) return cwd;
  return readCacheFile().lastCwd || "";
}
