# Xpoz Intelligence Pipeline Manager

> Self-hosted intelligence pipeline that scrapes Reddit (and optionally Twitter/X) via the Xpoz MCP API, clusters posts into semantic topics, computes deltas between runs, and delivers a markdown digest — on-demand or via Jarvis voice command.

---

## What it does

1. **Ingests** posts from Reddit subreddits + keyword searches, and optionally Twitter/X keywords — all in parallel, batched.
2. **Normalizes** raw posts into a unified schema, deduplicates by URL.
3. **Clusters** posts into semantic topics using dynamic keyword matching + subreddit grouping. Unclustered posts go to "Other / Emerging".
4. **Computes deltas** — new vs. existing topics since the last run, scores momentum.
5. **Persists** runs, topics, and credit usage to SQLite.
6. **Reports** via markdown digest (file + console) and optional Telegram notification.
7. **Exposes** everything via an HTTP API on `localhost:8086` for Jarvis integration.
8. **Exposes** a Model Context Protocol (MCP) server so Jarvis can trigger runs and query results directly as tools.

---

## Architecture

```
src/
├── index.ts              # Entry point (HTTP server + CLI flag handling)
├── pipeline.ts           # Core runner: Ingest → Normalize → Persist → Delta → Report → Notify
├── config.ts             # TopicConfig interface, Xpoz API credentials
├── mcp-server.ts         # MCP server (stdio) — exposes pipeline as Jarvis tools
│
├── ingest/
│   ├── ingestor.ts       # Parallel multi-source orchestrator (Reddit + Twitter)
│   └── xpoz-client.ts    # Xpoz API client (subreddit, keyword, Twitter — with async polling)
│
├── transform/
│   └── normalizer.ts     # Dedup + cluster assignment → NormalizedPost[]
│
├── analyze/
│   └── delta.ts          # New vs. previous run topic comparison
│
├── store/
│   ├── db.ts             # SQLite singleton (WAL mode)
│   ├── schema.ts         # DDL + credit calculation
│   └── queries.ts        # All read/write queries — including clearAllData(), clearRunData()
│
├── report/
│   └── formatter.ts      # Markdown + JSON digest renderers
│
├── notify/
│   └── telegram.ts       # Optional Telegram digest delivery
│
├── api/
│   └── server.ts         # Hono HTTP server — REST endpoints + POST /run + POST /reset
│
└── scheduler/
    └── index.ts          # Cron-based scheduled runs (optional)

scripts/
└── restart.sh            # One-command clean restart (kills old process, clears tsx cache, starts fresh)
```

---

## HTTP API

Server runs on `localhost:8086` (not exposed publicly).

| Method | Endpoint          | Description                                                                        |
| ------ | ----------------- | ---------------------------------------------------------------------------------- |
| `GET`  | `/health`         | Service status, last run info, credit summary                                      |
| `GET`  | `/runs`           | List all runs with stats                                                           |
| `GET`  | `/topics/latest`  | Top topics from last run (JSON)                                                    |
| `GET`  | `/digest/latest`  | Markdown digest from last run (text/plain)                                         |
| `POST` | `/run`            | Trigger a pipeline run on-demand                                                   |
| `POST` | `/search/keyword` | Synchronous per-keyword Reddit search (used by williams-entry-radar S2 enrichment) |
| `POST` | `/reset`          | Clear all DB data (runs, topics, posts) — blocked if run in progress               |
| `GET`  | `/credits`        | Credit usage summary                                                               |

### POST /run — payload

```json
{
  "label": "NVDA Intelligence",
  "subreddits": ["nvidia", "stocks", "investing"],
  "keywords": ["NVDA stock", "Nvidia AI chips", "Nvidia earnings"],
  "twitterKeywords": ["NVDA", "Nvidia AI", "Nvidia stock"],
  "allowlist": ["nvidia", "stocks", "investing"],
  "notify": true
}
```

- `subreddits`, `keywords`, `twitterKeywords` — at least one required.
- `twitterKeywords` alone → Twitter-only run (Reddit skipped entirely).
- `allowlist` — optional filter: keyword-Reddit results restricted to these subreddits. Has no effect on Twitter results.
- `notify` — if `true`, sends Telegram digest when run completes (requires `TELEGRAM_BOT_TOKEN` + `TELEGRAM_OWNER_CHAT_ID` env vars).

### POST /search/keyword — payload

```json
{ "keyword": "AAPL", "limit": 25 }
```

- `keyword` — required, non-empty string. One keyword per request (per-term timeouts and error isolation).
- `limit` — optional, finite positive integer 1-100, default 25. Posts are sorted by score (descending) and trimmed to this many entries.
- Auth: `X-Xpoz-Token` required (same token as `/run` and `/reset`).
- Server-side cap: 90s per request. On upstream MCP failure returns `502` with a sanitized error tag (no upstream URL or token leakage).

Response shape:

```json
{
  "keyword": "AAPL",
  "postCount": 25,
  "topPost": {
    "title": "...",
    "score": 42,
    "subreddit": "stocks",
    "url": "..."
  },
  "posts": [
    {
      "title": "...",
      "score": 42,
      "subreddit": "stocks",
      "url": "...",
      "createdUtc": 1700000000
    }
  ]
}
```

`topPost` is `null` when zero posts match.

### POST /reset — response

```json
{ "cleared": true, "tables": ["posts", "topics", "runs"] }
```

Returns `409 Conflict` if a run is currently in progress.

---

## MCP Tools (Jarvis integration)

