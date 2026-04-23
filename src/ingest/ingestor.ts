/**
 * Ingestor — Parallel multi-subreddit orchestrator
 *
 * Calls Xpoz API in parallel (batched) for all configured subreddits and keywords.
 * Returns a flat array of normalized posts with source metadata.
 */

import { getTopicConfig, XPOZ_CONFIG, type TopicConfig } from "../../config.js";
import { getSubredditPosts, searchByKeyword, type NormalizedXpozPost } from "./xpoz-client.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface IngestResult {
  subreddit: string;
  source: "subreddit" | "keyword";
  keyword?: string;
  posts: NormalizedXpozPost[];
  fetchedAt: number;
  error?: string;
}

export interface IngestSummary {
  results: IngestResult[];
  totalFetched: number;
  totalErrors: number;
  durationMs: number;
  startedAt: number;
}

// ─── Safe fetch wrapper ───────────────────────────────────────────────────────

async function safeFetch<T>(
  label: string,
  fn: () => Promise<T>
): Promise<{ label: string; data?: T; error?: string }> {
  try {
    const data = await fn();
    return { label, data };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { label, error: message };
  }
}

// ─── Batch runner ─────────────────────────────────────────────────────────────

async function runInBatches<T>(
  tasks: Array<() => Promise<T>>,
  batchSize: number,
  delayMs = 500
): Promise<T[]> {
  const results: T[] = [];
  for (let i = 0; i < tasks.length; i += batchSize) {
    const batch = tasks.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map((fn) => fn()));
    results.push(...batchResults);
    if (i + batchSize < tasks.length) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  return results;
}

// ─── Main Ingestor ────────────────────────────────────────────────────────────

export async function ingestAll(topicOverride?: string | TopicConfig): Promise<IngestSummary> {
  const topicCfg: TopicConfig =
    typeof topicOverride === "object" && topicOverride !== null
      ? topicOverride
      : getTopicConfig(typeof topicOverride === "string" ? topicOverride : undefined);

  const { subreddits, keywords, allowlist, label } = topicCfg;

  const startedAt = Date.now();
  console.log(`[ingestor] Starting — topic: "${label}" — ${subreddits.length} subreddits + ${keywords.length} keywords`);
  console.log(`[ingestor] Score filter: ≥ ${XPOZ_CONFIG.minScore}`);

  const subredditTasks = subreddits.map((sub) => () =>
    safeFetch(`subreddit:${sub}`, () => getSubredditPosts(sub))
  );

  const keywordTasks = keywords.map((kw) => () =>
    safeFetch(`keyword:${kw}`, () => searchByKeyword(kw))
  );

  // Run sequentially in small batches (Xpoz is async/polling — don't parallelize too much)
  console.log("[ingestor] Fetching subreddits (batch=2)...");
  const subRaw = await runInBatches(subredditTasks, 2, 1000);

  console.log("[ingestor] Fetching keywords (batch=2)...");
  const kwRaw = await runInBatches(keywordTasks, 2, 1000);

  const results: IngestResult[] = [];

  for (const raw of subRaw) {
    const subName = raw.label.replace("subreddit:", "");
    if (raw.error) {
      console.warn(`[ingestor] ❌ r/${subName}: ${raw.error}`);
      results.push({ subreddit: subName, source: "subreddit", posts: [], fetchedAt: Date.now(), error: raw.error });
    } else {
      const posts = (raw.data ?? []).filter((p) => p.score >= XPOZ_CONFIG.minScore);
      console.log(`[ingestor] ✅ r/${subName}: ${posts.length} posts (score ≥ ${XPOZ_CONFIG.minScore})`);
      results.push({ subreddit: subName, source: "subreddit", posts, fetchedAt: Date.now() });
    }
  }

  for (const raw of kwRaw) {
    const kw = raw.label.replace("keyword:", "");
    if (raw.error) {
      console.warn(`[ingestor] ❌ keyword:"${kw}": ${raw.error}`);
      results.push({ subreddit: "search", source: "keyword", keyword: kw, posts: [], fetchedAt: Date.now(), error: raw.error });
    } else {
      // Filter keyword results to relevant subreddits only (keyword search returns all of Reddit)
      const allPosts = raw.data ?? [];
      const posts = allPosts.filter((p) => allowlist.has(p.subreddit));
      const filtered = allPosts.length - posts.length;
      console.log(`[ingestor] ✅ keyword:"${kw}": ${posts.length} posts (${filtered} filtered — off-topic subreddits)`);
      results.push({ subreddit: "search", source: "keyword", keyword: kw, posts, fetchedAt: Date.now() });
    }
  }

  const totalFetched = results.reduce((s, r) => s + r.posts.length, 0);
  const totalErrors = results.filter((r) => r.error).length;
  const durationMs = Date.now() - startedAt;

  console.log(`[ingestor] Done — ${totalFetched} posts, ${totalErrors} errors, ${(durationMs / 1000).toFixed(1)}s`);
  return { results, totalFetched, totalErrors, durationMs, startedAt };
}
