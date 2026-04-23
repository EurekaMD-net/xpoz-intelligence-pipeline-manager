/**
 * SQLite Schema — Xpoz Intelligence Pipeline
 *
 * Tables:
 *   runs        — one row per pipeline execution
 *   topics      — top-N topics discovered per run
 *   topic_posts — posts that belong to each topic (denormalized for query speed)
 */

/**
 * Total credits on the Free plan (one-time, non-renewing).
 * Switch to 30_000 when upgrading to Pro ($20/mo).
 */
export const PLAN_CREDITS_TOTAL = 5_000;

/**
 * Credit cost formula (Xpoz Free/Pro):
 *   credits = (queriesCount × 5) + (postsReturnedRaw × 0.005)
 */
export function calcCredits(queriesCount: number, postsReturnedRaw: number): number {
  return queriesCount * 5 + postsReturnedRaw * 0.005;
}

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS runs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at      TEXT    NOT NULL,  -- ISO 8601
  duration_ms     INTEGER NOT NULL,
  raw_post_count  INTEGER NOT NULL,
  unique_post_count INTEGER NOT NULL,
  topic_count     INTEGER NOT NULL,
  credits_used    REAL    NOT NULL DEFAULT 0,
  queries_count   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS topics (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id          INTEGER NOT NULL REFERENCES runs(id),
  rank            INTEGER NOT NULL,
  title           TEXT    NOT NULL,
  aggregate_score INTEGER NOT NULL,
  post_count      INTEGER NOT NULL,
  subreddits      TEXT    NOT NULL   -- JSON array of subreddit names
);

CREATE TABLE IF NOT EXISTS topic_posts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  topic_id    INTEGER NOT NULL REFERENCES topics(id),
  reddit_id   TEXT    NOT NULL,
  title       TEXT    NOT NULL,
  score       INTEGER NOT NULL,
  author      TEXT    NOT NULL,
  subreddit   TEXT    NOT NULL,
  url         TEXT    NOT NULL,
  created_at  TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_topics_run_id  ON topics(run_id);
CREATE INDEX IF NOT EXISTS idx_topics_title   ON topics(title);
CREATE INDEX IF NOT EXISTS idx_topic_posts_topic_id ON topic_posts(topic_id);
CREATE INDEX IF NOT EXISTS idx_runs_started_at ON runs(started_at);
`;
