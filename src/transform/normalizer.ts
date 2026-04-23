/**
 * Normalizer — Deduplication, cleaning, and topic clustering
 *
 * Phase 1 scope:
 * - Deduplicate posts by ID across all sources
 * - Sort by score descending
 * - Cluster into topics via keyword matching
 * - Return top 10 topics with aggregate scores
 */

import type { NormalizedXpozPost } from "../ingest/xpoz-client.js";
import type { IngestResult } from "../ingest/ingestor.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DeduplicatedPost extends NormalizedXpozPost {
  subreddits: string[];   // all subreddits where this post appeared
  fetchSources: string[]; // 'subreddit:X' or 'keyword:Y' or 'twitter:Z'
  platform: "reddit" | "twitter";
}

export interface Topic {
  rank: number;
  title: string;
  posts: DeduplicatedPost[];
  aggregateScore: number;
  totalComments: number;
  subreddits: string[];
  representative: DeduplicatedPost;
}

export interface NormalizeResult {
  posts: DeduplicatedPost[];
  topics: Topic[];
  stats: {
    rawPostCount: number;
    afterDedup: number;
    topicCount: number;
  };
}

// ─── Deduplication ────────────────────────────────────────────────────────────

function deduplicatePosts(results: IngestResult[]): DeduplicatedPost[] {
  const seen = new Map<string, DeduplicatedPost>();

  for (const result of results) {
    const source = result.source === "keyword"
      ? `keyword:${result.keyword}`
      : `subreddit:${result.subreddit}`;

    for (const post of result.posts) {
      const key = post.id;
      if (!key || !post.title) continue;

      const platform: "reddit" | "twitter" = post.id.startsWith("tw_") ? "twitter" : "reddit";

      if (seen.has(key)) {
        const existing = seen.get(key)!;
        if (!existing.fetchSources.includes(source)) existing.fetchSources.push(source);
        if (!existing.subreddits.includes(post.subreddit)) existing.subreddits.push(post.subreddit);
        if (post.score > existing.score) existing.score = post.score;
      } else {
        seen.set(key, {
          ...post,
          subreddits: [post.subreddit],
          fetchSources: [source],
          platform,
        });
      }
    }
  }

  return Array.from(seen.values()).sort((a, b) => b.score - a.score);
}

// ─── Topic Clusters ───────────────────────────────────────────────────────────

