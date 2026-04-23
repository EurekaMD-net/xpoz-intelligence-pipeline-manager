/**
 * Typed query helpers — Xpoz Intelligence Pipeline
 *
 * All DB access goes through these functions. No raw SQL outside this file.
 */

import { getDb } from "./db.js";
import { PLAN_CREDITS_TOTAL } from "./schema.js";
import type { Topic } from "../transform/normalizer.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RunRow {
  id: number;
  started_at: string;
  duration_ms: number;
  raw_post_count: number;
  unique_post_count: number;
  topic_count: number;
  credits_used: number;
  queries_count: number;
}

export interface CreditSummary {
  totalCreditsUsed: number;
  totalCreditsRemaining: number;
  planCreditsTotal: number;
  percentUsed: number;
  runCount: number;
  history: Array<{
    runId: number;
    startedAt: string;
    creditsUsed: number;
    queriesCount: number;
    postsRaw: number;
  }>;
}

export interface TopicRow {
  id: number;
  run_id: number;
  rank: number;
  title: string;
  aggregate_score: number;
  post_count: number;
  subreddits: string; // JSON string
}

// ─── Runs ─────────────────────────────────────────────────────────────────────

/**
 * Retention: keep the last N runs (and their topics + topic_posts). Older
 * runs are deleted in a single transaction. Default 90 runs = ~3 months of
 * daily ingest, which is enough history for delta trend analysis without
 * letting the SQLite file grow unbounded now that clearAllData() has been
 * removed from the pipeline's step-0 (see audit M4).
 */
export const DEFAULT_RETENTION_KEEP = 90;

