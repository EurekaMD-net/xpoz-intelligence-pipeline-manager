/**
 * Xpoz Intelligence Pipeline — Core runner function
 *
 * Extracted from index.ts to be callable by both CLI and daemon/cron.
 * Handles: Ingest → Normalize → Persist → Delta → Report → Notify
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ingestAll } from "./ingest/ingestor.js";
import { normalize } from "./transform/normalizer.js";
import {
  insertRun,
  insertTopicsForRun,
  getPreviousRun,
  getTopicsForRun,
  clearAllData,
} from "./store/queries.js";
import { closeDb } from "./store/db.js";
import { calcCredits } from "./store/schema.js";
import { computeDelta } from "./analyze/delta.js";
import { renderMarkdown, renderJson } from "./report/formatter.js";
import { sendTelegramDigest } from "./notify/telegram.js";
import type { IngestSummary } from "./ingest/ingestor.js";
import type { TopicConfig } from "../config.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PipelineOptions {
  outputMode: "console" | "json" | "md" | "both";
  notify: boolean;
  force: boolean;      // force Telegram even if no new/up topics
  closeDb?: boolean;   // close DB connection after run (default: true)
  topicConfig: TopicConfig; // required — no presets, no defaults
}

export interface PipelineResult {
  runId: number;
  topicCount: number;
  uniquePosts: number;
  rawPosts: number;
  durationMs: number;
  newTopics: number;
  upTopics: number;
  telegramSent: boolean;
  creditsUsed: number;
  queriesCount: number;
}

// ─── Helper ───────────────────────────────────────────────────────────────────

function deltaIcons(d: ReturnType<typeof computeDelta>): string {
  const parts: string[] = [];
  if (d.newCount) parts.push(`🆕 ${d.newCount} new`);
  if (d.upCount) parts.push(`📈 ${d.upCount} up`);
  if (d.downCount) parts.push(`📉 ${d.downCount} down`);
  if (d.stableCount) parts.push(`➡️ ${d.stableCount} stable`);
  if (d.disappearedCount) parts.push(`🕳️ ${d.disappearedCount} gone`);
  return parts.length > 0 ? parts.join(" · ") : "no delta";
}

// ─── Pipeline runner ──────────────────────────────────────────────────────────

export async function runPipeline(opts: PipelineOptions): Promise<PipelineResult> {
  const { outputMode, notify, force, topicConfig } = opts;
  const shouldCloseDb = opts.closeDb ?? true;

  console.log("═══════════════════════════════════════════════════");
  console.log("  Xpoz Intelligence Pipeline — Run");
  console.log(`  Topic: ${topicConfig.label}`);
  console.log("═══════════════════════════════════════════════════");

  const startedAt = new Date().toISOString();

  // ── 0. Clean slate — wipe previous data before every run ──────────────────
  console.log("\n[0/5] Clearing previous run data...");
  const cleared = clearAllData();
  console.log(
    `      ✓ Cleared: ${cleared.deletedRuns} runs, ${cleared.deletedTopics} topics, ${cleared.deletedPosts} posts`
  );

  // ── 1. Ingest ──────────────────────────────────────────────────────────────
  console.log("\n[1/5] Ingesting from Xpoz...");
  const ingestSummary: IngestSummary = await ingestAll(topicConfig);
  console.log(
    `      ✓ ${ingestSummary.totalFetched} posts fetched in ${ingestSummary.durationMs}ms` +
    (ingestSummary.totalErrors > 0 ? ` (${ingestSummary.totalErrors} errors)` : "")
  );

  // ── 2. Normalize ───────────────────────────────────────────────────────────
  console.log("\n[2/5] Normalizing + clustering...");
  const normalized = normalize(ingestSummary.results, topicConfig);
  console.log(
    `      ✓ ${normalized.stats.rawPostCount} raw → ${normalized.stats.afterDedup} unique → ${normalized.stats.topicCount} topics`
  );

  // ── 3. Persist ─────────────────────────────────────────────────────────────
  console.log("\n[3/5] Persisting to SQLite...");
  const queriesCount = ingestSummary.results.length;
  const creditsUsed = calcCredits(queriesCount, ingestSummary.totalFetched);

  const runId = insertRun({
    started_at: startedAt,
    duration_ms: ingestSummary.durationMs,
    raw_post_count: normalized.stats.rawPostCount,
    unique_post_count: normalized.stats.afterDedup,
    topic_count: normalized.topics.length,
    credits_used: creditsUsed,
    queries_count: queriesCount,
  });

  insertTopicsForRun(runId, normalized.topics);

  const previousRun = getPreviousRun(runId);
  const previousTopics = previousRun ? getTopicsForRun(previousRun.id) : null;

  console.log(
    previousRun
      ? `      ✓ Run #${runId} saved. Comparing with Run #${previousRun.id}. Credits used: ${creditsUsed.toFixed(2)}`
      : `      ✓ Run #${runId} saved. (first run — no delta available). Credits used: ${creditsUsed.toFixed(2)}`
  );

  // ── 4. Delta + Report ──────────────────────────────────────────────────────
  console.log("\n[4/5] Computing delta + rendering report...");
  const delta = computeDelta(normalized.topics, previousTopics);

  const reportInput = {
    delta,
    runId,
    durationMs: ingestSummary.durationMs,
    rawPostCount: normalized.stats.rawPostCount,
    uniquePostCount: normalized.stats.afterDedup,
    previousRun,
  };

  const md = renderMarkdown(reportInput);
  const jsonReport = renderJson(reportInput);

  const outputDir = join(process.cwd(), "output");

  if (outputMode === "json" || outputMode === "both") {
    await mkdir(outputDir, { recursive: true });
    const filename = join(outputDir, `run-${runId}.json`);
    await writeFile(filename, JSON.stringify(jsonReport, null, 2));
    console.log(`      ✓ JSON saved: output/run-${runId}.json`);
  }

  if (outputMode === "md" || outputMode === "both") {
    await mkdir(outputDir, { recursive: true });
    const filename = join(outputDir, `run-${runId}.md`);
    await writeFile(filename, md);
    console.log(`      ✓ Markdown saved: output/run-${runId}.md`);
  }

  if (outputMode === "console" || outputMode === "both") {
    console.log("\n" + md);
  }

  // ── 5. Notify ──────────────────────────────────────────────────────────────
  let telegramSent = false;

  if (notify) {
    console.log("\n[5/5] Sending Telegram digest...");
    telegramSent = await sendTelegramDigest({
      topics: delta.topics,
      runId,
      totalPosts: normalized.stats.rawPostCount,
      uniquePosts: normalized.stats.afterDedup,
      subredditCount: topicConfig.subreddits.length,
      durationMs: ingestSummary.durationMs,
      force,
    });
  } else {
    console.log("\n[5/5] Notify disabled — skipping Telegram");
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log("\n═══════════════════════════════════════════════════");
  if (previousRun) {
    console.log(`  ✅ Run #${runId} complete — ${deltaIcons(delta)} vs Run #${previousRun.id}`);
  } else {
    console.log(`  ✅ Run #${runId} complete — ${normalized.topics.length} topics (baseline)`);
  }
  if (telegramSent) {
    console.log("  📱 Telegram digest sent");
  }
  console.log("═══════════════════════════════════════════════════\n");

  if (shouldCloseDb) {
    closeDb();
  }

  return {
    runId,
    topicCount: normalized.topics.length,
    uniquePosts: normalized.stats.afterDedup,
    rawPosts: normalized.stats.rawPostCount,
    durationMs: ingestSummary.durationMs,
    newTopics: delta.newCount,
    upTopics: delta.upCount,
    telegramSent,
    creditsUsed,
    queriesCount,
  };
}
