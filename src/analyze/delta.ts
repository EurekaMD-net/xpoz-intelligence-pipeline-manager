/**
 * Delta Analysis — Xpoz Intelligence Pipeline
 *
 * Compares topics between the current run and the previous run.
 * Each topic is labeled: "new" | "up" | "down" | "stable" | "disappeared"
 *
 * Matching strategy: fuzzy title match (lowercase, trimmed).
 * A topic is considered the "same" if it shares ≥2 significant words
 * OR if titles are within edit-distance 3 (simple word overlap heuristic).
 */

import type { Topic } from "../transform/normalizer.js";
import type { TopicRow } from "../store/queries.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type DeltaStatus = "new" | "up" | "down" | "stable" | "disappeared";

export interface TopicWithDelta extends Topic {
  delta: DeltaStatus;
  previousRank: number | null;
  rankChange: number | null; // positive = improved (moved up), negative = dropped
  scoreDelta: number | null; // percentage change in aggregate_score vs previous run
}

export interface DisappearedTopic {
  title: string;
  previousRank: number;
  previousScore: number;
  delta: "disappeared";
}

export interface DeltaResult {
  topics: TopicWithDelta[];
  disappeared: DisappearedTopic[];
  newCount: number;
  upCount: number;
  downCount: number;
  stableCount: number;
  disappearedCount: number;
}

// ─── Matching helpers ─────────────────────────────────────────────────────────

/** Extract significant words (>3 chars, not stopwords) from a title */
function significantWords(title: string): Set<string> {
  const STOPWORDS = new Set([
    "the", "and", "for", "with", "that", "this", "from", "are", "have",
    "has", "been", "will", "your", "their", "they", "what", "when", "where",
    "how", "new", "study", "shows", "says", "can", "could", "would", "should",
    "more", "most", "some", "our", "its", "not", "but", "also", "may",
  ]);
  return new Set(
    title
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .split(/\s+/)
      .filter((w) => w.length > 3 && !STOPWORDS.has(w))
  );
}

/** Returns true if two topic titles are "similar enough" to be the same topic */
function isSameTopic(titleA: string, titleB: string): boolean {
  const wordsA = significantWords(titleA);
  const wordsB = significantWords(titleB);

  if (wordsA.size === 0 || wordsB.size === 0) return false;

  let overlap = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) overlap++;
  }

  // Match if ≥2 words overlap, OR if Jaccard similarity > 0.35
  const jaccard = overlap / (wordsA.size + wordsB.size - overlap);
  return overlap >= 2 || jaccard > 0.35;
}

// ─── Main delta function ──────────────────────────────────────────────────────

/**
 * Compute delta between current topics and previous run's topics.
 * If no previous run exists, all topics are labeled "new".
 */
export function computeDelta(
  currentTopics: Topic[],
  previousTopics: TopicRow[] | null
): DeltaResult {
  if (!previousTopics || previousTopics.length === 0) {
    // No history — everything is new
    const topics: TopicWithDelta[] = currentTopics.map((t) => ({
      ...t,
      delta: "new" as DeltaStatus,
      previousRank: null,
      rankChange: null,
      scoreDelta: null,
    }));
    return {
      topics,
      disappeared: [],
      newCount: topics.length,
      upCount: 0,
      downCount: 0,
      stableCount: 0,
      disappearedCount: 0,
    };
  }

  // Build match map: currentTopic → previousTopicRow
  const matched = new Map<number, TopicRow>(); // currentTopic.rank → prevRow

  for (const curr of currentTopics) {
    for (const prev of previousTopics) {
      if (isSameTopic(curr.title, prev.title)) {
        matched.set(curr.rank, prev);
        break;
      }
    }
  }

  // Compute delta for each current topic
  const topics: TopicWithDelta[] = currentTopics.map((curr) => {
    const prev = matched.get(curr.rank);

    if (!prev) {
      return {
        ...curr,
        delta: "new" as DeltaStatus,
        previousRank: null,
        rankChange: null,
        scoreDelta: null,
      };
    }

    const rankChange = prev.rank - curr.rank; // positive = moved up
    let delta: DeltaStatus;

    if (rankChange > 1) delta = "up";
    else if (rankChange < -1) delta = "down";
    else delta = "stable";

    // Score change percentage
    const scoreDelta = prev.aggregate_score > 0
      ? Math.round(((curr.aggregateScore - prev.aggregate_score) / prev.aggregate_score) * 100)
      : null;

    return {
      ...curr,
      delta,
      previousRank: prev.rank,
      rankChange,
      scoreDelta,
    };
  });

  // Find disappeared topics (were in previous, not matched in current)
  const matchedPrevIds = new Set(Array.from(matched.values()).map((r) => r.id));
  const disappeared: DisappearedTopic[] = previousTopics
    .filter((prev) => !matchedPrevIds.has(prev.id))
    .map((prev) => ({
      title: prev.title,
      previousRank: prev.rank,
      previousScore: prev.aggregate_score,
      delta: "disappeared" as const,
    }));

  // Counts
  const newCount = topics.filter((t) => t.delta === "new").length;
  const upCount = topics.filter((t) => t.delta === "up").length;
  const downCount = topics.filter((t) => t.delta === "down").length;
  const stableCount = topics.filter((t) => t.delta === "stable").length;

  return {
    topics,
    disappeared,
    newCount,
    upCount,
    downCount,
    stableCount,
    disappearedCount: disappeared.length,
  };
}
