/**
 * Telegram notifier for Xpoz Intelligence Pipeline
 *
 * Sends a formatted digest message to the configured Telegram chat.
 * Reads credentials from environment variables:
 *   TELEGRAM_BOT_TOKEN  — Jarvis bot token
 *   TELEGRAM_OWNER_CHAT_ID (or TELEGRAM_CHAT_ID) — target chat ID
 */

import type { TopicWithDelta } from "../analyze/delta.js";

// ─── Config ───────────────────────────────────────────────────────────────────

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
const CHAT_ID =
  process.env.TELEGRAM_OWNER_CHAT_ID ?? process.env.TELEGRAM_CHAT_ID ?? "";
const API_BASE = `https://api.telegram.org/bot${BOT_TOKEN}`;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DigestOptions {
  topics: TopicWithDelta[];
  runId: number;
  totalPosts: number;
  uniquePosts: number;
  subredditCount: number;
  durationMs: number;
  force?: boolean; // send even if no new/up topics
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

function deltaEmoji(delta: string | undefined): string {
  switch (delta) {
    case "new":
      return "🆕";
    case "up":
      return "⬆️";
    case "down":
      return "⬇️";
    case "disappeared":
      return "💨";
    case "stable":
    default:
      return "📌";
  }
}

function escapeMd(text: string): string {
  // Escape MarkdownV2 special chars
  return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, "\\$&");
}

// ─── Message builder ──────────────────────────────────────────────────────────

export function buildDigestMessage(opts: DigestOptions): string {
  const { topics, runId, totalPosts, uniquePosts, subredditCount, durationMs } =
    opts;

  const now = new Date().toLocaleDateString("es-MX", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "America/Mexico_City",
  });

  const hasAlerts = topics.some((t) => t.delta === "new" || t.delta === "up");

  const lines: string[] = [`🧠 *Intelligence Digest — ${escapeMd(now)}*`, ""];

  if (hasAlerts) {
    lines.push("*Novedades detectadas:*");
  }

  for (const topic of topics.slice(0, 10)) {
    const emoji = deltaEmoji(topic.delta);
    const scorePart = `\\(score: ${formatNumber(topic.aggregateScore)}\\)`;

    let line = `${emoji} ${escapeMd(topic.title)} ${scorePart}`;

    // Annotate score change for up/down
    if (
      (topic.delta === "up" || topic.delta === "down") &&
      topic.scoreDelta != null
    ) {
      const pct =
        topic.scoreDelta > 0 ? `+${topic.scoreDelta}%` : `${topic.scoreDelta}%`;
      line += ` _${escapeMd(pct)}_`;
    }

    lines.push(line);
  }

  lines.push("");
  lines.push(
    `_📊 ${formatNumber(uniquePosts)} posts únicos · ${topics.length} tópicos · ${subredditCount} subreddits · Run \\#${runId} · ${Math.round(durationMs / 1000)}s_`,
  );

  return lines.join("\n");
}

// ─── Sender ───────────────────────────────────────────────────────────────────

export async function sendTelegramDigest(
  opts: DigestOptions,
): Promise<boolean> {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.warn(
      "[telegram] Missing TELEGRAM_BOT_TOKEN or TELEGRAM_OWNER_CHAT_ID — skipping",
    );
    return false;
  }

  const hasAlerts = opts.topics.some(
    (t) => t.delta === "new" || t.delta === "up",
  );

  if (!hasAlerts && !opts.force) {
    console.log(
      "[telegram] No new/up topics — skipping notification (use --force to override)",
    );
    return false;
  }

  const text = buildDigestMessage(opts);

  try {
    const res = await fetch(`${API_BASE}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text,
        parse_mode: "MarkdownV2",
        disable_web_page_preview: true,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      console.error(`[telegram] API error ${res.status}: ${body}`);
      return false;
    }

    const data = (await res.json()) as { ok: boolean };
    if (!data.ok) {
      console.error("[telegram] API returned ok:false", data);
      return false;
    }

    console.log("[telegram] ✅ Digest sent successfully");
    return true;
  } catch (err) {
    console.error("[telegram] Network error:", err);
    return false;
  }
}
