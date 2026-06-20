/**
 * API Server — Xpoz Intelligence Pipeline
 *
 * Hono HTTP server exposing pipeline data to Jarvis and other consumers.
 * Runs on port 8086 (localhost only — not exposed publicly).
 *
 * Endpoints:
 *   GET  /health              → service status + last run info
 *   GET  /credits             → credit budget summary
 *   GET  /runs                → list of all runs with stats
 *   GET  /topics/latest       → top topics from last run (JSON)
 *   GET  /digest/latest       → markdown digest from last run (text/plain)
 *   POST /run                 → trigger a pipeline run; returns {jobId}
 *   GET  /run/status          → boolean "is a run in progress" (backward-compat)
 *   GET  /run/jobs            → list recent jobs (last 50)
 *   GET  /run/jobs/:jobId     → status + result/error for a specific job
 *   POST /reset               → wipe DB (auth-gated)
 *
 * Auth:
 *   Mutating endpoints (POST /run, POST /reset) require header
 *   `X-Xpoz-Token: <env.XPOZ_API_TOKEN>` when XPOZ_API_TOKEN is set.
 *   If the env var is unset, auth is disabled (dev convenience).
 */

import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { serve } from "@hono/node-server";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { randomUUID, timingSafeEqual } from "crypto";
import {
  getAllRuns,
  getLastRun,
  getTopicsForRun,
  getCreditSummary,
  clearAllData,
} from "../store/queries.js";
import { runPipeline } from "../pipeline.js";
import type { PipelineResult } from "../pipeline.js";
import type { TopicConfig } from "../../config.js";
import { searchByKeyword } from "../ingest/xpoz-client.js";

// ─── App ──────────────────────────────────────────────────────────────────────

const app = new Hono();

// ─── Auth middleware ──────────────────────────────────────────────────────────

/**
 * Read the active API token at request time — do NOT cache at module load.
 * This lets operator scripts that re-write the .env + restart pick up the new
 * token; also keeps the /health `authEnabled` flag honest with current env.
 */
function currentApiToken(): string {
  return process.env.XPOZ_API_TOKEN ?? "";
}

/** Constant-time string compare; returns false on length mismatch. */
function tokensEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return timingSafeEqual(ba, bb);
}

/**
 * Reject requests missing a valid X-Xpoz-Token header.
 * No-op when XPOZ_API_TOKEN is not configured — allows dev-mode local testing.
 */
const requireToken: MiddlewareHandler = async (c, next) => {
  const token = currentApiToken();
  if (!token) return next(); // Dev mode: auth disabled
  const provided = c.req.header("X-Xpoz-Token") ?? "";
  if (!tokensEqual(provided, token)) {
    return c.json(
      { error: "Unauthorized — provide a valid X-Xpoz-Token header." },
      401,
    );
  }
  return next();
};

// ─── Job tracking ─────────────────────────────────────────────────────────────

type JobStatus = "running" | "completed" | "failed";

interface JobRecord {
  jobId: string;
  status: JobStatus;
  label: string;
  subreddits: string[];
  keywords: string[];
  twitterKeywords: string[];
  startedAt: string;
  completedAt?: string;
  result?: PipelineResult;
  error?: string;
}

const JOBS = new Map<string, JobRecord>();
const MAX_JOBS = 50; // keep only last 50 in memory
const JOB_TTL_MS = 60 * 60 * 1000; // prune jobs older than 1h

function recordJob(job: JobRecord): void {
  JOBS.set(job.jobId, job);
  pruneJobs();
}

// Beyond this age a "running" job is considered stale (runPipeline hung
// or crashed before flipping status). Stale jobs are promoted to "failed"
// so pruneJobs can evict them and `/run` isn't blocked by a dead slot.
const STALE_RUNNING_MS = 2 * 60 * 60 * 1000; // 2 hours

