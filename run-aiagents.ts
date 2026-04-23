/**
 * Ad-hoc run — r/aiagents y subreddits relacionados
 * Ejecutar: npx tsx run-aiagents.ts
 */

import { getSubredditPosts, searchByKeyword } from "./src/ingest/xpoz-client.js";
import type { NormalizedXpozPost } from "./src/ingest/xpoz-client.js";

const AI_SUBREDDITS = [
  "aiagents",
  "LangChain",
  "AutoGPT",
  "LocalLLaMA",
  "singularity",
];

const AI_KEYWORDS = [
  "AI agent autonomous",
  "multi-agent framework",
  "LLM agent workflow",
];

async function main() {
  console.log("=== Xpoz AI Agents Intelligence Run ===\n");

  const allPosts: NormalizedXpozPost[] = [];

  // Fetch subreddits
  for (const sub of AI_SUBREDDITS) {
    try {
      const posts = await getSubredditPosts(sub);
      console.log(`r/${sub}: ${posts.length} posts`);
      allPosts.push(...posts);
    } catch (err) {
      console.warn(`r/${sub}: ERROR — ${err}`);
    }
  }

  // Fetch keywords
  for (const kw of AI_KEYWORDS) {
    try {
      const posts = await searchByKeyword(kw);
      const filtered = posts.filter(p =>
        AI_SUBREDDITS.some(s => s.toLowerCase() === p.subreddit.toLowerCase()) ||
        ["MachineLearning", "artificial", "OpenAI", "Anthropic", "ChatGPT", "ClaudeAI", "AIAssistants", "agi", "aiagents", "LangChain", "AutoGPT", "LocalLLaMA", "singularity"].includes(p.subreddit)
      );
      console.log(`keyword "${kw}": ${filtered.length} posts (from ${posts.length})`);
      allPosts.push(...filtered);
    } catch (err) {
      console.warn(`keyword "${kw}": ERROR — ${err}`);
    }
  }

  // Dedup by ID
  const seen = new Set<string>();
  const unique = allPosts.filter(p => {
    if (seen.has(p.id)) return false;
    seen.add(p.id);
    return true;
  });

  console.log(`\nTotal unique posts: ${unique.length}`);

  // Group by title themes — simple scoring by upvotes
  // Sort by score desc
  const sorted = unique.sort((a, b) => b.score - a.score);

  console.log("\n=== TOP 30 POSTS POR SCORE ===\n");
  for (const p of sorted.slice(0, 30)) {
    console.log(`[${p.score}] r/${p.subreddit} — ${p.title}`);
  }
}

main().catch(console.error);