const TOPIC_CLUSTERS: Array<{ title: string; keywords: string[] }> = [
  {
    title: "Epigenetic Reprogramming & Cell Rejuvenation",
    keywords: ["epigenetic", "reprogramming", "yamanaka", "life biosciences", "altos labs", "turn bio", "er-100", "partial reprogramming", "cellular reset"],
  },
  {
    title: "Rapamycin & mTOR",
    keywords: ["rapamycin", "mtor", "sirolimus", "rapalog", "rapa-ex"],
  },
  {
    title: "Senolytics & Senescent Cells",
    keywords: ["senolytic", "senescent", "senescence", "dasatinib", "quercetin", "sglt2", "zombie cell", "homoharringtonine", "fisetin"],
  },
  {
    title: "Mitochondrial Health & NAD+",
    keywords: ["mitochondr", "nad+", "nmn", "coq10", "mitrix", "atp", "berberine", "metformin", "ampk", "nicotinamide"],
  },
  {
    title: "GLP-1 / Ozempic & Metabolic Longevity",
    keywords: ["glp-1", "glp1", "ozempic", "semaglutide", "tirzepatide", "metabolic", "insulin resistance", "obesity", "diabetes longevity"],
  },
  {
    title: "Cryonics & Brain Preservation",
    keywords: ["cryo", "cryopreserv", "frozen brain", "vitrif", "alcor", "brain preservation", "cryosleep"],
  },
  {
    title: "Mind Upload & Digital Consciousness",
    keywords: ["mind upload", "brain upload", "consciousness", "digital immortal", "whole brain emulation", "substrate independent", "digital body", "brain emulation"],
  },
  {
    title: "Telomere & Telomerase Therapies",
    keywords: ["telomer", "telomerase", "telocyte", "sirt6", "tert", "telomere shortening", "epitalon"],
  },
  {
    title: "AI & Drug Discovery for Longevity",
    // Requires AI keyword combined with longevity/drug-discovery context — not general AI posts
    keywords: ["alphafold", "drug discovery ai", "openai aging", "ai longevity", "machine learning longevity", "ai drug", "ai aging", "ai lifespan", "ai cancer", "ai reprogramming", "ai biology", "ai health", "ai medicine", "aging algorithm", "longevity ai"],
  },
  {
    title: "Philosophy of Immortality & Vitalism",
    keywords: ["immortal", "don't die", "vitalism", "anti-death", "longevity escape velocity", "lev", "bryan johnson", "anti-aging movement", "defeat aging", "cure aging", "end aging"],
  },
  {
    title: "Gene Therapy & CRISPR",
    keywords: ["gene therapy", "crispr", "aav", "gene editing", "dna repair", "dna damage", "genetic"],
  },
  {
    title: "Stem Cells & Regenerative Medicine",
    keywords: ["stem cell", "regenerat", "mesenchymal", "ips cell", "thymus", "young blood", "plasma"],
  },
  {
    title: "Nutrition, Supplements & Lifestyle",
    keywords: ["supplement", "diet", "fasting", "exercise", "lifespan", "food", "cancer prevent", "vegeta", "fruit", "seed", "berr", "nuts", "fish", "omega", "vitamin", "mineral", "cocoa", "cruciferous", "cardiovascular"],
  },
  {
    title: "Cancer Research & Prevention",
    keywords: ["cancer", "tumor", "carcinogen", "oncol", "chemotherapy", "immunotherapy", "colorectal", "breast cancer", "pancreatic"],
  },
  {
    title: "Neuroscience & Brain Health",
    keywords: ["alzheimer", "dementia", "cognitive", "brain health", "neurodegenerat", "blood-brain barrier", "neural", "neuron", "brain fog", "memory"],
  },
  {
    title: "Biohacking & Personal Optimization",
    keywords: ["biohack", "testosterone", "hormone", "peptide", "bpc-157", "protocol", "stack", "hgh", "igf", "sarm", "nootropic"],
  },
];

function matchCluster(post: DeduplicatedPost): string {
  const text = `${post.title} ${post.selftext}`.toLowerCase();
  for (const cluster of TOPIC_CLUSTERS) {
    if (cluster.keywords.some((kw) => text.includes(kw.toLowerCase()))) {
      return cluster.title;
    }
  }
  return "Other / Emerging";
}

function groupIntoTopics(posts: DeduplicatedPost[]): Topic[] {
  const clusters = new Map<string, DeduplicatedPost[]>();

  for (const post of posts) {
    const label = matchCluster(post);
    if (!clusters.has(label)) clusters.set(label, []);
    clusters.get(label)!.push(post);
  }

  const topics: Topic[] = [];

  for (const [title, clusterPosts] of clusters.entries()) {
    if (clusterPosts.length === 0) continue;
    const sorted = [...clusterPosts].sort((a, b) => b.score - a.score);
    topics.push({
      rank: 0,
      title,
      posts: sorted,
      aggregateScore: clusterPosts.reduce((s, p) => s + p.score, 0),
      totalComments: clusterPosts.reduce((s, p) => s + p.numComments, 0),
      subreddits: [...new Set(clusterPosts.flatMap((p) => p.subreddits))],
      representative: sorted[0],
    });
  }

  topics.sort((a, b) => b.aggregateScore - a.aggregateScore);
  topics.forEach((t, i) => (t.rank = i + 1));
  return topics;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export function normalize(results: IngestResult[]): NormalizeResult {
  const rawPostCount = results.reduce((s, r) => s + r.posts.length, 0);
  const posts = deduplicatePosts(results);
  const topics = groupIntoTopics(posts);

  console.log(`[normalizer] ${rawPostCount} raw → ${posts.length} unique → ${topics.length} clusters`);

  return {
    posts,
    topics: topics.slice(0, 10),
    stats: { rawPostCount, afterDedup: posts.length, topicCount: topics.length },
  };
}