function pruneJobs(): void {
  const now = Date.now();
  const cutoff = now - JOB_TTL_MS;
  const staleCutoff = now - STALE_RUNNING_MS;

  // Pass 1 — promote jobs stuck in "running" past the stale cutoff to "failed".
  // This guards against runPipeline's timeout wrapper failing to update the
  // record (unexpected synchronous throw inside the IIFE, GC'd promise, etc.)
  for (const job of JOBS.values()) {
    if (job.status === "running" && Date.parse(job.startedAt) < staleCutoff) {
      job.status = "failed";
      job.completedAt = new Date().toISOString();
      job.error =
        job.error ??
        `job stale — no status update within ${STALE_RUNNING_MS}ms`;
    }
  }

  // Pass 2 — TTL prune terminal jobs older than 1h.
  for (const [id, job] of JOBS) {
    const started = Date.parse(job.startedAt);
    if (job.status !== "running" && started < cutoff) {
      JOBS.delete(id);
    }
  }

  // Pass 3 — hard cap on map size. Drop oldest terminal jobs first; if still
  // over 2× cap with only running jobs, force-promote the oldest running ones
  // to "failed:evicted" so memory doesn't grow unbounded under pathological
  // load (W1 in audit).
  if (JOBS.size > MAX_JOBS) {
    const sorted = [...JOBS.entries()].sort(
      (a, b) => Date.parse(a[1].startedAt) - Date.parse(b[1].startedAt),
    );
    for (const [id, job] of sorted) {
      if (JOBS.size <= MAX_JOBS) break;
      if (job.status !== "running") JOBS.delete(id);
    }
    if (JOBS.size > MAX_JOBS * 2) {
      for (const [id, job] of sorted) {
        if (JOBS.size <= MAX_JOBS) break;
        if (job.status === "running") {
          job.status = "failed";
          job.completedAt = new Date().toISOString();
          job.error = job.error ?? "evicted — job map exceeded 2× capacity";
          JOBS.delete(id);
        }
      }
    }
  }
}

// ─── Health ───────────────────────────────────────────────────────────────────

app.get("/health", (c) => {
  const lastRun = getLastRun();
  const credits = getCreditSummary();
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
          creditsUsed: lastRun.credits_used,
        }
      : null,
    credits: {
      used: credits.totalCreditsUsed,
      remaining: credits.totalCreditsRemaining,
      total: credits.planCreditsTotal,
      percentUsed: credits.percentUsed,
    },
    uptime: Math.floor(process.uptime()),
    authEnabled: !!currentApiToken(),
  });
});

// ─── Credits ──────────────────────────────────────────────────────────────────

app.get("/credits", (c) => {
  const summary = getCreditSummary();
  return c.json(summary);
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

  // Look for files matching run-N.md pattern
  const candidateFiles = [
    join(outputDir, `run-${lastRun.id}.md`),
    // fallback: find any .md with date prefix
  ];

  for (const filePath of candidateFiles) {
    if (existsSync(filePath)) {
      const content = readFileSync(filePath, "utf-8");
      return c.text(content, 200, {
        "Content-Type": "text/markdown; charset=utf-8",
      });
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
        `${i + 1}. **${t.title}** — score: ${t.aggregate_score.toLocaleString()} (${t.post_count} posts)`,
    ),
  ];
  return c.text(lines.join("\n"), 200, {
    "Content-Type": "text/markdown; charset=utf-8",
  });
});

// ─── On-demand run ────────────────────────────────────────────────────────────

let runInProgress = false;
// Hard cap on how long a single pipeline run is allowed to hold the flag.
// Beyond this we stop waiting, mark the job failed, and free the slot so the
// next request isn't blocked by a hung fetch inside the ingest layer.
const RUN_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

