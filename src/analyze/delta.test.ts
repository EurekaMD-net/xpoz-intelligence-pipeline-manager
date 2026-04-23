import { describe, it, expect } from "vitest";
import { computeDelta } from "./delta.js";
import type { Topic } from "../transform/normalizer.js";
import type { TopicRow } from "../store/queries.js";

function makeTopic(rank: number, title: string, score: number): Topic {
  return {
    rank,
    title,
    posts: [],
    aggregateScore: score,
    totalComments: 0,
    subreddits: [],
    // representative is unused in delta logic
    representative: {} as Topic["representative"],
  };
}

function makeRow(
  id: number,
  rank: number,
  title: string,
  score: number,
): TopicRow {
  return {
    id,
    run_id: 1,
    rank,
    title,
    aggregate_score: score,
    post_count: 1,
    subreddits: "[]",
  } as TopicRow;
}

describe("computeDelta", () => {
  it("labels everything 'new' when no previous run exists", () => {
    const current = [makeTopic(1, "Tesla", 1000), makeTopic(2, "SpaceX", 500)];
    const result = computeDelta(current, null);
    expect(result.newCount).toBe(2);
    expect(result.topics.every((t) => t.delta === "new")).toBe(true);
    expect(result.disappearedCount).toBe(0);
  });

  it("labels unchanged-rank topics as 'stable'", () => {
    const current = [makeTopic(1, "Elon Musk Tesla", 1000)];
    const previous = [makeRow(1, 1, "Tesla Musk earnings", 900)];
    const result = computeDelta(current, previous);
    // fuzzy match: "elon musk tesla" vs "tesla musk earnings" share "tesla" + "musk" = 2 words overlap
    expect(result.topics[0].delta).toBe("stable");
    expect(result.stableCount).toBe(1);
    expect(result.topics[0].scoreDelta).toBe(11); // (1000-900)/900 = 11%
  });

  it("labels rank improvement > 1 as 'up' and rank drop > 1 as 'down'", () => {
    const current = [
      makeTopic(1, "SpaceX Starship launch", 5000), // was rank 4 → up
      makeTopic(2, "Tesla earnings beat", 3000), // stable (was 2)
      makeTopic(5, "Bitcoin institutional inflow", 800), // was rank 1 → down
    ];
    const previous = [
      makeRow(1, 1, "Bitcoin institutional adoption", 2000),
      makeRow(2, 2, "Tesla earnings preview", 3500),
      makeRow(4, 4, "SpaceX Starship orbital", 3000),
    ];
    const result = computeDelta(current, previous);
    const byTitle = Object.fromEntries(result.topics.map((t) => [t.title, t]));
    expect(byTitle["SpaceX Starship launch"].delta).toBe("up");
    expect(byTitle["Tesla earnings beat"].delta).toBe("stable");
    expect(byTitle["Bitcoin institutional inflow"].delta).toBe("down");
  });

  it("reports disappeared topics that were in previous but missing now", () => {
    const current = [makeTopic(1, "Tesla robotaxi unveiling", 1000)];
    const previous = [
      makeRow(1, 1, "Tesla robotaxi launch date", 900),
      makeRow(2, 2, "Dogecoin mooning again", 500),
    ];
    const result = computeDelta(current, previous);
    expect(result.disappearedCount).toBe(1);
    expect(result.disappeared[0].title).toBe("Dogecoin mooning again");
    expect(result.disappeared[0].previousRank).toBe(2);
  });

  it("fuzzy-matches titles that share ≥2 significant words", () => {
    // "longevity healthspan research" vs "healthspan longevity aging" — 2 words overlap
    const current = [makeTopic(1, "longevity healthspan research", 500)];
    const previous = [makeRow(1, 1, "healthspan longevity aging", 400)];
    const result = computeDelta(current, previous);
    expect(result.topics[0].delta).toBe("stable");
    expect(result.topics[0].previousRank).toBe(1);
  });

  it("does NOT match titles with only one common significant word", () => {
    // "Tesla quarterly earnings" vs "Ford quarterly results" — overlap of stopwords-adjacent-words only
    const current = [makeTopic(1, "Tesla quarterly earnings", 1000)];
    const previous = [makeRow(1, 1, "Ford announces layoffs", 800)];
    const result = computeDelta(current, previous);
    expect(result.topics[0].delta).toBe("new");
    expect(result.disappearedCount).toBe(1);
  });
});
