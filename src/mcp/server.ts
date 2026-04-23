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
const API_TOKEN = process.env.XPOZ_API_TOKEN ?? "";

// ── HTTP helper ────────────────────────────────────────────────────────────────

function authHeaders(): Record<string, string> {
  return API_TOKEN ? { "X-Xpoz-Token": API_TOKEN } : {};
}

async function apiGet(path: string): Promise<unknown> {
  const res = await fetch(`${PIPELINE_BASE}${path}`, {
    headers: authHeaders(),
  });
  if (!res.ok) {
    throw new Error(`Pipeline API error ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

async function apiPost(path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${PIPELINE_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    throw new Error(`Pipeline API error ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

async function apiGetText(path: string): Promise<string> {
  const res = await fetch(`${PIPELINE_BASE}${path}`, {
    headers: authHeaders(),
  });
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
    "Returns immediately with {jobId, status:'started', ...} — the pipeline runs async (~2 min) and delivers a Telegram digest to the operator on completion by default. " +
    "Do NOT poll after calling this tool — the operator receives the digest directly via Telegram; acknowledge the trigger and stop. " +
    "Requires a topic seed: label + subreddits + keywords (no defaults). " +
    "Pass notify=false only for silent/background runs (no Telegram delivery). In that case, poll xpoz_get_job_status with the returned jobId to check progress. " +
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
        "If true (default when invoked via MCP), send a Telegram digest to the operator chat on completion. Pass false only for silent/background runs.",
      ),
  },
  async (input) => {
    const payload = { ...input, notify: input.notify ?? true };
    const data = await apiPost("/run", payload);
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

// ── Tool: xpoz_get_job_status ──────────────────────────────────────────────────

server.tool(
  "xpoz_get_job_status",
  "Check the status of a specific xpoz_trigger_run job by its jobId. " +
    "Returns one of: status='running' (still ingesting), 'completed' (result attached), 'failed' (error attached). " +
    "Use this ONLY when the caller opted out of notify:true and needs to poll for completion. " +
    "For normal conversational use, prefer notify:true on xpoz_trigger_run — the digest is delivered " +
    "directly to Telegram and no polling is needed.",
  {
    // Zod v3's z.string().uuid() is deprecated in v4. Use a regex instead so
    // this keeps compiling across zod minor bumps; matches RFC 4122 shape.
    jobId: z
      .string()
      .regex(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
        "jobId must be an RFC 4122 UUID",
      )
      .describe("The jobId returned by xpoz_trigger_run (RFC 4122 UUID)"),
  },
  async ({ jobId }) => {
    const data = await apiGet(`/run/jobs/${jobId}`);
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