app.post("/run", requireToken, async (c) => {
  // Claim the in-progress slot SYNCHRONOUSLY before any await to prevent
  // two concurrent POSTs both passing the guard and starting two pipelines.
  if (runInProgress) {
    return c.json({ error: "A run is already in progress" }, 409);
  }
  runInProgress = true;
  // On any early-return path below (validation errors), release the slot.
  const releaseSlot = () => {
    runInProgress = false;
  };

  let body: Record<string, unknown>;
  try {
    body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  } catch {
    releaseSlot();
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  // notify / force must be boolean if provided — string "true" should not
  // silently coerce to false. Reject mixed types with 400 (W5).
  if (body.notify !== undefined && typeof body.notify !== "boolean") {
    releaseSlot();
    return c.json({ error: "'notify' must be a boolean (true|false)." }, 400);
  }
  if (body.force !== undefined && typeof body.force !== "boolean") {
    releaseSlot();
    return c.json({ error: "'force' must be a boolean (true|false)." }, 400);
  }
  const notify = body.notify === true;
  // When operator explicitly requests notify, always force-send (no delta gating)
  const force = body.force === true || notify;

  // Validate: at least subreddits or keywords must be provided
  const subreddits: string[] = Array.isArray(body.subreddits)
    ? (body.subreddits as string[])
    : [];
  const keywords: string[] = Array.isArray(body.keywords)
    ? (body.keywords as string[])
    : [];

  if (
    subreddits.length === 0 &&
    keywords.length === 0 &&
    (!Array.isArray(body.twitterKeywords) ||
      (body.twitterKeywords as unknown[]).length === 0)
  ) {
    releaseSlot();
    return c.json(
      {
        error:
          "Run requires at least one of: 'subreddits', 'keywords', or 'twitterKeywords'.",
      },
      400,
    );
  }

  // Build TopicConfig inline from request
  const twitterKeywords: string[] | undefined = Array.isArray(
    body.twitterKeywords,
  )
    ? (body.twitterKeywords as string[])
    : undefined;

  // allowlist: explicit array OR union of subreddits + keywords as fallback
  const allowlist: Set<string> = Array.isArray(body.allowlist)
    ? new Set<string>(body.allowlist as string[])
    : new Set<string>([...subreddits, ...keywords]);

  const label: string =
    typeof body.label === "string" && body.label.trim()
      ? body.label.trim()
      : "Custom Run";

  const topicConfig: TopicConfig = {
    label,
    subreddits,
    keywords,
    allowlist,
    twitterKeywords,
  };

  // Register job before spawning async work
  const jobId = randomUUID();
  const startedAt = new Date().toISOString();
  const job: JobRecord = {
    jobId,
    status: "running",
    label,
    subreddits,
    keywords,
    twitterKeywords: twitterKeywords ?? [],
    startedAt,
  };
  recordJob(job);

  // Fire-and-forget — returns immediately, run happens async.
  // Callers poll GET /run/jobs/:jobId for status or rely on notify:true.
  (async () => {
    try {
      console.log(
        `[API] Job ${jobId} — on-demand run triggered (label: "${label}")`,
      );
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                `runPipeline exceeded ${RUN_TIMEOUT_MS}ms timeout — aborting slot`,
              ),
            ),
          RUN_TIMEOUT_MS,
        ).unref(),
      );
      const result = await Promise.race([
        runPipeline({
          notify,
          force,
          outputMode: "both",
          closeDb: false,
          topicConfig,
        }),
        timeout,
      ]);
      job.status = "completed";
      job.completedAt = new Date().toISOString();
      job.result = result;
      console.log(
        `[API] Job ${jobId} — completed (run #${result.runId}, ${result.topicCount} topics)`,
      );
    } catch (err) {
      job.status = "failed";
      job.completedAt = new Date().toISOString();
      job.error = err instanceof Error ? err.message : String(err);
      console.error(`[API] Job ${jobId} — failed:`, err);
    } finally {
      runInProgress = false;
    }
  })();

  return c.json({
    jobId,
    status: "started",
    label,
    subreddits,
    keywords,
    twitterKeywords: twitterKeywords ?? [],
    message: `Pipeline run started. Poll GET /run/jobs/${jobId} for status.`,
    estimatedDurationSec: 90,
  });
});

// ─── Keyword search (synchronous, per-keyword) ────────────────────────────────
//
// Thin wrapper over `searchByKeyword()` from xpoz-client. Exists so callers
// that need per-term Reddit confluence data (e.g. williams-entry-radar S2
// ticker enrichment) don't have to reimplement the MCP protocol or bundle
// the bearer token. Auth-gated on X-Xpoz-Token like /run.
//
// One keyword per request — keeps timeouts and error handling per-term so one
// hung ticker doesn't poison the whole batch.

const SEARCH_TIMEOUT_MS = 90_000;

