// 写 L0 之前的文本清洗。核心目的：剥离 recall 注入块，否则会形成
// capture → recall → capture 的正反馈，把记忆库塞满标签垃圾。
// 参考实现：vaynebobby-crypto/pi-tdai-team-memory 的 lib/sanitize.ts

const INJECTION_TAG_BLOCK_RE =
  /<(tdai_memory|relevant-memories|user-persona|relevant-scenes|scene-navigation|tdai_profile_memory|l3_core_memory|l2_scene_index|tdai-memory-tools-guide|knowledge_tools)(?:\s[^>]*)?>[\s\S]*?<\/\1>/gi;

const TIMESTAMP_ONLY_LINE_RE =
  /(^|\n)[ \t]*(?:\[\d{2}:\d{2}(?::\d{2})?\]|\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?)[ \t]*(\n|$)/g;

const INLINE_BASE64_IMAGE_RE = /!?\[[^\]]*\]\(data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+\)/g;

const NULL_CHAR_RE = /\u0000/g;

const EXCESS_BLANK_LINES_RE = /\n{3,}/g;

/** 框架噪声标记：命中即视为不该写入 L0。 */
const NOISE_MARKERS = [
  "<system-reminder>",
  "<cron-fire",
  "(session bootstrap)",
  "Pre-compaction memory flush",
  "NO_REPLY",
];

export function sanitizeText(text) {
  if (!text) return "";
  return String(text)
    .replace(INJECTION_TAG_BLOCK_RE, "")
    .replace(TIMESTAMP_ONLY_LINE_RE, "$1$3")
    .replace(INLINE_BASE64_IMAGE_RE, "")
    .replace(NULL_CHAR_RE, "")
    .replace(EXCESS_BLANK_LINES_RE, "\n\n")
    .trim();
}

/** 是否应写入 L0：过滤空文本、`/` 开头的命令、框架噪声。 */
export function shouldCapture(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("/")) return false;
  return !NOISE_MARKERS.some((marker) => trimmed.includes(marker));
}
