/**
 * Xpoz Intelligence Pipeline — Entry Point
 *
 * Phase 2: Ingest → Normalize → Persist → Delta → Report
 *
 * Usage:
 *   npx tsx src/index.ts                    # console output
 *   npx tsx src/index.ts --output json      # saves output/run-<id>.json
 *   npx tsx src/index.ts --output md        # saves output/run-<id>.md
 *   npx tsx src/index.ts --output both      # saves both
 *   npx tsx src/index.ts --history          # list past runs
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
  getAllRuns,
} from "./store/queries.js";
import { closeDb } from "./store/db.js";
import { computeDelta } from "./analyze/delta.js";
import { renderMarkdown, renderJson } from "./report/formatter.js";

// ─── CLI args ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const outputArg = args.includes("--output")
  ? args[args.indexOf("--output") + 1]
  : "console";
const showHistory = args.includes("--history");

// ─── History mode ─────────────────────────────────────────────────────────────

function printHistory(): void {
  const runs = getAllRuns();
  if (runs.length === 0) {
    console.log("No runs yet. Run the pipeline first.");
    return;
  }

  console.log("\n═══ Run History ═══════════════════════════════════");
  console.log(
    "ID".padEnd(6) +
    "Date".padEnd(14) +
    "Posts".padEnd(10) +
    "Unique".padEnd(10) +
    "Topics".padEnd(10) +
    "Duration"
  );
  console.log("─".repeat(62));
  for (const run of runs) {
    console.log(
      String(run.id).padEnd(6) +
      run.started_at.substring(0, 10).padEnd(14) +
      String(run.raw_post_count).padEnd(10) +
      String(run.unique_post_count).padEnd(10) +
      String(run.topic_count).padEnd(10) +
      `${run.duration_ms}ms`
    );
  }
  console.log("═══════════════════════════════════════════════════\n");
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (showHistory) {
    printHistory();
    closeDb();
    return;
  }

  console.log("═══════════════════════════════════════════════════");
  console.log("  Xpoz Intelligence Pipeline — Phase 2 Run");
  console.log("═══════════════════════════════════════════════════");

  const startedAt = new Date().toISOString();

  // 1. Ingest
  console.log("\n[1/4] Ingesting from Xpoz...");
  const ingestSummary = await ingestAll();
  console.log(
    `      ✓ ${ingestSummary.totalFetched} posts fetched in ${ingestSummary.durationMs}ms` +
    (ingestSummary.totalErrors > 0 ? ` (${ingestSummary.totalErrors} errors)` : "")
  );

  // 2. Normalize
  console.log("\n[2/4] Normalizing + clustering...");
  const normalized = normalize(ingestSummary.results);
  console.log(
    `      ✓ ${normalized.stats.rawPostCount} raw → ${normalized.stats.afterDedup} unique → ${normalized.stats.topicCount} topics`
  );

  // 3. Persist
  console.log("\n[3/4] Persisting to SQLite...");
  const runId = insertRun({
    started_at: startedAt,
    duration_ms: ingestSummary.durationMs,
    raw_post_count: normalized.stats.rawPostCount,
    unique_post_count: normalized.stats.afterDedup,
    topic_count: normalized.topics.length,
  });

  insertTopicsForRun(runId, normalized.topics);

  // Fetch previous run for delta
  const previousRun = getPreviousRun(runId);
  const previousTopics = previousRun ? getTopicsForRun(previousRun.id) : null;
  console.log(
    previousRun
      ? `      ✓ Run #${runId} saved. Comparing with Run #${previousRun.id}`
      : `      ✓ Run #${runId} saved. (first run — no delta available)`
  );

  // 4. Delta + Report
  console.log("\n[4/4] Computing delta + rendering report...");
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
  const json = renderJson(reportInput);

  if (outputArg === "json" || outputArg === "both") {
    await mkdir("output", { recursive: true });
    const filename = join("output", `run-${runId}.json`);
    await writeFile(filename, JSON.stringify(json, null, 2));
    console.log(`      ✓ JSON saved: ${filename}`);
  }

  if (outputArg === "md" || outputArg === "both") {
    await mkdir("output", { recursive: true });
    const filename = join("output", `run-${runId}.md`);
    await writeFile(filename, md);
    console.log(`      ✓ Markdown saved: ${filename}`);
  }

  console.log("\n" + md);

  console.log("═══════════════════════════════════════════════════");
  if (previousRun) {
    console.log(
      `  ✅ Run #${runId} complete — ${DELTA_ICONS(delta)} vs Run #${previousRun.id}`
    );
  } else {
    console.log(`  ✅ Run #${runId} complete — ${normalized.topics.length} topics (baseline)`);
  }
  console.log("═══════════════════════════════════════════════════\n");

  closeDb();
}

function DELTA_ICONS(d: ReturnType<typeof computeDelta>): string {
  const parts: string[] = [];
  if (d.newCount) parts.push(`🆕 ${d.newCount} new`);
  if (d.upCount) parts.push(`📈 ${d.upCount} up`);
  if (d.downCount) parts.push(`📉 ${d.downCount} down`);
  if (d.stableCount) parts.push(`➡️ ${d.stableCount} stable`);
  if (d.disappearedCount) parts.push(`🕳️ ${d.disappearedCount} gone`);
  return parts.join(" · ");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  closeDb();
  process.exit(1);
});
