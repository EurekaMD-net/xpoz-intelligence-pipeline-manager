/**
 * Análisis temático de posts de AI Agents
 * Agrupa posts por tópico y calcula score agregado
 */

import { getSubredditPosts, searchByKeyword } from "./src/ingest/xpoz-client.js";
import type { NormalizedXpozPost } from "./src/ingest/xpoz-client.js";

const AI_SUBREDDITS = ["aiagents", "LangChain", "AutoGPT", "LocalLLaMA", "singularity"];
const AI_KEYWORDS = ["AI agent autonomous", "multi-agent framework", "LLM agent workflow"];

const TOPIC_RULES: Array<{ topic: string; keywords: string[] }> = [
  { topic: "Claude / Anthropic Models", keywords: ["claude", "anthropic", "mythos", "opus"] },
  { topic: "Local LLMs & Open Source Models", keywords: ["local", "ollama", "llama", "qwen", "kimi", "gemma", "open.source", "huggingface", "openclaw"] },
  { topic: "Humanoid Robots & Robotics", keywords: ["robot", "humanoid", "reflex", "manufacturing", "factory"] },
  { topic: "AI Agents & Autonomous Systems", keywords: ["agent", "autonomous", "agentic", "workflow", "langgraph", "crewai", "autogpt"] },
  { topic: "AGI / Superintelligence", keywords: ["agi", "superintelligence", "singularity", "sam altman", "social contract"] },
  { topic: "OpenAI / GPT / Image Gen", keywords: ["openai", "gpt", "chatgpt", "image model", "dall"] },
  { topic: "China AI & Geopolitics", keywords: ["china", "chinese", "iran", "state media"] },
  { topic: "Memory & Personalization Systems", keywords: ["memory", "longmemeval", "milla", "jovovich"] },
  { topic: "LLM Benchmarks & Model Quality", keywords: ["benchmark", "regression", "score", "nyt connections", "performance"] },
  { topic: "Model Jailbreaks & Safety", keywords: ["bypass", "permissions", "jailbreak", "whip", "leak", "safety"] },
];

function classifyPost(title: string): string {
  const lower = title.toLowerCase();
  for (const rule of TOPIC_RULES) {
    if (rule.keywords.some(kw => lower.includes(kw))) {
      return rule.topic;
    }
  }
  return "Other / Emerging";
}

async function main() {
  const allPosts: NormalizedXpozPost[] = [];

  for (const sub of AI_SUBREDDITS) {
    try {
      const posts = await getSubredditPosts(sub);
      allPosts.push(...posts);
    } catch {}
  }

  for (const kw of AI_KEYWORDS) {
    try {
      const posts = await searchByKeyword(kw);
      allPosts.push(...posts);
    } catch {}
  }

  // Dedup
  const seen = new Set<string>();
  const unique = allPosts.filter(p => {
    if (seen.has(p.id)) return false;
    seen.add(p.id);
    return true;
  }).filter(p => p.score >= 5);

  // Group
  const topicMap = new Map<string, { score: number; posts: NormalizedXpozPost[]; subreddits: Set<string> }>();

  for (const p of unique) {
    const topic = classifyPost(p.title);
    if (!topicMap.has(topic)) {
      topicMap.set(topic, { score: 0, posts: [], subreddits: new Set() });
    }
    const t = topicMap.get(topic)!;
    t.score += p.score;
    t.posts.push(p);
    t.subreddits.add(p.subreddit);
  }

  // Sort
  const ranked = [...topicMap.entries()]
    .map(([topic, data]) => ({
      topic,
      aggregateScore: data.score,
      postCount: data.posts.length,
      subreddits: [...data.subreddits],
      topPost: data.posts.sort((a, b) => b.score - a.score)[0],
    }))
    .sort((a, b) => b.aggregateScore - a.aggregateScore)
    .slice(0, 10);

  console.log("\n====== TOP 10 TÓPICOS — r/aiagents & relacionados ======\n");
  for (let i = 0; i < ranked.length; i++) {
    const t = ranked[i];
    console.log(`#${i + 1} ${t.topic}`);
    console.log(`   Score agregado: ${t.aggregateScore.toLocaleString()} | Posts: ${t.postCount} | Subreddits: ${t.subreddits.join(", ")}`);
    console.log(`   Top post: [${t.topPost.score}] ${t.topPost.title}`);
    console.log();
  }
}

main().catch(console.error);
