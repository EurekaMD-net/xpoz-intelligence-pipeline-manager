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

/** Primary subreddits — direct longevity/immortality community */
export const PRIMARY_SUBREDDITS = [
  "immortalists",
  "longevity",
  "transhumanism",
] as const;

/** Secondary subreddits — semantically adjacent */
export const SECONDARY_SUBREDDITS = [
  "Biohackers",
  // "singularity" — removed: too broad (AI/tech dominates, low longevity signal)
  "longevityescapevelocity",
  "SuperLongevity",
] as const;

/** All subreddits to ingest */
export const ALL_SUBREDDITS = [
  ...PRIMARY_SUBREDDITS,
  ...SECONDARY_SUBREDDITS,
] as const;

/**
 * Allowlist of subreddits accepted from keyword search results.
 * Posts from any other subreddit (e.g. pennystocks, ClaudeAI) are discarded.
 * Keyword searches return posts from ALL of Reddit — we filter to relevant communities.
 */
export const KEYWORD_SUBREDDIT_ALLOWLIST = new Set([
  // Primary
  "immortalists", "longevity", "transhumanism",
  // Adjacent
  "Biohackers", "singularity", "longevityescapevelocity", "SuperLongevity",
  "longevitylearning", "aging", "geroscience", "antiaging", "biohacking",
  "Nootropics", "HubermanLab", "ketoscience", "science", "biology",
  "medicine", "health", "neuroscience", "genetics", "personalfinance",
  "futurology", "technology", "worldnews", "askscience", "EverythingScience",
]);

/** Keywords for cross-subreddit search */
export const SEARCH_KEYWORDS = [
  "epigenetic reprogramming",
  "rapamycin trial",
  "senolytic",
  "GLP-1 aging",
  "lifespan extension",
  "cryopreservation brain",
  "telomerase therapy",
] as const;

export type SubredditName = (typeof ALL_SUBREDDITS)[number];
