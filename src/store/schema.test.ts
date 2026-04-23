import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { calcCredits, SCHEMA_SQL, PLAN_CREDITS_TOTAL } from "./schema.js";

describe("calcCredits", () => {
  it("follows the Xpoz formula: queries*5 + posts*0.005", () => {
    expect(calcCredits(10, 1000)).toBe(55); // 50 + 5
    expect(calcCredits(0, 0)).toBe(0);
    expect(calcCredits(1, 200)).toBe(6); // 5 + 1
  });

  it("handles large fan-out runs", () => {
    expect(calcCredits(100, 10_000)).toBe(550); // 500 + 50
  });
});

describe("SCHEMA_SQL", () => {
  it("applies cleanly to an in-memory SQLite database", () => {
    const db = new Database(":memory:");
    expect(() => db.exec(SCHEMA_SQL)).not.toThrow();

    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      )
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain("runs");
    expect(names).toContain("topics");
    expect(names).toContain("topic_posts");
    db.close();
  });

  it("enforces required columns on runs table", () => {
    const db = new Database(":memory:");
    db.exec(SCHEMA_SQL);
    // NOT NULL on raw_post_count should reject null insert
    expect(() =>
      db
        .prepare(
          "INSERT INTO runs (started_at, duration_ms, unique_post_count, topic_count) VALUES (?, ?, ?, ?)",
        )
        .run("2026-04-23T15:00:00Z", 1000, 500, 10),
    ).toThrow();
    db.close();
  });

  it("supports full round-trip insert and query", () => {
    const db = new Database(":memory:");
    db.exec(SCHEMA_SQL);
    const runId = db
      .prepare(
        "INSERT INTO runs (started_at, duration_ms, raw_post_count, unique_post_count, topic_count, credits_used, queries_count) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run("2026-04-23T15:00:00Z", 1000, 100, 80, 5, 1.0, 2)
      .lastInsertRowid as number;
    db.prepare(
      "INSERT INTO topics (run_id, rank, title, aggregate_score, post_count, subreddits) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(runId, 1, "Tesla", 5000, 50, '["wallstreetbets"]');

    const rows = db
      .prepare("SELECT * FROM topics WHERE run_id = ?")
      .all(runId) as Array<{ title: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("Tesla");
    db.close();
  });
});

describe("PLAN_CREDITS_TOTAL", () => {
  it("is the Free-tier quota", () => {
    expect(PLAN_CREDITS_TOTAL).toBe(5000);
  });
});
