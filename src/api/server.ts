/**
 * API Server — Xpoz Intelligence Pipeline
 *
 * Hono HTTP server exposing pipeline data to Jarvis and other consumers.
 * Runs on port 8086 (localhost only — not exposed publicly).
 *
 * Endpoints:
 *   GET /health          → service status + last run info
 *   GET /runs            → list of all runs with stats
 *   GET /topics/latest   → top topics from last run (JSON)
 *   GET /digest/latest   → markdown digest from last run (text/plain)
 *   POST /run            → trigger a pipeline run on-demand
 */

import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { getDb } from "../store/db.js";
import { getAllRuns, getLastRun, getTopicsForRun } from "../store/queries.js";
import { runPipeline } from "../pipeline.js";
// CONFIG available if needed for future env-based port config

// ─── App ──────────────────────────────────────────────────────────────────────

const app = new Hono();

// ─── Health ───────────────────────────────────────────────────────────────────

app.get("/health", (c) => {
  const lastRun = getLastRun();
  return c.json({
    status: "ok",
    service: "xpoz-intelligence-pipeline",
    version: "1.0.0",
    lastRun: lastRun
      ? {
          id: lastRun.id,
          startedAt: lastRun.started_at,
          durationMs: lastRun.duration_ms,
          uniquePostCount: lastRun.unique_post_count,
          topicCount: lastRun.topic_count,
        }
      : null,
    uptime: Math.floor(process.uptime()),
  });
});

// ─── Runs ─────────────────────────────────────────────────────────────────────

app.get("/runs", (c) => {
  const runs = getAllRuns();
  return c.json({
    count: runs.length,
    runs: runs.map((r) => ({
      id: r.id,
      startedAt: r.started_at,
      durationMs: r.duration_ms,
      rawPostCount: r.raw_post_count,
      uniquePostCount: r.unique_post_count,
      topicCount: r.topic_count,
    })),
  });
});

// ─── Topics latest ────────────────────────────────────────────────────────────

app.get("/topics/latest", (c) => {
  const lastRun = getLastRun();
  if (!lastRun) {
    return c.json({ error: "No runs available yet" }, 404);
  }

  const topics = getTopicsForRun(lastRun.id);
  return c.json({
    runId: lastRun.id,
    runAt: lastRun.started_at,
    topicCount: topics.length,
    topics: topics.map((t) => ({
      rank: t.rank,
      title: t.title,
      aggregateScore: t.aggregate_score,
      postCount: t.post_count,
      subreddits: JSON.parse(t.subreddits as string),
    })),
  });
});

// ─── Digest latest ────────────────────────────────────────────────────────────

app.get("/digest/latest", (c) => {
  const lastRun = getLastRun();
  if (!lastRun) {
    return c.text("No runs available yet", 404);
  }

  // Try to find the markdown file for the last run
  const outputDir = join(process.cwd(), "output");
  const runDate = lastRun.started_at.split("T")[0];

  // Look for files matching run-N.md pattern
  const candidateFiles = [
    join(outputDir, `run-${lastRun.id}.md`),
    // fallback: find any .md with date prefix
  ];

  for (const filePath of candidateFiles) {
    if (existsSync(filePath)) {
      const content = readFileSync(filePath, "utf-8");
      return c.text(content, 200, { "Content-Type": "text/markdown; charset=utf-8" });
    }
  }

  // Generate on-the-fly from DB if file not found
  const topics = getTopicsForRun(lastRun.id);
  const lines = [
    `# Xpoz Intelligence Digest`,
    `**Run:** #${lastRun.id} · ${lastRun.started_at}`,
    `**Posts:** ${lastRun.unique_post_count} · **Topics:** ${lastRun.topic_count}`,
    "",
    "## Top Topics",
    "",
    ...topics.map(
      (t, i) =>
        `${i + 1}. **${t.title}** — score: ${t.aggregate_score.toLocaleString()} (${t.post_count} posts)`
    ),
  ];
  return c.text(lines.join("\n"), 200, {
    "Content-Type": "text/markdown; charset=utf-8",
  });
});

// ─── On-demand run ────────────────────────────────────────────────────────────

let runInProgress = false;

app.post("/run", async (c) => {
  if (runInProgress) {
    return c.json({ error: "A run is already in progress" }, 409);
  }

  const body = await c.req.json().catch(() => ({}));
  const notify = body.notify === true;
  const force = body.force === true;
  const topic = typeof body.topic === "string" ? body.topic : undefined;

  runInProgress = true;

  // Fire-and-forget — returns immediately, run happens async
  (async () => {
    try {
      console.log(`[API] On-demand run triggered via POST /run${topic ? ` (topic: ${topic})` : ""}`);
      await runPipeline({ notify, force, outputMode: "both", closeDb: false, topic });
      console.log("[API] On-demand run completed");
    } catch (err) {
      console.error("[API] On-demand run failed:", err);
    } finally {
      runInProgress = false;
    }
  })();

  return c.json({
    status: "started",
    topic: topic ?? "longevity",
    message: "Pipeline run started. Poll GET /health or GET /topics/latest for results.",
    estimatedDurationSec: 90,
  });
});

// ─── Run status ───────────────────────────────────────────────────────────────

app.get("/run/status", (c) => {
  return c.json({
    inProgress: runInProgress,
  });
});

// ─── Start server ─────────────────────────────────────────────────────────────

export function startApiServer(port = 8086): void {
  serve({ fetch: app.fetch, port }, () => {
    console.log(`[API] Xpoz Intelligence Pipeline API listening on port ${port}`);
  });
}
