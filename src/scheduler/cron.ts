/**
 * Cron Scheduler — Xpoz Intelligence Pipeline
 *
 * Runs the pipeline daily at 07:00 CDMX (America/Mexico_City).
 * Uses node-cron for scheduling.
 *
 * Usage:
 *   npx tsx src/index.ts --daemon              # starts cron loop
 *   npx tsx src/index.ts --daemon --notify     # cron + Telegram on new/up topics
 *   npx tsx src/index.ts --daemon --force      # cron + always send Telegram
 */

import { runPipeline } from "../pipeline.js";

// Default: 07:00 CDMX every day
const DEFAULT_CRON = "0 7 * * *";
const TIMEZONE = "America/Mexico_City";

export async function startDaemon(opts: {
  notify: boolean;
  force: boolean;
  cron?: string;
}): Promise<void> {
  // Dynamic import so we don't pay the dep cost when not in daemon mode
  const { default: cron } = await import("node-cron");

  const schedule = opts.cron ?? DEFAULT_CRON;

  console.log(`[daemon] Starting — schedule: "${schedule}" (${TIMEZONE})`);
  console.log(`[daemon] notify=${opts.notify}  force=${opts.force}`);
  console.log(`[daemon] First run at next cron tick. Waiting...`);

  cron.schedule(
    schedule,
    async () => {
      console.log(`[daemon] ⏰ Cron fired at ${new Date().toISOString()}`);
      try {
        await runPipeline({
          outputMode: "both",
          notify: opts.notify,
          force: opts.force,
        });
      } catch (err) {
        console.error("[daemon] Pipeline error:", err);
      }
    },
    { timezone: TIMEZONE }
  );

  // Keep the process alive
  process.stdin.resume();
}
