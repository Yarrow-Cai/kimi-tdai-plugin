import fs from "node:fs";
import path from "node:path";
import { dataDir } from "./config.mjs";

function stateFile(sessionId) {
  const safe = String(sessionId || "unknown").replace(/[^A-Za-z0-9_.-]/g, "_");
  return path.join(dataDir(), "state", `${safe}.json`);
}

export function readState(sessionId) {
  try {
    const state = JSON.parse(fs.readFileSync(stateFile(sessionId), "utf8"));
    return {
      pending: Array.isArray(state.pending) ? state.pending : [],
      turnFailed: state.turnFailed === true,
      lastPromptId: typeof state.lastPromptId === "string" ? state.lastPromptId : "",
    };
  } catch {
    return { pending: [], turnFailed: false, lastPromptId: "" };
  }
}

export function writeState(sessionId, state) {
  try {
    const file = stateFile(sessionId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(
      tmp,
      JSON.stringify({ ...state, sessionId, updatedAt: new Date().toISOString() }, null, 2),
    );
    fs.renameSync(tmp, file);
  } catch {
    // 状态是尽力而为，hook 不能因此失败
  }
}

export function clearState(sessionId) {
  try {
    fs.rmSync(stateFile(sessionId));
  } catch {
    // 没有状态文件
  }
}
