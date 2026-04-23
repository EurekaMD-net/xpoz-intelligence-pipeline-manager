import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";

// Mock runPipeline so we don't touch the DB or Xpoz API during server tests.
// vi.hoisted keeps the mock shared + visible inside vi.mock's factory.
const runPipelineMock = vi.hoisted(() => vi.fn());
vi.mock("../pipeline.js", () => ({
  runPipeline: runPipelineMock,
}));

// Mock the store layer so server.ts imports don't try to open data/pipeline.db
vi.mock("../store/queries.js", () => ({
  getAllRuns: () => [],
  getLastRun: () => null,
  getTopicsForRun: () => [],
  getCreditSummary: () => ({
    totalCreditsUsed: 0,
    totalCreditsRemaining: 5000,
    planCreditsTotal: 5000,
    percentUsed: 0,
    runCount: 0,
    history: [],
  }),
  clearAllData: () => ({ deletedRuns: 0, deletedTopics: 0, deletedPosts: 0 }),
}));

interface JsonResponse {
  [key: string]: unknown;
}

async function fetchJson(
  url: string,
  init?: RequestInit,
): Promise<{ status: number; body: JsonResponse }> {
  const res = await fetch(url, init);
  const body = (await res.json()) as JsonResponse;
  return { status: res.status, body };
}

describe("API server — integration (auth + jobs)", () => {
  let baseUrl: string;

  beforeAll(async () => {
    // Run without auth to exercise job-tracking paths
    delete process.env.XPOZ_API_TOKEN;
    vi.resetModules();
    runPipelineMock.mockReset();
    runPipelineMock.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 50));
      return {
        runId: 1,
        topicCount: 5,
        uniquePosts: 100,
        rawPosts: 200,
        durationMs: 1000,
        newTopics: 5,
        upTopics: 0,
        telegramSent: false,
        creditsUsed: 1,
        queriesCount: 1,
      };
    });
    const { startApiServer } = await import("./server.js");
    const port = 18086 + Math.floor(Math.random() * 1000);
    startApiServer(port);
    baseUrl = `http://localhost:${port}`;
    // Give the server a moment to bind
    await new Promise((r) => setTimeout(r, 150));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("POST /run returns a jobId + status:'started'", async () => {
    const { status, body } = await fetchJson(`${baseUrl}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        label: "test",
        subreddits: ["test"],
        keywords: ["test"],
      }),
    });
    expect(status).toBe(200);
    expect(body.jobId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(body.status).toBe("started");
  });

  it("GET /run/jobs/:jobId returns 404 for unknown jobId", async () => {
    const { status } = await fetchJson(
      `${baseUrl}/run/jobs/00000000-0000-0000-0000-000000000000`,
    );
    expect(status).toBe(404);
  });

  it("GET /run/jobs lists recently-created jobs", async () => {
    const { status, body } = await fetchJson(`${baseUrl}/run/jobs`);
    expect(status).toBe(200);
    expect(typeof body.count).toBe("number");
    expect(Array.isArray(body.jobs)).toBe(true);
  });

  it("POST /run without body fields returns 400", async () => {
    // Wait for any in-flight run from a prior test to clear runInProgress.
    for (let i = 0; i < 30; i++) {
      const { body } = await fetchJson(`${baseUrl}/run/status`);
      if (body.inProgress === false) break;
      await new Promise((r) => setTimeout(r, 30));
    }
    const { status, body } = await fetchJson(`${baseUrl}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(status).toBe(400);
    expect(String(body.error)).toMatch(/requires at least one/i);
  });

  it("GET /health reports authEnabled:false when token is unset", async () => {
    const { status, body } = await fetchJson(`${baseUrl}/health`);
    expect(status).toBe(200);
    expect(body.authEnabled).toBe(false);
    expect(body.status).toBe("ok");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Auth-enabled integration: set XPOZ_API_TOKEN before startApiServer and
// verify 401-without-header, 200-with-correct-header, 401-on-wrong-token.
// This catches audit W2 — previously all auth coverage was the no-auth branch.
// ──────────────────────────────────────────────────────────────────────────────

describe("API server — auth enabled", () => {
  let baseUrl: string;
  const TOKEN = "test-token-" + Math.random().toString(36).slice(2, 10);

  beforeAll(async () => {
    process.env.XPOZ_API_TOKEN = TOKEN;
    vi.resetModules();
    runPipelineMock.mockReset();
    runPipelineMock.mockResolvedValue({
      runId: 1,
      topicCount: 1,
      uniquePosts: 10,
      rawPosts: 20,
      durationMs: 100,
      newTopics: 1,
      upTopics: 0,
      telegramSent: false,
      creditsUsed: 0.1,
      queriesCount: 1,
    });
    const { startApiServer } = await import("./server.js");
    const port = 19086 + Math.floor(Math.random() * 1000);
    startApiServer(port);
    baseUrl = `http://localhost:${port}`;
    await new Promise((r) => setTimeout(r, 150));
  });

  it("POST /run without X-Xpoz-Token returns 401", async () => {
    const { status, body } = await fetchJson(`${baseUrl}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        label: "t",
        subreddits: ["s"],
        keywords: ["k"],
      }),
    });
    expect(status).toBe(401);
    expect(String(body.error)).toMatch(/unauthorized/i);
  });

  it("POST /run with wrong X-Xpoz-Token returns 401", async () => {
    const { status } = await fetchJson(`${baseUrl}/run`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Xpoz-Token": TOKEN + "-wrong",
      },
      body: JSON.stringify({
        label: "t",
        subreddits: ["s"],
        keywords: ["k"],
      }),
    });
    expect(status).toBe(401);
  });

  it("POST /run with correct X-Xpoz-Token returns 200", async () => {
    const { status, body } = await fetchJson(`${baseUrl}/run`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Xpoz-Token": TOKEN,
      },
      body: JSON.stringify({
        label: "t",
        subreddits: ["s"],
        keywords: ["k"],
      }),
    });
    expect(status).toBe(200);
    expect(typeof body.jobId).toBe("string");
  });

  it("POST /run rejects non-boolean 'notify' with 400", async () => {
    // Wait for any prior run to clear so we hit 400 (validation), not 409.
    for (let i = 0; i < 30; i++) {
      const { body } = await fetchJson(`${baseUrl}/run/status`);
      if (body.inProgress === false) break;
      await new Promise((r) => setTimeout(r, 30));
    }
    const { status, body } = await fetchJson(`${baseUrl}/run`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Xpoz-Token": TOKEN,
      },
      body: JSON.stringify({
        label: "t",
        subreddits: ["s"],
        keywords: ["k"],
        notify: "true", // string, should be rejected
      }),
    });
    expect(status).toBe(400);
    expect(String(body.error)).toMatch(/'notify' must be a boolean/i);
  });

  it("GET /health reports authEnabled:true when token is set", async () => {
    const { status, body } = await fetchJson(`${baseUrl}/health`);
    expect(status).toBe(200);
    expect(body.authEnabled).toBe(true);
  });
});
