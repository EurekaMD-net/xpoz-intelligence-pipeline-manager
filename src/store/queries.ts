/**
 * Typed query helpers — Xpoz Intelligence Pipeline
 *
 * All DB access goes through these functions. No raw SQL outside this file.
 */

import { getDb } from "./db.js";
import type { Topic } from "../transform/normalizer.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RunRow {
  id: number;
  started_at: string;
  duration_ms: number;
  raw_post_count: number;
  unique_post_count: number;
  topic_count: number;
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

export function insertRun(params: Omit<RunRow, "id">): number {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO runs (started_at, duration_ms, raw_post_count, unique_post_count, topic_count)
    VALUES (@started_at, @duration_ms, @raw_post_count, @unique_post_count, @topic_count)
  `);
  const result = stmt.run(params);
  return result.lastInsertRowid as number;
}

export function getLastRun(): RunRow | null {
  const db = getDb();
  return (db.prepare(`SELECT * FROM runs ORDER BY id DESC LIMIT 1`).get() as RunRow) ?? null;
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
          created_at: post.createdUtc > 0
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