The MCP server (`mcp-server.ts`) exposes these tools to Jarvis:

| Tool                 | Description                                               |
| -------------------- | --------------------------------------------------------- |
| `run_pipeline`       | Trigger a run with a seed (label + subreddits + keywords) |
| `get_latest_topics`  | Retrieve top topics from the most recent run              |
| `get_digest`         | Get the markdown digest from the most recent run          |
| `get_run_history`    | List past runs with stats                                 |
| `get_credit_summary` | Show credit usage vs. plan limit                          |

Registered in mission-control's `mcp-servers.json` with `deferredTools: true`.

---

## Clean-slate guarantee

Every run begins with a full DB wipe — no data bleeds between seeds:

1. **Step [0/5]** in `pipeline.ts` calls `clearAllData()` before ingesting anything.
2. `clearAllData()` truncates `posts`, `topics`, and `runs`, and resets `sqlite_sequence` so IDs restart from 1.
3. The `/reset` endpoint provides manual on-demand clearing (useful before a fresh batch of runs).

This ensures topic clustering is never contaminated by previous seeds.

---

## Twitter-only runs

Pass only `twitterKeywords` (no `subreddits`, no `keywords`):

```json
{
  "label": "Longevity Twitter",
  "twitterKeywords": [
    "longevity",
    "healthspan",
    "lifespan extension",
    "biohacking"
  ]
}
```

Reddit steps are skipped entirely. The `allowlist` filter does not apply to Twitter results.

> **Note:** Xpoz Twitter coverage is more limited than Reddit. A run with 5 Twitter keywords consumes ~25 credits and may return fewer posts than an equivalent Reddit run.

---

## Xpoz API — key behaviors

| Behavior               | Detail                                                                                                                             |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **Async with polling** | Subreddit fetches return an `operationId`. Client polls `checkOperationStatus` until `status: success`.                            |
| **Keyword search**     | May be synchronous depending on `responseType`.                                                                                    |
| **Credit consumption** | ~0.5–1.5 credits per subreddit task. Tracked and persisted per run.                                                                |
| **Score field**        | Keyword results return `score: 0` by default. The pipeline does not filter by minimum score (would eliminate all keyword results). |
| **Parameter naming**   | `fields` (keywords in keyword search) ≠ `postFields` (subreddits in subreddit search).                                             |

---

## Operations

### Start / restart server

```bash
# Clean restart (kills old process + clears tsx cache):
bash /root/claude/projects/xpoz-pipeline/scripts/restart.sh

# Full clean restart (also wipes DB):
bash /root/claude/projects/xpoz-pipeline/scripts/restart.sh --clean
```

Server logs to `/tmp/xpoz-server.log`.

### Check status

```bash
curl -s http://127.0.0.1:8086/health | jq .
```

### Trigger a run manually

```bash
curl -s -X POST http://127.0.0.1:8086/run \
  -H "Content-Type: application/json" \
  -d '{
    "label": "AI Agents",
    "subreddits": ["artificial", "singularity", "MachineLearning", "LocalLLaMA", "ChatGPT"],
    "keywords": ["AI agents", "autonomous agents", "agentic AI", "LLM agents"],
    "allowlist": ["artificial", "singularity", "MachineLearning", "LocalLLaMA", "ChatGPT"]
  }' | jq .
```

### Reset DB

```bash
curl -s -X POST http://127.0.0.1:8086/reset | jq .
```

---

## Environment variables

| Variable                 | Required | Description                            |
| ------------------------ | -------- | -------------------------------------- |
| `XPOZ_API_KEY`           | ✅       | Xpoz MCP API key                       |
| `TELEGRAM_BOT_TOKEN`     | Optional | Telegram bot token for digest delivery |
| `TELEGRAM_OWNER_CHAT_ID` | Optional | Telegram chat ID for digest delivery   |

---

## Seeds run to date

| Seed                     | Posts | Topics | Duration | Credits |
| ------------------------ | ----- | ------ | -------- | ------- |
| México                   | 175   | 6      | 76s      | —       |
| AI Agents                | 267   | 7      | 36s      | —       |
| CRM                      | 246   | 10     | 77s      | —       |
| NVDA                     | 558   | —      | —        | —       |
| Red Light Therapy        | 358   | 8      | 73s      | 76.80   |
| Bitcoin                  | —     | —      | —        | —       |
| Longevity (Twitter-only) | 0     | —      | 32s      | 25.00   |

> Total credits consumed across all runs: ~321 / 5,000 (6.4% of plan)

---

## Development

```bash
npm run dev        # tsx watch (hot reload)
npm run build      # tsc → dist/
npx tsc --noEmit   # typecheck — must be zero errors
```

**Stack:** TypeScript · ESM · Hono · better-sqlite3 · @modelcontextprotocol/sdk · node-cron

---

## Status: ✅ Complete

All phases shipped:

| Phase | Description                               | Status |
| ----- | ----------------------------------------- | ------ |
| 0     | Xpoz API integration + SQLite storage     | ✅     |
| 1     | Multi-subreddit parallel ingest           | ✅     |
| 2     | Dynamic topic clustering + delta analysis | ✅     |
| 3     | Markdown/JSON reports + Telegram notify   | ✅     |
| 4     | HTTP API server (`localhost:8086`)        | ✅     |
| 5     | MCP server — Jarvis tool integration      | ✅     |
| A     | Twitter/X integration (opt-in per run)    | ✅     |
| B     | Twitter-only runs (no Reddit required)    | ✅     |
| C     | Clean-slate DB before every run           | ✅     |
