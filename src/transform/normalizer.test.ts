import { describe, it, expect } from "vitest";
import { normalize } from "./normalizer.js";
import type { IngestResult } from "../ingest/ingestor.js";
import type { NormalizedXpozPost } from "../ingest/xpoz-client.js";
import type { TopicConfig } from "../../config.js";

function makePost(
  id: string,
  title: string,
  subreddit: string,
  score: number,
): NormalizedXpozPost {
  return {
    id,
    title,
    subreddit,
    score,
    numComments: 0,
    url: `https://reddit.com/r/${subreddit}/${id}`,
    permalink: `/r/${subreddit}/${id}`,
    author: "u/test",
    createdUtc: Math.floor(Date.now() / 1000),
    selftext: "",
  };
}

function makeResult(
  source: IngestResult["source"],
  key: string,
  posts: NormalizedXpozPost[],
): IngestResult {
  return {
    subreddit: source === "subreddit" ? key : "",
    source,
    keyword: source === "keyword" ? key : undefined,
    posts,
    fetchedAt: Date.now(),
  };
}

const config: TopicConfig = {
  label: "Test",
  subreddits: ["longevity", "biohackers"],
  keywords: ["NAD+", "autophagy"],
  allowlist: new Set(),
};

describe("normalize", () => {
  it("deduplicates posts that appear across multiple fetch sources", () => {
    const post = makePost("t3_a1", "NAD+ boost protocol", "longevity", 100);
    const results: IngestResult[] = [
      // Same post returned by subreddit fetch AND keyword fetch
      makeResult("subreddit", "longevity", [post]),
      makeResult("keyword", "NAD+", [{ ...post, score: 120 }]), // higher score
    ];
    const out = normalize(results, config);
    expect(out.stats.afterDedup).toBe(1);
    expect(out.posts[0].score).toBe(120); // keeps max score
    expect(out.posts[0].fetchSources.sort()).toEqual([
      "keyword:NAD+",
      "subreddit:longevity",
    ]);
  });

  it("assigns posts to keyword clusters when the source matches", () => {
    const results: IngestResult[] = [
      makeResult("keyword", "NAD+", [
        makePost("t3_a1", "NAD+ trial results", "longevity", 500),
      ]),
      makeResult("keyword", "autophagy", [
        makePost("t3_b1", "Autophagy fasting study", "biohackers", 300),
      ]),
    ];
    const out = normalize(results, config);
    const titles = out.topics.map((t) => t.title);
    expect(titles).toContain("NAD+"); // keyword cluster, capitalized
    expect(titles).toContain("Autophagy");
  });

  it("ranks topics by aggregate score descending", () => {
    const results: IngestResult[] = [
      makeResult("keyword", "NAD+", [
        makePost("t3_a1", "NAD+ post A", "longevity", 100),
      ]),
      makeResult("keyword", "autophagy", [
        makePost("t3_b1", "Autophagy post", "biohackers", 500),
        makePost("t3_b2", "Autophagy post 2", "biohackers", 400),
      ]),
    ];
    const out = normalize(results, config);
    expect(out.topics[0].title).toBe("Autophagy"); // 900 > 100
    expect(out.topics[0].rank).toBe(1);
    expect(out.topics[0].aggregateScore).toBe(900);
  });

  it("falls back to 'Other / Emerging' for posts that match no cluster", () => {
    const results: IngestResult[] = [
      makeResult("subreddit", "some-unrelated-sub", [
        makePost("t3_x1", "Unrelated post content", "some-unrelated-sub", 50),
      ]),
    ];
    const out = normalize(results, config);
    const titles = out.topics.map((t) => t.title);
    expect(titles).toContain("Other / Emerging");
  });

  it("caps the returned topic list at 10", () => {
    const many: NormalizedXpozPost[] = Array.from({ length: 15 }, (_, i) =>
      makePost(`t3_${i}`, `content-${i}`, `sub-${i}`, 100),
    );
    // Spread them across 15 distinct keyword clusters to force >10 topics
    const bigConfig: TopicConfig = {
      label: "big",
      subreddits: [],
      keywords: Array.from({ length: 15 }, (_, i) => `kw-${i}`),
      allowlist: new Set(),
    };
    const results: IngestResult[] = many.map((p, i) =>
      makeResult("keyword", `kw-${i}`, [p]),
    );
    const out = normalize(results, bigConfig);
    expect(out.topics.length).toBeLessThanOrEqual(10);
    expect(out.stats.topicCount).toBeGreaterThan(10); // total clusters exceeded
  });
});
