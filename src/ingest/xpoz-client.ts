/**
 * Xpoz MCP HTTP Client — with async polling support
 *
 * Xpoz operations are async:
 *   1. Call tool → get operationId (status: "running")
 *   2. Poll checkOperationStatus until status = "success" | "error" | "no_data"
 *   3. Parse YAML-like text response from Xpoz
 *
 * Xpoz returns data in a custom YAML-like format, NOT JSON.
 * We parse post entries from the structured text response.
 */

import { XPOZ_CONFIG } from "../../config.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface NormalizedXpozPost {
  id: string;
  title: string;
  subreddit: string;
  score: number;
  numComments: number;
  url: string;
  permalink: string;
  author: string;
  createdUtc: number;
  selftext: string;
}

interface McpResult {
  content?: Array<{ type: string; text: string }>;
  isError?: boolean;
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

const MCP_URL = XPOZ_CONFIG.endpoint;
const AUTH_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
  Authorization: `Bearer ${XPOZ_CONFIG.apiKey}`,
};

// ─── SSE Parser ───────────────────────────────────────────────────────────────

function parseSseEvents(raw: string): unknown[] {
  const results: unknown[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const jsonStr = trimmed.slice(5).trim();
    if (!jsonStr || jsonStr === "[DONE]") continue;
    try {
      results.push(JSON.parse(jsonStr));
    } catch {
      // skip malformed
    }
  }
  return results;
}

function extractMcpResult(events: unknown[]): McpResult {
  for (const event of events) {
    const e = event as Record<string, unknown>;
    if ("result" in e) return e.result as McpResult;
    if ("error" in e) throw new Error(`MCP error: ${JSON.stringify(e.error)}`);
  }
  throw new Error("No result found in SSE events");
}

// ─── MCP Caller ───────────────────────────────────────────────────────────────

let requestId = 1;

async function callMcp(toolName: string, args: Record<string, unknown>): Promise<McpResult> {
  const body = {
    jsonrpc: "2.0",
    method: "tools/call",
    params: { name: toolName, arguments: args },
    id: requestId++,
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), XPOZ_CONFIG.timeoutMs);

  try {
    const response = await fetch(MCP_URL, {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);

    const raw = await response.text();
    const events = parseSseEvents(raw);
    return extractMcpResult(events);
  } finally {
    clearTimeout(timeout);
  }
}

// ─── Xpoz Text Format Parser ──────────────────────────────────────────────────
//
// Xpoz returns data in a YAML-like format. Example:
//   status: success
//   data:
//     results:
//       posts[100]{id,title,authorUsername,...}:
//         id1,Title here,username,subreddit,"2026-03-02T00:00:00.000Z"
//         id2,Another title,...
//
// We parse the CSV-like rows under the posts[] header.

interface XpozTextResult {
  status: "running" | "success" | "error" | "no_data";
  posts: NormalizedXpozPost[];
  subredditName?: string;
}

function parseXpozTextResponse(text: string, defaultSubreddit: string): XpozTextResult {
  // Extract status
  const statusMatch = text.match(/^status:\s*(\w+)/m);
  const status = (statusMatch?.[1] ?? "unknown") as XpozTextResult["status"];

  if (status === "running") return { status: "running", posts: [] };
  if (status === "error") return { status: "error", posts: [] };
  if (status === "no_data") return { status: "no_data", posts: [] };

  // Extract subreddit name if present
  const subredditMatch = text.match(/displayName:\s*(\w+)/);
  const subredditName = subredditMatch?.[1] ?? defaultSubreddit;

  const posts: NormalizedXpozPost[] = [];

  // Match both "posts[N]{fields}:" and "results[N]{fields}:" blocks (Xpoz uses both)
  const blockRegex = /(?:posts|results)\[\d+\]\{([^}]+)\}:\s*\n((?:\s+[^\n]+\n?)*)/gm;
  let blockMatch: RegExpExecArray | null;

  while ((blockMatch = blockRegex.exec(text)) !== null) {
    const fields = blockMatch[1].split(",").map((f) => f.trim());
    const rows = blockMatch[2]
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

    for (const row of rows) {
      const post = parsePostRow(row, fields, subredditName);
      if (post) posts.push(post);
    }
  }

  return { status: "success", posts, subredditName };
}

