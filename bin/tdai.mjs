#!/usr/bin/env node
// 手动调试/验证用 CLI：
//   node bin/tdai.mjs status | health | agents
//   node bin/tdai.mjs search "查询内容" [--limit N] | remember "要记住的内容"
//   node bin/tdai.mjs scene "projects/xxx"
//   node bin/tdai.mjs skills "关键词" [--limit N] | skill <skill_id> [--manifest]
//   node bin/tdai.mjs wikis | wiki-search <wiki_id> "关键词" | wiki-read <wiki_id> <ref...>
//   node bin/tdai.mjs wiki-create "知识库名" | wiki-page-write <wiki_id> <ref> <文件路径> | wiki-ingest <wiki_id>
import fs from "node:fs";
import { loadConfig } from "../lib/config.mjs";
import { createClient, hubEndpoint, searchMemory } from "../lib/tdai.mjs";
import { deriveAgentName, guessCwd, withAgent } from "../lib/agent.mjs";

const loaded = loadConfig();
const [command, ...rest] = process.argv.slice(2);

function usage() {
  console.log(
    [
      "用法：",
      "  node bin/tdai.mjs status | health | agents",
      '  node bin/tdai.mjs search "查询内容" [--limit N]',
      '  node bin/tdai.mjs remember "要记住的内容"',
      '  node bin/tdai.mjs scene "projects/xxx"',
      '  node bin/tdai.mjs skills "关键词" [--limit N]',
      "  node bin/tdai.mjs skill <skill_id> [--manifest]",
      "  node bin/tdai.mjs wikis",
      '  node bin/tdai.mjs wiki-search <wiki_id> "关键词" [--limit N]',
      "  node bin/tdai.mjs wiki-read <wiki_id> <ref...>",
      '  node bin/tdai.mjs wiki-create "知识库名"',
      "  node bin/tdai.mjs wiki-page-write <wiki_id> <ref> <md 文件路径>",
      "  node bin/tdai.mjs wiki-ingest <wiki_id>",
    ].join("\n"),
  );
}

function flagValue(name) {
  const index = rest.indexOf(name);
  return index >= 0 ? rest[index + 1] : undefined;
}

function positional() {
  const limitIndex = rest.indexOf("--limit");
  return rest.filter((item, index) => {
    if (item === "--manifest") return false;
    if (limitIndex >= 0 && (index === limitIndex || index === limitIndex + 1)) return false;
    return true;
  });
}

function textArg() {
  return positional().join(" ").trim();
}

