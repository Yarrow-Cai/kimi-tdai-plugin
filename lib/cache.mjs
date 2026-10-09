import fs from "node:fs";
import path from "node:path";
import { dataDir } from "./config.mjs";

// hooks 是独立短进程，L2/L3 缓存必须落盘才能跨轮复用。

function cacheFile(sessionId) {
  const safe = String(sessionId || "unknown").replace(/[^A-Za-z0-9_.-]/g, "_");
  return path.join(dataDir(), "cache", `${safe}.profile.json`);
}

export function readProfileCache(sessionId, ttlMs) {
  try {
    const entry = JSON.parse(fs.readFileSync(cacheFile(sessionId), "utf8"));
    if (!entry.ok) return null;
    if (typeof entry.ts !== "number" || Date.now() - entry.ts >= ttlMs) return null;
    return { persona: entry.persona ?? null, scenes: entry.scenes ?? null };
  } catch {
    return null;
  }
}

export function writeProfileCache(sessionId, { persona, scenes, ok }) {
  if (!ok) return;
  try {
    const file = cacheFile(sessionId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ persona, scenes, ok, ts: Date.now() }));
  } catch {
    // 缓存写失败不影响主流程
  }
}

export function clearProfileCache(sessionId) {
  try {
    fs.rmSync(cacheFile(sessionId));
  } catch {
    // 没有缓存文件
  }
}
