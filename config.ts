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

// ─── Topic Presets ────────────────────────────────────────────────────────────

export interface TopicConfig {
  /** Human-readable label for reports */
  label: string;
  /** Subreddits to fetch directly */
  subreddits: string[];
  /** Keywords for cross-subreddit search */
  keywords: string[];
  /** Allowlist: keyword results are filtered to only these subreddits */
  allowlist: Set<string>;
  /** Optional: Twitter/X keywords to fetch alongside Reddit (opt-in per topic) */
  twitterKeywords?: string[];
}

export const TOPIC_PRESETS: Record<string, TopicConfig> = {
  longevity: {
    label: "Longevity & Biohacking",
    subreddits: ["immortalists", "longevity", "transhumanism", "Biohackers", "longevityescapevelocity", "SuperLongevity"],
    keywords: [
      "epigenetic reprogramming",
      "rapamycin trial",
      "senolytic",
      "GLP-1 aging",
      "lifespan extension",
      "cryopreservation brain",
      "telomerase therapy",
    ],
    twitterKeywords: [
      "rapamycin longevity",
      "lifespan extension",
      "biohacking aging",
      "epigenetic reprogramming",
      "longevity science",
    ],
    allowlist: new Set([
      "immortalists", "longevity", "transhumanism",
      "Biohackers", "singularity", "longevityescapevelocity", "SuperLongevity",
      "longevitylearning", "aging", "geroscience", "antiaging", "biohacking",
      "Nootropics", "HubermanLab", "ketoscience", "science", "biology",
      "medicine", "health", "neuroscience", "genetics",
      "futurology", "technology", "worldnews", "askscience", "EverythingScience",
    ]),
  },

  aiagents: {
    label: "AI Agents & Autonomous Systems",
    subreddits: ["aiagents", "LangChain", "AutoGPT", "LocalLLaMA", "singularity"],
    keywords: [
      "AI agent framework",
      "autonomous agent",
      "multi-agent system",
      "LLM orchestration",
      "agentic workflow",
      "tool use LLM",
      "AI coding agent",
    ],
    twitterKeywords: [
      "AI agent framework",
      "autonomous agent LLM",
      "agentic workflow",
      "multi-agent system",
      "AI coding agent",
    ],
    allowlist: new Set([
      "aiagents", "LangChain", "AutoGPT", "LocalLLaMA", "singularity",
      "MachineLearning", "artificial", "ChatGPT", "OpenAI", "Anthropic",
      "ClaudeAI", "LanguageModelForum", "deeplearning", "learnmachinelearning",
      "agi", "AIAssistants", "programming", "SoftwareEngineering",
      "DevOps", "Python", "javascript", "webdev", "technology",
    ]),
  },

  crypto: {
    label: "Crypto & Web3",
    subreddits: ["CryptoCurrency", "ethereum", "Bitcoin", "defi", "web3"],
    keywords: [
      "DeFi protocol",
      "layer 2 scaling",
      "NFT utility",
      "crypto regulation",
      "stablecoin",
      "smart contract audit",
      "blockchain gaming",
    ],
    allowlist: new Set([
      "CryptoCurrency", "ethereum", "Bitcoin", "defi", "web3",
      "CryptoMarkets", "altcoin", "SatoshiStreetBets", "CryptoMoonShots",
      "ethfinance", "BitcoinBeginners", "ethtrader", "PolygonNetwork",
      "solana", "Cardano", "binance", "investing", "technology",
    ]),
  },

  startup: {
    label: "Startups & Entrepreneurship",
    subreddits: ["startups", "entrepreneur", "SideProject", "indiehackers", "smallbusiness"],
    keywords: [
      "startup funding",
      "product market fit",
      "SaaS growth",
      "bootstrapped startup",
      "VC investment",
      "startup pivot",
      "early stage founder",
    ],
    allowlist: new Set([
      "startups", "entrepreneur", "SideProject", "indiehackers", "smallbusiness",
      "venturecapital", "business", "marketing", "sales", "productivity",
      "growth_hacking", "EntrepreneurRideAlong", "ycombinator",
      "forhire", "hiring", "technology", "programming",
    ]),
  },

  health: {
    label: "Health & Wellness",
    subreddits: ["health", "nutrition", "fitness", "loseit", "running"],
    keywords: [
      "metabolic health",
      "sleep optimization",
      "gut microbiome",
      "intermittent fasting",
      "strength training science",
      "mental health therapy",
      "preventive medicine",
    ],
    allowlist: new Set([
      "health", "nutrition", "fitness", "loseit", "running",
      "AdvancedFitness", "bodyweightfitness", "veganfitness",
      "science", "medicine", "askscience", "psychology",
      "Meditation", "mindfulness", "sleep", "diabetes", "ketoscience",
    ]),
  },
};

/** Default topic when none is specified */
export const DEFAULT_TOPIC = "longevity";

/**
 * Returns the TopicConfig for the given topic slug.
 * Falls back to DEFAULT_TOPIC if slug not found.
 */
export function getTopicConfig(topic?: string): TopicConfig & { slug: string } {
  const slug = topic && TOPIC_PRESETS[topic] ? topic : DEFAULT_TOPIC;
  if (topic && !TOPIC_PRESETS[topic]) {
    console.warn(`[config] Unknown topic "${topic}" — falling back to "${DEFAULT_TOPIC}"`);
  }
  return { slug, ...TOPIC_PRESETS[slug] };
}

/** List of valid topic slugs */
export const VALID_TOPICS = Object.keys(TOPIC_PRESETS);

// ─── Legacy exports (kept for backward compat — map to longevity preset) ──────

const _longevity = TOPIC_PRESETS.longevity;

/** @deprecated Use getTopicConfig() instead */
export const PRIMARY_SUBREDDITS = _longevity.subreddits.slice(0, 3) as unknown as readonly string[];
/** @deprecated Use getTopicConfig() instead */
export const SECONDARY_SUBREDDITS = _longevity.subreddits.slice(3) as unknown as readonly string[];
/** @deprecated Use getTopicConfig() instead */
export const ALL_SUBREDDITS = _longevity.subreddits as unknown as readonly string[];
/** @deprecated Use getTopicConfig() instead */
export const KEYWORD_SUBREDDIT_ALLOWLIST = _longevity.allowlist;
/** @deprecated Use getTopicConfig() instead */
export const SEARCH_KEYWORDS = _longevity.keywords as unknown as readonly string[];
