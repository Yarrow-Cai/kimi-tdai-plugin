#!/usr/bin/env node
// Kimi Code hook 入口：`node ./hooks/hook.mjs <EventName>`
// 从 stdin 读事件 payload，做 TDAI 召回/捕获，任何异常都 fail-open。
import fs from "node:fs";
import path from "node:path";
import { dataDir, loadConfig } from "../lib/config.mjs";
import { logError, logLine } from "../lib/log.mjs";
import { composeRecallBlock, createClient, loadProfile, searchMemory } from "../lib/tdai.mjs";
import { clearProfileCache, readProfileCache, writeProfileCache } from "../lib/cache.mjs";
import { withAgent } from "../lib/agent.mjs";
import { lastAssistantMessage, lastTurnPrompt, sessionDir } from "../lib/session.mjs";
import { clearState, readState, writeState } from "../lib/state.mjs";

const MAX_PENDING = 12;
const STDIN_TIMEOUT_MS = 1500;

const eventName = process.argv[2] || "";

/** 诊断：每次 hook 触发记一行元信息（不含正文），用来确认 Kimi Code 实际触发了哪些事件。 */
function traceHook(payload) {
  try {
    const dir = path.join(dataDir(), "logs");
    fs.mkdirSync(dir, { recursive: true });
    const keys = Object.keys(payload || {}).join(",");
    const prompt = typeof payload?.prompt === "string" ? payload.prompt : "";
    fs.appendFileSync(
      path.join(dir, "hook-events.log"),
      `${new Date().toISOString()} event=${eventName} argv=${process.argv.slice(2).join("|")} keys=[${keys}] session_id=${payload?.session_id ?? ""} cwd=${payload?.cwd ?? ""} prompt_len=${prompt.length} proc_cwd=${process.cwd()}\n`,
    );
  } catch {
    // 诊断失败不影响主流程
  }
}

async function readPayload() {
  return new Promise((resolve) => {
    let data = "";
    const finish = (payload) => {
      traceHook(payload);
      clearTimeout(timer);
      resolve(payload);
    };
    const timer = setTimeout(() => finish({}), STDIN_TIMEOUT_MS);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => {
      try {
        finish(JSON.parse(data || "{}"));
      } catch {
        finish({});
      }
    });
    process.stdin.on("error", () => finish({}));
  });
}

