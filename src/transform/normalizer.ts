/**
 * Normalizer — Deduplication, cleaning, and topic clustering
 *
 * Clustering is fully dynamic — no hardcoded topic keywords.
 * Topics are derived from the keywords and subreddits supplied
 * by the operator in each run request.
 *
 * Phase 1 scope:
 * - Deduplicate posts by ID across all sources
 * - Sort by score descending
 * - Cluster into topics via keyword matching against run config
 * - Return top 10 topics with aggregate scores
 */

import type { NormalizedXpozPost } from "../ingest/xpoz-client.js";
import type { IngestResult } from "../ingest/ingestor.js";
import type { TopicConfig } from "../../config.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DeduplicatedPost extends NormalizedXpozPost {
  subreddits: string[];   // all subreddits where this post appeared
  fetchSources: string[]; // 'subreddit:X' or 'keyword:Y' or 'twitter:Z'
  platform: "reddit" | "twitter";
}

export interface Topic {
  rank: number;
  title: string;
  posts: DeduplicatedPost[];
  aggregateScore: number;
  totalComments: number;
  subreddits: string[];
  representative: DeduplicatedPost;
}

export interface NormalizeResult {
  posts: DeduplicatedPost[];
  topics: Topic[];
  stats: {
    rawPostCount: number;
    afterDedup: number;
    topicCount: number;
  };
}

/**
 * Dynamic cluster definition built from the run's topicConfig.
 * Each keyword from the request becomes its own cluster label.
 * Posts are matched against their fetch source first (keyword:X),
 * then by text scan as fallback.
 */
interface DynamicCluster {
  title: string;       // display name (capitalized keyword)
  matchTerms: string[]; // lowercase terms to match in post text
  sourceKey: string;   // fetch source key, e.g. "keyword:bitcoin price"
}

// ─── Deduplication ────────────────────────────────────────────────────────────

function deduplicatePosts(results: IngestResult[]): DeduplicatedPost[] {
  const seen = new Map<string, DeduplicatedPost>();

  for (const result of results) {
    const source = result.source === "keyword"
      ? `keyword:${result.keyword}`
      : `subreddit:${result.subreddit}`;

    for (const post of result.posts) {
      const key = post.id;
      if (!key || !post.title) continue;

      const platform: "reddit" | "twitter" = post.id.startsWith("tw_") ? "twitter" : "reddit";

      if (seen.has(key)) {
        const existing = seen.get(key)!;
        if (!existing.fetchSources.includes(source)) existing.fetchSources.push(source);
        if (!existing.subreddits.includes(post.subreddit)) existing.subreddits.push(post.subreddit);
        if (post.score > existing.score) existing.score = post.score;
      } else {
        seen.set(key, {
          ...post,
          subreddits: [post.subreddit],
          fetchSources: [source],
          platform,
        });
      }
    }
  }

  return Array.from(seen.values()).sort((a, b) => b.score - a.score);
}

// ─── Dynamic Cluster Builder ──────────────────────────────────────────────────

/**
 * Build clusters from the run's topicConfig — no hardcoded keywords.
 *
 * Strategy (priority order):
 * 1. One cluster per keyword from topicConfig.keywords
 * 2. One cluster per subreddit from topicConfig.subreddits (for posts that
 *    didn't match any keyword)
 * 3. "Other / Emerging" for posts that match nothing
 *
 * Cluster title = the keyword / subreddit name (title-cased).
 */
function buildClusters(topicConfig: TopicConfig): DynamicCluster[] {
  const clusters: DynamicCluster[] = [];

  for (const kw of topicConfig.keywords) {
    const normalized = kw.toLowerCase().trim();
    clusters.push({
      title: kw
        .split(" ")
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(" "),
      matchTerms: [normalized],
      sourceKey: `keyword:${normalized}`,
    });
  }

  for (const sr of topicConfig.subreddits) {
    clusters.push({
      title: `r/${sr}`,
      matchTerms: [sr.toLowerCase()],
      sourceKey: `subreddit:${sr}`,
    });
  }

  return clusters;
}

/**
 * Assign a post to its best cluster.
 *
 * Priority:
 * 1. Exact fetch-source match (post came from that keyword/subreddit query)
 * 2. Text match in title + selftext
 * 3. "Other / Emerging"
 */
function matchCluster(post: DeduplicatedPost, clusters: DynamicCluster[]): string {
  // 1. Source match — most reliable
  for (const cluster of clusters) {
    if (post.fetchSources.some((s) => s === cluster.sourceKey)) {
      return cluster.title;
    }
  }

  // 2. Text match fallback
  const text = `${post.title} ${post.selftext ?? ""}`.toLowerCase();
  for (const cluster of clusters) {
    if (cluster.matchTerms.some((term) => text.includes(term))) {
      return cluster.title;
    }
  }

  return "Other / Emerging";
}

function groupIntoTopics(posts: DeduplicatedPost[], topicConfig: TopicConfig): Topic[] {
  const clusters = buildClusters(topicConfig);
  const buckets = new Map<string, DeduplicatedPost[]>();

  for (const post of posts) {
    const label = matchCluster(post, clusters);
    if (!buckets.has(label)) buckets.set(label, []);
    buckets.get(label)!.push(post);
  }

  const topics: Topic[] = [];

  for (const [title, clusterPosts] of buckets.entries()) {
    if (clusterPosts.length === 0) continue;
    const sorted = [...clusterPosts].sort((a, b) => b.score - a.score);
    topics.push({
      rank: 0,
      title,
      posts: sorted,
      aggregateScore: clusterPosts.reduce((s, p) => s + p.score, 0),
      totalComments: clusterPosts.reduce((s, p) => s + p.numComments, 0),
      subreddits: [...new Set(clusterPosts.flatMap((p) => p.subreddits))],
      representative: sorted[0],
    });
  }

  topics.sort((a, b) => b.aggregateScore - a.aggregateScore);
  topics.forEach((t, i) => (t.rank = i + 1));
  return topics;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export function normalize(results: IngestResult[], topicConfig: TopicConfig): NormalizeResult {
  const rawPostCount = results.reduce((s, r) => s + r.posts.length, 0);
  const posts = deduplicatePosts(results);
  const topics = groupIntoTopics(posts, topicConfig);

  console.log(`[normalizer] ${rawPostCount} raw → ${posts.length} unique → ${topics.length} clusters`);

  return {
    posts,
    topics: topics.slice(0, 10),
    stats: { rawPostCount, afterDedup: posts.length, topicCount: topics.length },
  };
}
