/**
 * Report Formatter — Xpoz Intelligence Pipeline
 *
 * Renders Markdown + JSON reports from pipeline output.
 * Includes delta markers when run history is available.
 */

import type { TopicWithDelta, DeltaResult, DisappearedTopic } from "../analyze/delta.js";
import type { RunRow } from "../store/queries.js";

// ─── Delta emoji map ──────────────────────────────────────────────────────────

const DELTA_ICON: Record<string, string> = {
  new: "🆕",
  up: "📈",
  down: "📉",
  stable: "➡️",
  disappeared: "🕳️",
};

const DELTA_LABEL: Record<string, string> = {
  new: "NUEVO",
  up: "SUBE",
  down: "BAJA",
  stable: "ESTABLE",
};

// ─── Markdown formatter ───────────────────────────────────────────────────────

export interface ReportInput {
  delta: DeltaResult;
  runId: number;
  durationMs: number;
  rawPostCount: number;
  uniquePostCount: number;
  previousRun: RunRow | null;
}

export function renderMarkdown(input: ReportInput): string {
  const { delta, runId, durationMs, rawPostCount, uniquePostCount, previousRun } = input;
  const now = new Date().toISOString().split("T")[0];

  const lines: string[] = [
    `# Reddit Intelligence Report — ${now}`,
    ``,
    `> Pipeline: Xpoz API · Phase 2 · Run #${runId} · ${durationMs}ms`,
    `> Posts: ${rawPostCount} raw → ${uniquePostCount} unique · ${delta.topics.length} tópicos`,
    ``,
  ];

  // Delta summary (only if we have history)
  if (previousRun) {
    lines.push(`## 📊 Delta vs. Run #${previousRun.id} (${previousRun.started_at.split("T")[0]})`);
    lines.push(``);
    lines.push(
      `| ${DELTA_ICON.new} Nuevos | ${DELTA_ICON.up} Suben | ${DELTA_ICON.down} Bajan | ${DELTA_ICON.stable} Estables | ${DELTA_ICON.disappeared} Desaparecidos |`
    );
    lines.push(`|--------|-------|-------|----------|--------------|`);
    lines.push(
      `| ${delta.newCount} | ${delta.upCount} | ${delta.downCount} | ${delta.stableCount} | ${delta.disappearedCount} |`
    );
    lines.push(``);
  }

  lines.push(`## 🔥 Top ${delta.topics.length} Tópicos`);
  lines.push(``);

  for (const topic of delta.topics) {
    const icon = DELTA_ICON[topic.delta] ?? "";
    const label = DELTA_LABEL[topic.delta] ?? "";
    const rankInfo =
      topic.previousRank !== null && topic.rankChange !== null
        ? ` (era #${topic.previousRank}, ${topic.rankChange > 0 ? `+${topic.rankChange}` : topic.rankChange} posiciones)`
        : "";

    lines.push(`### #${topic.rank} ${icon} ${label} — ${topic.title}${rankInfo}`);
    lines.push(
      `**Score agregado:** ${topic.aggregateScore} | **Posts:** ${topic.posts.length}`
    );
    lines.push(`**Subreddits:** ${topic.subreddits.map((s) => `r/${s}`).join(", ")}`);
    lines.push(``);
    lines.push(
      `**Post representativo:** [${topic.representative.title}](${topic.representative.url})`
    );
    lines.push(`↳ Score: ${topic.representative.score} · by u/${topic.representative.author}`);
    lines.push(``);

    if (topic.posts.length > 1) {
      lines.push(`**Otros posts del cluster:**`);
      for (const p of topic.posts.slice(1, 4)) {
        lines.push(`- [${p.title}](${p.url}) — score: ${p.score}`);
      }
    }

    lines.push(``);
    lines.push(`---`);
    lines.push(``);
  }

  // Disappeared topics section
  if (delta.disappeared.length > 0) {
    lines.push(`## 🕳️ Tópicos que desaparecieron`);
    lines.push(``);
    for (const d of delta.disappeared) {
      lines.push(`- **${d.title}** (era #${d.previousRank}, score: ${d.previousScore})`);
    }
    lines.push(``);
  }

  return lines.join("\n");
}

// ─── JSON formatter ───────────────────────────────────────────────────────────

export interface JsonReport {
  runId: number;
  date: string;
  durationMs: number;
  stats: {
    rawPostCount: number;
    uniquePostCount: number;
    topicCount: number;
  };
  delta: {
    newCount: number;
    upCount: number;
    downCount: number;
    stableCount: number;
    disappearedCount: number;
  };
  topics: Array<{
    rank: number;
    title: string;
    aggregateScore: number;
    postCount: number;
    subreddits: string[];
    delta: string;
    previousRank: number | null;
    rankChange: number | null;
    representative: {
      title: string;
      url: string;
      score: number;
      author: string;
      subreddit: string;
    };
  }>;
  disappeared: DisappearedTopic[];
}

export function renderJson(input: ReportInput): JsonReport {
  const { delta, runId, durationMs, rawPostCount, uniquePostCount } = input;

  return {
    runId,
    date: new Date().toISOString(),
    durationMs,
    stats: {
      rawPostCount,
      uniquePostCount,
      topicCount: delta.topics.length,
    },
    delta: {
      newCount: delta.newCount,
      upCount: delta.upCount,
      downCount: delta.downCount,
      stableCount: delta.stableCount,
      disappearedCount: delta.disappearedCount,
    },
    topics: delta.topics.map((t: TopicWithDelta) => ({
      rank: t.rank,
      title: t.title,
      aggregateScore: t.aggregateScore,
      postCount: t.posts.length,
      subreddits: t.subreddits,
      delta: t.delta,
      previousRank: t.previousRank,
      rankChange: t.rankChange,
      representative: {
        title: t.representative.title,
        url: t.representative.url,
        score: t.representative.score,
        author: t.representative.author,
        subreddit: t.representative.subreddit,
      },
    })),
    disappeared: delta.disappeared,
  };
}
