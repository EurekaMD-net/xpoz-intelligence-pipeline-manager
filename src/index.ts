/**
 * Xpoz Intelligence Pipeline — Entry Point
 *
 * Phase 4: Added --serve mode (HTTP API on port 8086) + Jarvis integration
 *
 * Usage:
 *   npx tsx src/index.ts                         # console output (default)
 *   npx tsx src/index.ts --output json           # save JSON to output/
 *   npx tsx src/index.ts --output md             # save Markdown to output/
 *   npx tsx src/index.ts --output both           # save both
 *   npx tsx src/index.ts --notify                # run + send Telegram if new/up topics
 *   npx tsx src/index.ts --notify --force        # run + always send Telegram
 *   npx tsx src/index.ts --daemon                # start cron loop (07:00 CDMX daily)
 *   npx tsx src/index.ts --daemon --notify       # cron + Telegram on new/up topics
 *   npx tsx src/index.ts --daemon --notify --force # cron + always send
 *   npx tsx src/index.ts --serve                 # start HTTP API on port 8086
 *   npx tsx src/index.ts --serve --daemon --notify # API + cron + notifications
 *   npx tsx src/index.ts --history               # list past runs
 */

import { getAllRuns } from "./store/queries.js";
import { closeDb } from "./store/db.js";
import { runPipeline } from "./pipeline.js";
import { startDaemon } from "./scheduler/cron.js";
import { startApiServer } from "./api/server.js";

// ─── CLI args ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

const outputArg = args.includes("--output")
  ? (args[args.indexOf("--output") + 1] as "console" | "json" | "md" | "both")
  : "console";

const showHistory = args.includes("--history");
const daemonMode = args.includes("--daemon");
const notifyMode = args.includes("--notify");
const forceMode = args.includes("--force");
const cronArg = args.includes("--cron")
  ? args[args.indexOf("--cron") + 1]
  : undefined;
const serveMode = args.includes("--serve");
const portArg = args.includes("--port")
  ? parseInt(args[args.indexOf("--port") + 1], 10)
  : 8086;

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

  // Serve mode: start HTTP API (optionally combined with daemon)
  if (serveMode) {
    startApiServer(portArg);
    if (daemonMode) {
      // API + cron: start both
      await startDaemon({ notify: notifyMode, force: forceMode, cron: cronArg });
    } else {
      // API only: keep process alive
      console.log("[serve] API running. Press Ctrl+C to stop.");
      process.stdin.resume();
    }
    return;
  }

  if (daemonMode) {
    // Daemon: don't close DB — the cron job keeps running
    await startDaemon({ notify: notifyMode, force: forceMode, cron: cronArg });
    return; // process.stdin.resume() in startDaemon keeps it alive
  }

  // Single run
  await runPipeline({
    outputMode: outputArg,
    notify: notifyMode,
    force: forceMode,
    closeDb: true,
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  closeDb();
  process.exit(1);
});