/**
 * Parse a single CSV-like row from Xpoz's text response.
 * Handles quoted fields with commas inside.
 */
function parsePostRow(
  row: string,
  fields: string[],
  defaultSubreddit: string
): NormalizedXpozPost | null {
  const values = splitCsvRow(row);
  if (values.length < 2) return null;

  const get = (fieldNames: string[]): string => {
    for (const name of fieldNames) {
      const idx = fields.indexOf(name);
      if (idx >= 0 && idx < values.length) {
        return values[idx].replace(/^"|"$/g, "").trim();
      }
    }
    return "";
  };

  const id = get(["id", "postId"]);
  const title = get(["title"]);
  if (!id || !title) return null;

  const author = get(["authorUsername", "author"]);
  const subreddit = get(["subredditName", "subreddit"]) || defaultSubreddit;
  const dateStr = get(["createdAtDate", "createdAt", "created_at"]);
  const createdUtc = dateStr ? Math.floor(new Date(dateStr).getTime() / 1000) : 0;
  const scoreStr = get(["score", "upvotes"]);
  const score = scoreStr ? parseInt(scoreStr, 10) : 0;
  const commentsStr = get(["numComments", "commentCount", "comments"]);
  const numComments = commentsStr ? parseInt(commentsStr, 10) : 0;
  const url = get(["url", "permalink"]);
  const permalink = get(["permalink", "url"]) || url;

  return {
    id,
    title,
    subreddit,
    score: isNaN(score) ? 0 : score,
    numComments: isNaN(numComments) ? 0 : numComments,
    url: url || `https://reddit.com/r/${subreddit}/comments/${id}`,
    permalink: permalink || url || `https://reddit.com/r/${subreddit}/comments/${id}`,
    author,
    createdUtc,
    selftext: "",
  };
}

/**
 * Split a CSV row respecting quoted fields.
 */
