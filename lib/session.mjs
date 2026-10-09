import fs from "node:fs";
import path from "node:path";
import { kimiHome } from "./config.mjs";

export function sessionDir(sessionId) {
  if (!sessionId) return null;
  const home = kimiHome();
  try {
    const index = fs.readFileSync(path.join(home, "session_index.jsonl"), "utf8");
    let found = null;
    for (const line of index.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.sessionId === sessionId && typeof entry.sessionDir === "string") found = entry.sessionDir;
      } catch {
        // skip malformed index lines
      }
    }
    if (found) return found;
  } catch {
    // index missing: fall back to directory scan
  }
  if (path.basename(sessionId) !== sessionId) return null;
  try {
    for (const workDir of fs.readdirSync(path.join(home, "sessions"))) {
      const candidate = path.join(home, "sessions", workDir, sessionId);
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch {
    // no sessions directory
  }
  return null;
}

export function lastAssistantMessage(dir) {
  if (!dir) return "";
  let lines;
  try {
    lines = fs.readFileSync(path.join(dir, "agents", "main", "wire.jsonl"), "utf8").split("\n");
  } catch {
    return "";
  }
  let message = "";
  let stepId = null;
  let parts = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record.type !== "context.append_loop_event" || !record.event) continue;
    const event = record.event;
    if (event.type === "step.begin") {
      stepId = event.uuid;
      parts = [];
    } else if (
      event.type === "content.part" &&
      event.stepUuid === stepId &&
      event.part &&
      event.part.type === "text" &&
      typeof event.part.text === "string"
    ) {
      parts.push(event.part.text);
    } else if (event.type === "step.end" && event.uuid === stepId) {
      if (event.finishReason !== "error" && event.finishReason !== "interrupted" && parts.length) {
        message = parts.join("");
      }
      stepId = null;
      parts = [];
    }
  }
  return message;
}
