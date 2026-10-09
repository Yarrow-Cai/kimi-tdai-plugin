import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULTS = {
  endpoint: "http://127.0.0.1:8420",
  hubPort: 8424,
  apiKey: "",
  gatewayToken: "",
  serviceId: "default",
  teamId: "",
  agentId: "",
  userId: "",
  autoAgent: true,
  recallLimit: 6,
  recallMaxChars: 2000,
  timeoutMs: 4000,
  maxMessageChars: 4000,
  includePersona: true,
  includeSceneNav: true,
  includePersonaMaxChars: 800,
  includeSceneMaxLines: 12,
  profileCacheTtlMs: 10 * 60 * 1000,
  autoRecall: true,
  autoCapture: true,
  wikiEnabled: false,
};

const ENV_KEYS = {
  endpoint: "TDAI_MEMORY_ENDPOINT",
  apiKey: "TDAI_MEMORY_API_KEY",
  gatewayToken: "TDAI_MEMORY_GATEWAY_TOKEN",
  serviceId: "TDAI_MEMORY_INSTANCE_ID",
  teamId: "TDAI_MEMORY_TEAM_ID",
  agentId: "TDAI_MEMORY_AGENT_ID",
  userId: "TDAI_MEMORY_USER_ID",
};

export function kimiHome() {
  return process.env.KIMI_CODE_HOME || path.join(os.homedir(), ".kimi-code");
}

export function dataDir() {
  return process.env.TDAI_MEMORY_DATA_DIR || path.join(kimiHome(), "tdai-plugin");
}

export function configFile() {
  return path.join(dataDir(), "config.json");
}

export function loadConfig() {
  const cfg = { ...DEFAULTS };
  try {
    Object.assign(cfg, JSON.parse(fs.readFileSync(configFile(), "utf8")));
  } catch {
    // 配置缺失或不可读：用默认值 + 环境变量
  }
  for (const [key, name] of Object.entries(ENV_KEYS)) {
    const value = process.env[name];
    if (value) cfg[key] = value;
  }
  if (process.env.TDAI_MEMORY_HUB_PORT) cfg.hubPort = Number(process.env.TDAI_MEMORY_HUB_PORT) || cfg.hubPort;
  if (process.env.TDAI_MEMORY_AUTO_AGENT === "0") cfg.autoAgent = false;
  if (process.env.TDAI_MEMORY_WIKI === "1") cfg.wikiEnabled = true;
  cfg.disabled = process.env.TDAI_MEMORY_DISABLED === "1";
  cfg.configuredBase = Boolean(!cfg.disabled && cfg.endpoint && cfg.teamId && cfg.userId);
  cfg.configured = Boolean(cfg.configuredBase && (cfg.agentId || cfg.autoAgent));
  return cfg;
}
