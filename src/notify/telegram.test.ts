import { describe, it, expect } from "vitest";
import { buildDigestMessage } from "./telegram.js";
import type { TopicWithDelta } from "../analyze/delta.js";

function makeTopic(
  rank: number,
  title: string,
  score: number,
  delta: TopicWithDelta["delta"],
  scoreDelta: number | null = null,
): TopicWithDelta {
  return {
    rank,
    title,
    posts: [],
    aggregateScore: score,
    totalComments: 0,
    subreddits: [],
    representative: {} as TopicWithDelta["representative"],
    delta,
    previousRank: null,
    rankChange: null,
    scoreDelta,
  };
}

describe("buildDigestMessage", () => {
  const baseOpts = {
    runId: 42,
    totalPosts: 1000,
    uniquePosts: 657,
    subredditCount: 4,
    durationMs: 90_000,
  };

  it("renders topics with emoji based on delta status", () => {
    const msg = buildDigestMessage({
      ...baseOpts,
      topics: [
        makeTopic(1, "Tesla earnings", 1000, "new"),
        makeTopic(2, "Bitcoin inflow", 500, "up", 15),
        makeTopic(3, "Dogecoin dump", 100, "down", -40),
        makeTopic(4, "r/longevity", 800, "stable"),
      ],
    });
    expect(msg).toContain("🆕"); // new
    expect(msg).toContain("⬆️"); // up
    expect(msg).toContain("⬇️"); // down
    expect(msg).toContain("📌"); // stable
  });

  it("escapes MarkdownV2 special characters in titles", () => {
    const msg = buildDigestMessage({
      ...baseOpts,
      topics: [makeTopic(1, "Musk says (maybe) Tesla's 2026!", 1000, "new")],
    });
    // Special chars (_*[]()~`>#+-=|{}.!) must be backslash-escaped
    expect(msg).toContain("\\(maybe\\)");
    expect(msg).toContain("Tesla's 2026\\!");
    // Dot in "2026." would be escaped only if present; here we check the !
    expect(msg).not.toMatch(/(?<!\\)!/); // no unescaped !
  });

  it("includes the per-topic score and percentage change for up/down", () => {
    const msg = buildDigestMessage({
      ...baseOpts,
      topics: [
        makeTopic(1, "Rising topic", 5000, "up", 25),
        makeTopic(2, "Falling topic", 1000, "down", -30),
      ],
    });
    expect(msg).toContain("5,000"); // score with thousands separator
    expect(msg).toContain("\\+25%");
    expect(msg).toContain("\\-30%");
  });

  it("includes the run metadata footer (posts, subreddits, run id, duration)", () => {
    const msg = buildDigestMessage({
      ...baseOpts,
      topics: [makeTopic(1, "Only topic", 500, "new")],
    });
    expect(msg).toContain("657 posts únicos");
    expect(msg).toContain("4 subreddits");
    expect(msg).toContain("\\#42"); // run id escaped
    expect(msg).toContain("90s"); // duration rounded to seconds
  });

  it("caps the rendered topic list at 10 items", () => {
    const topics = Array.from({ length: 15 }, (_, i) =>
      makeTopic(i + 1, `Topic ${i + 1}`, 1000 - i * 10, "new"),
    );
    const msg = buildDigestMessage({ ...baseOpts, topics });
    // Topic 10 should appear, Topic 11 should NOT.
    expect(msg).toContain("Topic 10");
    expect(msg).not.toContain("Topic 11");
    expect(msg).not.toContain("Topic 15");
  });
});