export function insertRun(params: Omit<RunRow, "id">): number {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO runs (started_at, duration_ms, raw_post_count, unique_post_count, topic_count, credits_used, queries_count)
    VALUES (@started_at, @duration_ms, @raw_post_count, @unique_post_count, @topic_count, @credits_used, @queries_count)
  `);
  const result = stmt.run(params);
  const runId = result.lastInsertRowid as number;
  // Retention is cheap (bounded by keepN) and ensures the DB doesn't grow
  // indefinitely. Errors are swallowed — the insert itself must not fail.
  try {
    pruneOldRuns(DEFAULT_RETENTION_KEEP);
  } catch (err) {
    console.warn(
      `[queries] pruneOldRuns failed (non-fatal):`,
      err instanceof Error ? err.message : err,
    );
  }
  return runId;
}

/**
 * Delete all runs older than the most recent `keepN` (by id, which is
 * monotonically increasing via AUTOINCREMENT). Cascades to topics and
 * topic_posts via explicit DELETEs (no ON DELETE CASCADE in the schema).
 * Runs inside a transaction; returns counts.
 */
export function pruneOldRuns(keepN: number): {
  deletedRuns: number;
  deletedTopics: number;
  deletedPosts: number;
} {
  const db = getDb();
  const cutoffRow = db
    .prepare(`SELECT id FROM runs ORDER BY id DESC LIMIT 1 OFFSET ?`)
    .get(keepN) as { id: number } | undefined;
  if (!cutoffRow) {
    return { deletedRuns: 0, deletedTopics: 0, deletedPosts: 0 };
  }
  const cutoffId = cutoffRow.id;
  let deletedPosts = 0;
  let deletedTopics = 0;
  let deletedRuns = 0;
  db.transaction(() => {
    deletedPosts = db
      .prepare(
        `DELETE FROM topic_posts WHERE topic_id IN (
           SELECT id FROM topics WHERE run_id <= ?
         )`,
      )
      .run(cutoffId).changes;
    deletedTopics = db
      .prepare(`DELETE FROM topics WHERE run_id <= ?`)
      .run(cutoffId).changes;
    deletedRuns = db
      .prepare(`DELETE FROM runs WHERE id <= ?`)
      .run(cutoffId).changes;
  })();
  if (deletedRuns > 0) {
    console.log(
      `[queries] Retention: pruned ${deletedRuns} runs, ${deletedTopics} topics, ${deletedPosts} posts (kept last ${keepN})`,
    );
  }
  return { deletedRuns, deletedTopics, deletedPosts };
}

export function getLastRun(): RunRow | null {
  const db = getDb();
  return (
    (db
      .prepare(`SELECT * FROM runs ORDER BY id DESC LIMIT 1`)
      .get() as RunRow) ?? null
  );
}

export function getPreviousRun(currentRunId: number): RunRow | null {
  const db = getDb();
  return (
    (db
      .prepare(`SELECT * FROM runs WHERE id < ? ORDER BY id DESC LIMIT 1`)
      .get(currentRunId) as RunRow) ?? null
  );
}

export function getAllRuns(): RunRow[] {
  const db = getDb();
  return db.prepare(`SELECT * FROM runs ORDER BY id DESC`).all() as RunRow[];
}

// ─── Topics ───────────────────────────────────────────────────────────────────

export function insertTopicsForRun(runId: number, topics: Topic[]): void {
  const db = getDb();

  const insertTopic = db.prepare(`
    INSERT INTO topics (run_id, rank, title, aggregate_score, post_count, subreddits)
    VALUES (@run_id, @rank, @title, @aggregate_score, @post_count, @subreddits)
  `);

  const insertPost = db.prepare(`
    INSERT INTO topic_posts (topic_id, reddit_id, title, score, author, subreddit, url, created_at)
    VALUES (@topic_id, @reddit_id, @title, @score, @author, @subreddit, @url, @created_at)
  `);

  // Wrap in a transaction for speed + atomicity
  const insertAll = db.transaction((topicList: Topic[]) => {
    for (const topic of topicList) {
      const topicResult = insertTopic.run({
        run_id: runId,
        rank: topic.rank,
        title: topic.title,
        aggregate_score: topic.aggregateScore,
        post_count: topic.posts.length,
        subreddits: JSON.stringify(topic.subreddits),
      });

      const topicId = topicResult.lastInsertRowid as number;

      for (const post of topic.posts) {
        insertPost.run({
          topic_id: topicId,
          reddit_id: post.id,
          title: post.title,
          score: post.score,
          author: post.author,
          subreddit: post.subreddit,
          url: post.url,
          created_at:
            post.createdUtc > 0
              ? new Date(post.createdUtc * 1000).toISOString()
              : new Date().toISOString(),
        });
      }
    }
  });

  insertAll(topics);
}

export function getTopicsForRun(runId: number): TopicRow[] {
  const db = getDb();
  return db
    .prepare(`SELECT * FROM topics WHERE run_id = ? ORDER BY rank ASC`)
    .all(runId) as TopicRow[];
}

// ─── Cleanup ──────────────────────────────────────────────────────────────────

/**
 * Delete all data associated with a specific run (topics + posts).
 * Safe to call before re-inserting data for the same semantic run.
 * Does NOT delete the run row itself — that is inserted fresh each time.
 */
export function clearRunData(runId: number): void {
  const db = getDb();
  db.transaction(() => {
    // Delete posts first (FK references topic_id)
    db.prepare(
      `
      DELETE FROM topic_posts WHERE topic_id IN (
        SELECT id FROM topics WHERE run_id = ?
      )
    `,
    ).run(runId);
    db.prepare(`DELETE FROM topics WHERE run_id = ?`).run(runId);
    db.prepare(`DELETE FROM runs WHERE id = ?`).run(runId);
  })();
}

/**
 * Truncate ALL pipeline data (runs, topics, topic_posts) and reset
 * the autoincrement counters. Use before a clean-slate run or on
 * explicit /reset requests.
 */
export function clearAllData(): {
  deletedRuns: number;
  deletedTopics: number;
  deletedPosts: number;
} {
  const db = getDb();
  let deletedPosts = 0;
  let deletedTopics = 0;
  let deletedRuns = 0;
  db.transaction(() => {
    deletedPosts = db.prepare(`DELETE FROM topic_posts`).run().changes;
    deletedTopics = db.prepare(`DELETE FROM topics`).run().changes;
    deletedRuns = db.prepare(`DELETE FROM runs`).run().changes;
    // Reset autoincrement sequences
    db.prepare(
      `DELETE FROM sqlite_sequence WHERE name IN ('runs','topics','topic_posts')`,
    ).run();
  })();
  return { deletedRuns, deletedTopics, deletedPosts };
}

// ─── Credits ──────────────────────────────────────────────────────────────────

export function getCreditSummary(): CreditSummary {
  const db = getDb();

  const rows = db
    .prepare(
      `SELECT id, started_at, credits_used, queries_count, raw_post_count
       FROM runs ORDER BY id DESC`,
    )
    .all() as Array<{
    id: number;
    started_at: string;
    credits_used: number;
    queries_count: number;
    raw_post_count: number;
  }>;

  const totalUsed = rows.reduce((sum, r) => sum + (r.credits_used ?? 0), 0);
  const remaining = Math.max(0, PLAN_CREDITS_TOTAL - totalUsed);

  return {
    totalCreditsUsed: Math.round(totalUsed * 100) / 100,
    totalCreditsRemaining: Math.round(remaining * 100) / 100,
    planCreditsTotal: PLAN_CREDITS_TOTAL,
    percentUsed: Math.round((totalUsed / PLAN_CREDITS_TOTAL) * 10000) / 100,
    runCount: rows.length,
    history: rows.map((r) => ({
      runId: r.id,
      startedAt: r.started_at,
      creditsUsed: Math.round((r.credits_used ?? 0) * 100) / 100,
      queriesCount: r.queries_count ?? 0,
      postsRaw: r.raw_post_count,
    })),
  };
}
