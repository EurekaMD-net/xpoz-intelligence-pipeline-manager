// ─── Xpoz Intelligence Pipeline — Configuration ───────────────────────────

export const XPOZ_CONFIG = {
  /** MCP server endpoint */
  endpoint: "https://mcp.xpoz.ai/mcp",
  /** Bearer token (peter.blades@gmail.com account, no expiration) */
  apiKey: "K3BxffCU1FsbqJecKRkfLTNfECtsDp1Rq3XNR1PVcVCVdrLffiz4lgJbeGix23CKaVoaFg4",
  /** Max posts to fetch per subreddit */
  postsLimit: 100,
  /** Minimum score to include a post (filter noise) */
  minScore: 10,
  /** Timeout per API call in milliseconds */
  timeoutMs: 30_000,
} as const;

// ─── Topic Configuration ──────────────────────────────────────────────────────

/**
 * Topic configuration supplied inline by the operator on every run.
 * There are NO presets and NO defaults — every run must provide this
 * explicitly via the POST /run body or the CLI --topic-config flag.
 */
export interface TopicConfig {
  /** Human-readable label for reports */
  label: string;
  /** Subreddits to fetch directly */
  subreddits: string[];
  /** Keywords for cross-subreddit search */
  keywords: string[];
  /** Allowlist: keyword results are filtered to only these subreddits */
  allowlist: Set<string>;
  /** Optional: Twitter/X keywords to fetch alongside Reddit */
  twitterKeywords?: string[];
}
