import fs from "node:fs";
import path from "node:path";
import { dataDir } from "./config.mjs";

export function logLine(scope, message, { always = false } = {}) {
  if (!always && process.env.TDAI_MEMORY_DEBUG !== "1") return;
  try {
    const dir = path.join(dataDir(), "logs");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `tdai-${new Date().toISOString().slice(0, 10)}.log`);
    fs.appendFileSync(file, `${new Date().toISOString()} [${scope}] ${message}\n`);
  } catch {
    // logging must never break a hook
  }
}

export function logError(scope, error) {
  const detail = error && error.stack ? error.stack : String(error);
  logLine(scope, `ERROR ${detail}`, { always: true });
}