function splitCsvRow(row: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < row.length; i++) {
    const ch = row[i];
    if (ch === '"') {
      if (inQuotes && row[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      result.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

// ─── Operation ID Extractor ───────────────────────────────────────────────────

function extractOperationId(text: string): string | null {
  const match = text.match(/operationId:\s*(op_[^\s\n"\\]+)/);
  return match ? match[1] : null;
}

// ─── Polling ──────────────────────────────────────────────────────────────────

async function pollUntilDone(
  operationId: string,
  defaultSubreddit: string,
  maxAttempts = 24,
  intervalMs = 5000
): Promise<NormalizedXpozPost[]> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await callMcp("checkOperationStatus", { operationId });
    const text = result.content?.find((c) => c.type === "text")?.text ?? "";
    const parsed = parseXpozTextResponse(text, defaultSubreddit);

    if (parsed.status === "running") {
      console.log(`    [poll] attempt ${attempt}/${maxAttempts} — running...`);
      await new Promise((r) => setTimeout(r, intervalMs));
      continue;
    }

    if (parsed.status === "error") throw new Error(`Xpoz operation failed: ${text.slice(0, 200)}`);
    if (parsed.status === "no_data") {
      console.log(`    [poll] no_data for ${defaultSubreddit}`);
      return [];
    }

    console.log(`    [poll] success — ${parsed.posts.length} posts`);
    return parsed.posts;
  }
  throw new Error(`Operation ${operationId} timed out after ${maxAttempts} attempts`);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Fields to request from Xpoz for post data.
 * NOTE: Xpoz does NOT return numComments — it's silently ignored even when requested.
 * Fields confirmed available: id, title, score, authorUsername, subredditName, createdAtDate, url
 */
const POST_FIELDS = ["id", "title", "score", "authorUsername", "subredditName", "createdAtDate", "url"];

export async function getSubredditPosts(subredditName: string): Promise<NormalizedXpozPost[]> {
  console.log(`  [xpoz] getSubredditPosts: r/${subredditName}`);
  const result = await callMcp("getRedditSubredditWithPostsByName", {
    subredditName,
    postFields: POST_FIELDS,
  });
  const text = result.content?.find((c) => c.type === "text")?.text ?? "";
  const operationId = extractOperationId(text);

  if (!operationId) {
    console.warn(`  [xpoz] No operationId for r/${subredditName}`);
    return [];
  }

  console.log(`  [xpoz] Polling: ${operationId}`);
  return pollUntilDone(operationId, subredditName);
}

export async function searchByKeyword(query: string): Promise<NormalizedXpozPost[]> {
  console.log(`  [xpoz] searchByKeyword: "${query}"`);
  // Keywords tool returns results directly (sync fast-mode) — no async polling needed
  const result = await callMcp("getRedditPostsByKeywords", {
    query,
    limit: 100,
  });
  const text = result.content?.find((c) => c.type === "text")?.text ?? "";

  // Try to parse directly first (fast mode — results inline)
  const parsed = parseXpozTextResponse(text, "search");
  if (parsed.status === "success" && parsed.posts.length > 0) {
    console.log(`    [direct] ${parsed.posts.length} posts`);
    return parsed.posts;
  }

  // Fall back to polling if we got an operationId
  const operationId = extractOperationId(text);
  if (operationId) {
    console.log(`  [xpoz] Polling: ${operationId}`);
    return pollUntilDone(operationId, "search");
  }

  console.warn(`  [xpoz] No results and no operationId for keyword: "${query}"`);
  return [];
}

/**
 * Search Twitter/X for posts matching a keyword.
 * Uses getTwitterPostsByKeywords — fast (sync) mode, no polling needed.
 * Maps Twitter fields to NormalizedXpozPost with subreddit="twitter".
 */
export async function searchTwitterByKeyword(query: string): Promise<NormalizedXpozPost[]> {
  console.log(`  [xpoz] searchTwitterByKeyword: "${query}"`);
  const result = await callMcp("getTwitterPostsByKeywords", {
    query,
    limit: 100,
    filterOutRetweets: true,
    language: "en",
    responseType: "fast",
  });
  const text = result.content?.find((c) => c.type === "text")?.text ?? "";

  const parsed = parseXpozTextResponse(text, "twitter");

  // Twitter uses "text" field instead of "title" — remap if needed
  const remapped: NormalizedXpozPost[] = parsed.posts.map((p) => ({
    ...p,
    // Prefix ID to avoid collision with Reddit IDs
    id: `tw_${p.id}`,
    // Ensure subreddit="twitter" for platform detection downstream
    subreddit: "twitter",
    // Twitter score = likesCount (mapped by parseXpozTextResponse via "score"/"upvotes" field alias)
    url: p.url || `https://twitter.com/i/web/status/${p.id.replace("tw_", "")}`,
    permalink: p.permalink || p.url || `https://twitter.com/i/web/status/${p.id.replace("tw_", "")}`,
  }));

  if (remapped.length > 0) {
    console.log(`    [twitter] ${remapped.length} tweets`);
    return remapped;
  }

  // Fall back to polling if we got an operationId
  const operationId = extractOperationId(text);
  if (operationId) {
    console.log(`  [xpoz] Polling Twitter: ${operationId}`);
    const polled = await pollUntilDone(operationId, "twitter");
    return polled.map((p) => ({
      ...p,
      id: `tw_${p.id}`,
      subreddit: "twitter",
    }));
  }

  console.warn(`  [xpoz] No results and no operationId for twitter keyword: "${query}"`);
  return [];
}
