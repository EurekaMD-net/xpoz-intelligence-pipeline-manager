/**
 * Xpoz Intelligence Pipeline — MCP Server
 *
 * Thin wrapper over the pipeline HTTP API (localhost:8086).
 * Exposes 4 tools to Jarvis via stdio MCP transport.
 * Does NOT reimplement pipeline logic — delegates everything to the running service.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const PIPELINE_BASE = "http://localhost:8086";

// ── HTTP helper ────────────────────────────────────────────────────────────────

async function apiGet(path: string): Promise<unknown> {
  const res = await fetch(`${PIPELINE_BASE}${path}`);
  if (!res.ok) {
    throw new Error(`Pipeline API error ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

async function apiPost(path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${PIPELINE_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    throw new Error(`Pipeline API error ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

async function apiGetText(path: string): Promise<string> {
  const res = await fetch(`${PIPELINE_BASE}${path}`);
  if (!res.ok) {
    throw new Error(`Pipeline API error ${res.status}: ${await res.text()}`);
  }
  return res.text();
}

// ── MCP Server setup ───────────────────────────────────────────────────────────

const server = new McpServer({
  name: "xpoz-pipeline",
  version: "1.0.0",
});

// ── Tool: xpoz_get_topics ──────────────────────────────────────────────────────

server.tool(
  "xpoz_get_topics",
  "Get the top topics from the latest Reddit Intelligence Pipeline run. " +
    "Returns ranked topics with scores, delta (new/up/down/stable), and post counts. " +
    "Use this when the user asks about trending topics, Reddit intel, " +
    "what's hot in a subreddit, or wants the intelligence digest.",
  {
    limit: z
      .number()
      .int()
      .min(1)
      .max(20)
      .optional()
      .describe(
        "Number of top topics to return. Default: 10. Max: 20. Use 3-5 for a quick summary, 10+ for full analysis.",
      ),
  },
  async ({ limit }) => {
    const params = limit ? `?limit=${limit}` : "";
    const data = await apiGet(`/topics/latest${params}`);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(data, null, 2),
        },
      ],
    };
  },
);

// ── Tool: xpoz_get_digest ──────────────────────────────────────────────────────

server.tool(
  "xpoz_get_digest",
  "Get the full Markdown intelligence digest from the latest Reddit pipeline run. " +
    "Includes ranked topic list, score deltas, subreddit sources, and run metadata. " +
    "Use this when the user wants the complete formatted report, morning briefing intel, " +
    "or a shareable summary of what's trending on Reddit.",
  {},
  async () => {
    const text = await apiGetText("/digest/latest");
    return {
      content: [
        {
          type: "text",
          text,
        },
      ],
    };
  },
);

// ── Tool: xpoz_trigger_run ─────────────────────────────────────────────────────

server.tool(
  "xpoz_trigger_run",
  "Trigger a new Reddit Intelligence Pipeline run asynchronously. " +
    "The run ingests posts from the specified subreddits via Xpoz, normalizes, " +
    "clusters into topics based on the provided keywords, compares with previous run, and saves to SQLite. " +
    "Returns immediately with run metadata — poll GET /health or use xpoz_get_topics after ~2 min. " +
    "Requires a topic seed: label + subreddits + keywords (no defaults). " +
    "Pass notify=true to send a Telegram digest to the operator on completion. " +
    "Use when the user explicitly asks to run a new analysis with a specific seed/theme.",
  {
    label: z
      .string()
      .min(1)
      .describe(
        "Human-readable seed/topic label (e.g., 'NVDA', 'Red Light Therapy', 'longevity')",
      ),
    subreddits: z
      .array(z.string())
      .min(1)
      .describe(
        "Subreddits to ingest, without 'r/' prefix (e.g., ['longevity','Biohackers'])",
      ),
    keywords: z
      .array(z.string())
      .min(1)
      .describe(
        "Keywords to filter/score posts (e.g., ['longevity','healthspan','nad+'])",
      ),
    twitterKeywords: z
      .array(z.string())
      .optional()
      .describe("Optional Twitter keywords for cross-source enrichment"),
    notify: z
      .boolean()
      .optional()
      .describe(
        "If true, send a Telegram digest to the operator chat on completion. Default: false",
      ),
  },
  async (input) => {
    const data = await apiPost("/run", input);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(data, null, 2),
        },
      ],
    };
  },
);

// ── Tool: xpoz_get_history ─────────────────────────────────────────────────────

server.tool(
  "xpoz_get_history",
  "Get the history of Reddit Intelligence Pipeline runs with stats per run. " +
    "Shows run timestamps, duration, post counts, and topic counts. " +
    "Use this when the user asks how often the pipeline has run, when was the last run, " +
    "or wants to audit pipeline activity.",
  {},
  async () => {
    const data = await apiGet("/runs");
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(data, null, 2),
        },
      ],
    };
  },
);

// ── Start ──────────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr only — stdout is the MCP protocol channel
  process.stderr.write("Xpoz Pipeline MCP server running on stdio\n");
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err.message}\n`);
  process.exit(1);
});