app.post("/search/keyword", requireToken, async (c) => {
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const keyword = typeof body.keyword === "string" ? body.keyword.trim() : "";
  if (!keyword) {
    return c.json({ error: "'keyword' is required (non-empty string)." }, 400);
  }

  // Reject non-finite / non-positive limit explicitly — otherwise
  // Math.max(1, Math.min(100, NaN)) === NaN → .slice(0, NaN) === []
  // would silently return empty results instead of surfacing the misuse.
  const limitRaw = body.limit === undefined ? 25 : body.limit;
  if (
    typeof limitRaw !== "number" ||
    !Number.isFinite(limitRaw) ||
    limitRaw < 1
  ) {
    return c.json(
      { error: "'limit' must be a finite positive number (1-100)." },
      400,
    );
  }
  const limit = Math.min(100, Math.floor(limitRaw));

  try {
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(
        () =>
          reject(
            new Error(
              `searchByKeyword("${keyword}") exceeded ${SEARCH_TIMEOUT_MS}ms`,
            ),
          ),
        SEARCH_TIMEOUT_MS,
      ).unref(),
    );
    const posts = await Promise.race([searchByKeyword(keyword), timeout]);

    const sorted = [...posts]
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, limit);
    const top = sorted[0];

    return c.json({
      keyword,
      postCount: sorted.length,
      topPost: top
        ? {
            title: top.title,
            score: top.score,
            subreddit: top.subreddit,
            url: top.url,
          }
        : null,
      posts: sorted.map((p) => ({
        title: p.title,
        score: p.score,
        subreddit: p.subreddit,
        url: p.url,
        createdUtc: p.createdUtc,
      })),
    });
  } catch (err) {
    // Full error (URLs, tokens, stack frames) goes to the journal — not the
    // response body. Callers get an opaque tag so logs that make it to public
    // surfaces (GitHub commit bodies, signals.md snippets) can't leak the
    // upstream MCP URL or any credential material.
    const msg = err instanceof Error ? err.message : String(err);
    const isTimeout = /exceeded \d+ms/.test(msg);
    console.warn(`[API] /search/keyword "${keyword}" failed:`, msg);
    return c.json(
      {
        error: isTimeout ? "Keyword search timed out" : "Keyword search failed",
        keyword,
      },
      502,
    );
  }
});

// ─── Run status (backward-compat: boolean) ────────────────────────────────────

app.get("/run/status", (c) => {
  return c.json({
    inProgress: runInProgress,
  });
});

// ─── Jobs ─────────────────────────────────────────────────────────────────────

app.get("/run/jobs", (c) => {
  pruneJobs();
  const jobs = [...JOBS.values()].sort(
    (a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt),
  );
  return c.json({ count: jobs.length, jobs });
});

app.get("/run/jobs/:jobId", (c) => {
  const jobId = c.req.param("jobId");
  const job = JOBS.get(jobId);
  if (!job) {
    return c.json({ error: `Job ${jobId} not found` }, 404);
  }
  return c.json(job);
});

// ─── Reset ────────────────────────────────────────────────────────────────────

app.post("/reset", requireToken, (c) => {
  if (runInProgress) {
    return c.json({ error: "A run is in progress — cannot reset now" }, 409);
  }
  const result = clearAllData();
  console.log(
    `[API] /reset called — cleared ${result.deletedRuns} runs, ${result.deletedTopics} topics, ${result.deletedPosts} posts`,
  );
  return c.json({
    cleared: true,
    tables: ["runs", "topics", "topic_posts"],
    ...result,
  });
});

// ─── Start server ─────────────────────────────────────────────────────────────

export function startApiServer(port = 8086): void {
  if (!currentApiToken()) {
    console.warn(
      "[API] XPOZ_API_TOKEN not set — auth is DISABLED. Set it in .env for production.",
    );
  } else {
    console.log(
      `[API] Auth enabled — X-Xpoz-Token required on POST /run and POST /reset.`,
    );
  }
  serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, () => {
    console.log(
      `[API] Xpoz Intelligence Pipeline API listening on 127.0.0.1:${port}`,
    );
  });
}