async function main() {
  if (command === "status") {
    console.log(
      JSON.stringify(
        {
          configured: loaded.configured,
          mode: loaded.gatewayToken ? "gateway" : "direct",
          endpoint: loaded.endpoint,
          hubEndpoint: loaded.gatewayToken ? `${loaded.endpoint}（Gateway 路由）` : hubEndpoint(loaded.endpoint, loaded.hubPort),
          serviceId: loaded.serviceId,
          teamId: loaded.teamId,
          userId: loaded.userId,
          agentId: loaded.agentId || `(未固定，autoAgent=${loaded.autoAgent})`,
          projectAgentName: deriveAgentName(guessCwd()),
          cwd: guessCwd(),
          wikiEnabled: loaded.wikiEnabled,
          autoRecall: loaded.autoRecall,
          autoCapture: loaded.autoCapture,
          recall: {
            limit: loaded.recallLimit,
            persona: loaded.includePersona,
            scenes: loaded.includeSceneNav,
            cacheTtlMs: loaded.profileCacheTtlMs,
          },
        },
        null,
        2,
      ),
    );
    return;
  }

  if (!loaded.configured) {
    console.log("TDAI 未配置：请检查 ~/.kimi-code/tdai-plugin/config.json");
    return;
  }

  const cfg = loaded.agentId ? loaded : await withAgent(loaded, guessCwd());
  if (!cfg) {
    console.log(`agent 未解析成功（项目=${deriveAgentName(guessCwd())}），检查 autoAgent 或直接配 agentId`);
    return;
  }
  const client = createClient(cfg);

  if (command === "health") {
    console.log(JSON.stringify(await client.health(), null, 2));
    return;
  }

  if (command === "agents") {
    const data = await client.listAgents({ team_id: cfg.teamId, owner_user_id: cfg.userId });
    const items = data?.items ?? [];
    if (!items.length) {
      console.log("(该用户下没有 agent)");
      return;
    }
    for (const agent of items) {
      console.log(`- ${agent.name} (agent_id=${agent.agent_id}) status=${agent.status}${agent.description ? ` — ${agent.description}` : ""}`);
    }
    return;
  }

  if (command === "search") {
    const query = textArg();
    if (!query) return usage();
    const limit = Number(flagValue("--limit")) || cfg.recallLimit;
    console.log((await searchMemory(cfg, query, limit)) || "(没有命中)");
    return;
  }

  if (command === "remember") {
    const content = textArg();
    if (!content) return usage();
    console.log(JSON.stringify(await client.conversationAdd(`kimi-cli-${process.pid}`, [{ role: "user", content }]), null, 2));
    return;
  }

  if (command === "scene") {
    const scenePath = textArg();
    if (!scenePath) return usage();
    console.log((await client.readScenario(scenePath))?.content || "(场景没有内容)");
    return;
  }

  if (command === "skills") {
    const query = textArg();
    if (!query) return usage();
    const data = await client.searchSkills({ query, topK: Number(flagValue("--limit")) || 5 });
    const items = data?.items ?? [];
    if (!items.length) {
      console.log("(技能库没有匹配项)");
      return;
    }
    for (const item of items) {
      console.log(`- ${item.name} (skill_id=${item.skill_id || item.id})${item.description ? ` — ${item.description}` : ""}`);
    }
    return;
  }

  if (command === "skill") {
    const skillId = textArg();
    if (!skillId) return usage();
    const data = await client.getSkill({ skillId, includeContent: true, includeManifest: rest.includes("--manifest") });
    console.log(data?.content || JSON.stringify(data, null, 2));
    return;
  }

  // ---- Wiki 知识库 ----

  if (command === "wikis") {
    const data = await client.wikiList();
    const items = data?.items ?? [];
    if (!items.length) {
      console.log("(团队还没有知识库)");
      return;
    }
    for (const item of items) {
      console.log(`- ${item.name} (wiki_id=${item.wiki_id}) status=${item.status}${item.page_count !== undefined ? ` pages=${item.page_count}` : ""}`);
    }
    return;
  }

  if (command === "wiki-create") {
    const name = textArg();
    if (!name) return usage();
    const data = await client.wikiCreate({ name });
    console.log(`知识库就绪：${data?.name} (wiki_id=${data?.wiki_id}) status=${data?.status}`);
    return;
  }

  if (command === "wiki-search") {
    const [wikiId, ...restWords] = positional();
    const query = restWords.join(" ").trim();
    if (!wikiId || !query) return usage();
    const data = await client.wikiSearch({ wikiId, query, limit: Number(flagValue("--limit")) || undefined });
    const results = data?.results ?? [];
    if (!results.length) {
      console.log("(没有匹配页面)");
      return;
    }
    for (const item of results) {
      console.log(`- ${item.title || "(无标题)"} (ref=${item.ref || item.path})：${String(item.snippet || item.content || "").replace(/\s+/g, " ").slice(0, 160)}`);
    }
    return;
  }

  if (command === "wiki-read") {
    const [wikiId, ...refs] = positional();
    if (!wikiId || !refs.length) return usage();
    const data = await client.wikiPageRead({ wikiId, refs });
    for (const item of data?.items ?? []) {
      console.log(`## ${item.ref}\n${item.content ?? "(空)"}\n`);
    }
    return;
  }

  if (command === "wiki-page-write") {
    const [wikiId, ref, filePath] = positional();
    if (!wikiId || !ref || !filePath) return usage();
    const content = fs.readFileSync(filePath, "utf8");
    const data = await client.wikiPageWrite({ wikiId, pages: [{ ref, content }] });
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  if (command === "wiki-ingest") {
    const [wikiId] = positional();
    if (!wikiId) return usage();
    console.log(JSON.stringify(await client.wikiIngest({ wikiId }), null, 2));
    return;
  }

  usage();
}

main().catch((error) => {
  console.error(`失败：${error.message}`);
  process.exitCode = 1;
});