function pickString(payload, keys) {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

/** 本轮召回：L1/L0 检索 + L3 画像 / L2 场景索引（画像与场景落盘缓存，TTL 内不重复请求）。 */
async function recall(cfg, sessionId, query) {
  const wantProfile = cfg.includePersona || cfg.includeSceneNav;
  const [memories, profile] = await Promise.allSettled([
    searchMemory(cfg, query),
    (async () => {
      if (!wantProfile) return { persona: null, scenes: null };
      const cached = readProfileCache(sessionId, cfg.profileCacheTtlMs);
      if (cached) return cached;
      const fresh = await loadProfile(cfg);
      const ok = fresh.persona !== undefined || fresh.scenes !== undefined;
      const value = { persona: fresh.persona ?? null, scenes: fresh.scenes ?? null };
      writeProfileCache(sessionId, { ...value, ok });
      return value;
    })(),
  ]);
  const memoriesText = memories.status === "fulfilled" ? memories.value : "";
  const profileValue =
    profile.status === "fulfilled" ? profile.value : { persona: null, scenes: null };
  if (memories.status === "rejected" && !profileValue.persona && !(profileValue.scenes ?? []).length) {
    throw memories.reason;
  }
  return composeRecallBlock({ memories: memoriesText, ...profileValue }, cfg);
}

/** 把本轮消息写入 L0（清洗/截断/分片由 client 负责），并顺带喂技能抽取。
 *  userFallback：UserPromptSubmit 没触发时，用会话记录里解析出的用户原文兜底。 */
async function capture(cfg, sessionId, state, { assistant = "", userFallback = "", promptId = "" } = {}) {
  const pending = Array.isArray(state.pending) ? state.pending.slice() : [];
  const hasPendingUser = pending.some(
    (message) => message && message.role === "user" && String(message.content || "").trim(),
  );
  if (!hasPendingUser && userFallback) {
    pending.push({ role: "user", content: userFallback, timestamp: new Date().toISOString() });
  }
  if (assistant) pending.push({ role: "assistant", content: assistant, timestamp: new Date().toISOString() });
  const hasUser = pending.some(
    (message) => message && message.role === "user" && String(message.content || "").trim(),
  );
  if (!hasUser) {
    writeState(sessionId, { ...state, pending: [], turnFailed: false });
    return false;
  }
  const client = createClient(cfg);
  const tdaiSession = `kimi-${sessionId || "unknown"}`;
  const result = await client.conversationAdd(tdaiSession, pending);
  if (!result?.skipped) {
    try {
      await client.skillConversationAdd(tdaiSession, pending);
    } catch (error) {
      logLine("capture", `skill buffering skipped: ${error.message}`);
    }
    logLine("capture", `L0 写入 ${result?.total_count ?? "?"} 条`);
  }
  writeState(sessionId, {
    ...state,
    pending: [],
    turnFailed: false,
    ...(promptId ? { lastPromptId: promptId } : {}),
  });
  return true;
}

/** 解析本次生效的配置（含项目级 agent 绑定）；解析不出来返回 null。 */
async function resolveConfig(cfg, cwd) {
  if (cfg.agentId || !cfg.configured) return cfg;
  try {
    const effective = await withAgent(cfg, cwd);
    if (effective) logLine("agent", `绑定项目 agent ${effective.agentId}（cwd=${cwd}）`);
    return effective;
  } catch (error) {
    logError("agent", error);
    return null;
  }
}

async function main() {
  const payload = await readPayload();
  if (!eventName) return;
  const loaded = loadConfig();
  const sessionId = String(payload.session_id || "");
  const cwd = String(payload.cwd || "");

  if (!loaded.configured) {
    if (eventName === "SessionStart") {
      logLine("session", "TDAI 未配置，跳过（见 ~/.kimi-code/tdai-plugin/config.json）");
    }
    return;
  }

  const cfg = await resolveConfig(loaded, cwd);
  if (!cfg) {
    logLine("agent", `项目 agent 未解析成功（cwd=${cwd}），跳过本轮`);
    return;
  }

  if (eventName === "SessionStart") {
    if (String(payload.source || "startup") === "startup") {
      writeState(sessionId, { pending: [], turnFailed: false });
      // 新会话开始时画像/场景索引重新拉取一次
      clearProfileCache(sessionId);
    } else {
      writeState(sessionId, readState(sessionId));
    }
    logLine("session", `${payload.source || "startup"} ${sessionId}`);
    return;
  }

  if (eventName === "UserPromptSubmit") {
    const prompt = pickString(payload, ["prompt", "user_prompt", "userPrompt", "text"]);
    if (!prompt) return;
    if (cfg.autoCapture) {
      const state = readState(sessionId);
      const pending = Array.isArray(state.pending) ? state.pending : [];
      pending.push({ role: "user", content: prompt, timestamp: new Date().toISOString() });
      writeState(sessionId, { ...state, pending: pending.slice(-MAX_PENDING), turnFailed: false });
    }
    if (cfg.autoRecall) {
      const block = await recall(cfg, sessionId, prompt);
      if (block) process.stdout.write(`${block}\n`);
    }
    return;
  }

  if (eventName === "Stop") {
    if (!cfg.autoCapture) return;
    const state = readState(sessionId);
    if (state.turnFailed) {
      writeState(sessionId, { ...state, pending: [], turnFailed: false });
      logLine("turn", "跳过失败回合的捕获");
      return;
    }
    const dir = sessionDir(sessionId);
    const wirePrompt = lastTurnPrompt(dir);
    const hasPendingUser = (state.pending ?? []).some(
      (message) => message && message.role === "user" && String(message.content || "").trim(),
    );
    // 桌面端目前不触发 UserPromptSubmit，这里用会话记录兜底；同一个 promptId 不重复上传
    if (!hasPendingUser && wirePrompt?.promptId && wirePrompt.promptId === state.lastPromptId) {
      logLine("capture", "本轮已上传，跳过");
      return;
    }
    let assistant = pickString(payload, ["response", "last_assistant_message"]);
    if (!assistant) assistant = lastAssistantMessage(dir);
    await capture(cfg, sessionId, state, {
      assistant,
      userFallback: hasPendingUser ? "" : wirePrompt?.text ?? "",
      promptId: wirePrompt?.promptId ?? "",
    });
    return;
  }

  // Interrupt 会代替 Stop 触发；StopFailure 表示本轮出错。都不该写 L0。
  if (eventName === "Interrupt" || eventName === "StopFailure") {
    const state = readState(sessionId);
    writeState(sessionId, { ...state, pending: [], turnFailed: true });
    logLine("turn", `${eventName} → 跳过本轮捕获`);
    return;
  }

  if (eventName === "PreCompact") {
    if (!cfg.autoCapture) return;
    const wirePrompt = lastTurnPrompt(sessionDir(sessionId));
    await capture(cfg, sessionId, readState(sessionId), {
      userFallback: wirePrompt?.text ?? "",
      promptId: wirePrompt?.promptId ?? "",
    });
    return;
  }

  if (eventName === "SessionEnd") {
    if (cfg.autoCapture) {
      const dir = sessionDir(sessionId);
      const state = readState(sessionId);
      const wirePrompt = lastTurnPrompt(dir);
      if (wirePrompt?.promptId && wirePrompt.promptId === state.lastPromptId) {
        logLine("capture", "本轮已上传，跳过");
      } else {
        await capture(cfg, sessionId, state, {
          assistant: lastAssistantMessage(dir),
          userFallback: wirePrompt?.text ?? "",
          promptId: wirePrompt?.promptId ?? "",
        });
      }
    }
    clearState(sessionId);
    logLine("session", `end ${sessionId}`);
  }
}

try {
  await main();
} catch (error) {
  logError(eventName || "hook", error);
}
