/**
 * Xpoz Intelligence Pipeline — Entry Point
 *
 * Runs the full Phase 1 pipeline:
 *   Ingest → Normalize → Report
 *
 * Usage:
 *   npx tsx src/index.ts
 *   npx tsx src/index.ts --output json   (saves output/run-<timestamp>.json)
 *   npx tsx src/index.ts --output md     (saves output/run-<timestamp>.md)
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ingestAll } from "./ingest/ingestor.js";
import { normalize } from "./transform/normalizer.js";
import type { Topic } from "./transform/normalizer.js";

// ─── CLI args ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const outputArg = args.includes("--output") ? args[args.indexOf("--output") + 1] : "console";

// ─── Markdown Report ──────────────────────────────────────────────────────────

function renderMarkdown(topics: Topic[], stats: Record<string, number>, durationMs: number): string {
  const now = new Date().toISOString().split("T")[0];
  const lines: string[] = [
    `# Reddit Intelligence Report — ${now}`,
    ``,
    `> Pipeline: Xpoz API · Phase 1 · ${durationMs}ms`,
    `> Posts ingested: ${stats.rawPostCount} raw → ${stats.afterDedup} unique · ${stats.topicCount} clusters found`,
    ``,
    `## 🔥 Top 10 Topics`,
    ``,
  ];

  for (const topic of topics) {
    lines.push(`### #${topic.rank} — ${topic.title}`);
    lines.push(`**Score agregado:** ${topic.aggregateScore} | **Posts:** ${topic.posts.length}`);
    lines.push(`**Subreddits:** ${topic.subreddits.map((s) => `r/${s}`).join(", ")}`);
    lines.push(``);
    lines.push(`**Post representativo:** [${topic.representative.title}](${topic.representative.url})`);
    lines.push(`↳ Score: ${topic.representative.score} · by u/${topic.representative.author}`);
    lines.push(``);
    if (topic.posts.length > 1) {
      lines.push(`**Otros posts del cluster:**`);
      for (const p of topic.posts.slice(1, 4)) {
        lines.push(`- [${p.title}](${p.url}) — score: ${p.score}`);
      }
    }
    lines.push(``);
    lines.push(`---`);
    lines.push(``);
  }

  return lines.join("\n");
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("═══════════════════════════════════════════════════");
  console.log("  Xpoz Intelligence Pipeline — Phase 1 Run");
  console.log("═══════════════════════════════════════════════════");

  // 1. Ingest
  const ingestSummary = await ingestAll();

  // 2. Normalize
  const normalized = normalize(ingestSummary.results);

  // 3. Output
  const md = renderMarkdown(normalized.topics, normalized.stats, ingestSummary.durationMs);

  if (outputArg === "json" || outputArg === "both") {
    await mkdir("output", { recursive: true });
    const filename = join("output", `run-${Date.now()}.json`);
    await writeFile(filename, JSON.stringify({ topics: normalized.topics, stats: normalized.stats, ingestSummary }, null, 2));
    console.log(`\n📁 JSON saved: ${filename}`);
  }

  if (outputArg === "md" || outputArg === "both") {
    await mkdir("output", { recursive: true });
    const filename = join("output", `run-${Date.now()}.md`);
    await writeFile(filename, md);
    console.log(`\n📁 Markdown saved: ${filename}`);
  }

  // Always print to console
  console.log("\n" + md);

  // Exit summary
  console.log("═══════════════════════════════════════════════════");
  console.log(`  ✅ Done — ${normalized.topics.length} topics · ${ingestSummary.totalFetched} posts · ${ingestSummary.durationMs}ms`);
  if (ingestSummary.totalErrors > 0) {
    console.log(`  ⚠️  ${ingestSummary.totalErrors} fetch errors (see logs above)`);
  }
  console.log("═══════════════════════════════════════════════════");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
