/**
 * Tests for the GET /healthz endpoint.
 *
 * Verifies the endpoint returns structured JSON reflecting config validity
 * and database connectivity:
 *  - 200 { status: "ok",    config: { valid: true },  db: { connected: true } }  — all healthy
 *  - 503 { status: "error", config: { valid: false, errors }, db: ... }           — config invalid
 *  - 503 { status: "error", config: { valid: true },  db: { connected: false, error: "..." } } — db down
 *
 * The @workspace/db pool is mocked so tests remain fast and isolated from
 * any real database. Individual tests override the mock behaviour to simulate
 * DB-up and DB-down scenarios.
 *
 * env vars are temporarily overridden per test and restored in afterEach so
 * tests stay isolated from each other and from the real process environment.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import request from "supertest";
import express from "express";

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));

vi.mock("@workspace/db", () => ({
  pool: { query: mockQuery },
}));

import healthRouter from "../routes/health";

function createApp() {
  const app = express();
  app.use(healthRouter);
  return app;
}

const VARS = ["RASTERIZE_DPI", "AI_VISION_CALLS_PER_RUN", "CLAUDE_VISION_BASE_DELAY_MS"] as const;

type SavedEnv = Record<string, string | undefined>;

function saveEnv(): SavedEnv {
  const saved: SavedEnv = {};
  for (const key of VARS) saved[key] = process.env[key];
  return saved;
}

function restoreEnv(saved: SavedEnv): void {
  for (const key of VARS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
}

describe("GET /healthz — config validation", () => {
  let saved: SavedEnv;

  afterEach(() => {
    restoreEnv(saved);
    vi.resetAllMocks();
  });

  it("returns 200 and { status: 'ok', config: { valid: true }, db: { connected: true } } when env vars are absent (defaults apply)", async () => {
    saved = saveEnv();
    for (const key of VARS) delete process.env[key];
    mockQuery.mockResolvedValueOnce({ rows: [{ "?column?": 1 }] });

    const res = await request(createApp()).get("/healthz");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.config.valid).toBe(true);
    expect(res.body.config.errors).toBeUndefined();
    expect(res.body.db).toEqual({ connected: true });
  });

  it("returns 200 when all configured env vars are valid values", async () => {
    saved = saveEnv();
    process.env["RASTERIZE_DPI"] = "200";
    process.env["AI_VISION_CALLS_PER_RUN"] = "5";
    process.env["CLAUDE_VISION_BASE_DELAY_MS"] = "3000";
    mockQuery.mockResolvedValueOnce({ rows: [{ "?column?": 1 }] });

    const res = await request(createApp()).get("/healthz");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.config.valid).toBe(true);
    expect(res.body.db).toEqual({ connected: true });
  });

  it("returns 503 and { status: 'error', config: { valid: false, errors } } when RASTERIZE_DPI is invalid", async () => {
    saved = saveEnv();
    process.env["RASTERIZE_DPI"] = "bad";
    delete process.env["AI_VISION_CALLS_PER_RUN"];
    delete process.env["CLAUDE_VISION_BASE_DELAY_MS"];
    mockQuery.mockResolvedValueOnce({ rows: [{ "?column?": 1 }] });

    const res = await request(createApp()).get("/healthz");

    expect(res.status).toBe(503);
    expect(res.body.status).toBe("error");
    expect(res.body.config.valid).toBe(false);
    expect(Array.isArray(res.body.config.errors)).toBe(true);
    expect(res.body.config.errors).toHaveLength(1);
    expect(res.body.config.errors[0]).toContain("RASTERIZE_DPI");
  });

  it("returns 503 when AI_VISION_CALLS_PER_RUN is invalid", async () => {
    saved = saveEnv();
    delete process.env["RASTERIZE_DPI"];
    process.env["AI_VISION_CALLS_PER_RUN"] = "not-a-number";
    delete process.env["CLAUDE_VISION_BASE_DELAY_MS"];
    mockQuery.mockResolvedValueOnce({ rows: [{ "?column?": 1 }] });

    const res = await request(createApp()).get("/healthz");

    expect(res.status).toBe(503);
    expect(res.body.config.valid).toBe(false);
    expect(res.body.config.errors[0]).toContain("AI_VISION_CALLS_PER_RUN");
  });

  it("returns 503 when CLAUDE_VISION_BASE_DELAY_MS is invalid", async () => {
    saved = saveEnv();
    delete process.env["RASTERIZE_DPI"];
    delete process.env["AI_VISION_CALLS_PER_RUN"];
    process.env["CLAUDE_VISION_BASE_DELAY_MS"] = "-500";
    mockQuery.mockResolvedValueOnce({ rows: [{ "?column?": 1 }] });

    const res = await request(createApp()).get("/healthz");

    expect(res.status).toBe(503);
    expect(res.body.config.valid).toBe(false);
    expect(res.body.config.errors[0]).toContain("CLAUDE_VISION_BASE_DELAY_MS");
  });

  it("returns 503 with all errors when multiple env vars are invalid", async () => {
    saved = saveEnv();
    process.env["RASTERIZE_DPI"] = "0";
    process.env["AI_VISION_CALLS_PER_RUN"] = "1.5";
    delete process.env["CLAUDE_VISION_BASE_DELAY_MS"];
    mockQuery.mockResolvedValueOnce({ rows: [{ "?column?": 1 }] });

    const res = await request(createApp()).get("/healthz");

    expect(res.status).toBe(503);
    expect(res.body.config.valid).toBe(false);
    expect(res.body.config.errors).toHaveLength(2);
    expect(res.body.config.errors.some((e: string) => e.includes("RASTERIZE_DPI"))).toBe(true);
    expect(res.body.config.errors.some((e: string) => e.includes("AI_VISION_CALLS_PER_RUN"))).toBe(true);
  });

  it("does not require authentication — responds without any Authorization header", async () => {
    saved = saveEnv();
    for (const key of VARS) delete process.env[key];
    mockQuery.mockResolvedValueOnce({ rows: [{ "?column?": 1 }] });

    const res = await request(createApp()).get("/healthz");

    expect(res.status).toBe(200);
  });
});

describe("GET /healthz — database connectivity", () => {
  let saved: SavedEnv;

  afterEach(() => {
    restoreEnv(saved);
    vi.resetAllMocks();
  });

  it("returns 200 with db.connected=true when the DB ping succeeds", async () => {
    saved = saveEnv();
    for (const key of VARS) delete process.env[key];
    mockQuery.mockResolvedValueOnce({ rows: [{ "?column?": 1 }] });

    const res = await request(createApp()).get("/healthz");

    expect(res.status).toBe(200);
    expect(res.body.db).toEqual({ connected: true });
  });

  it("returns 503 with db.connected=false and an error message when the DB ping throws", async () => {
    saved = saveEnv();
    for (const key of VARS) delete process.env[key];
    mockQuery.mockRejectedValueOnce(new Error("connection refused"));

    const res = await request(createApp()).get("/healthz");

    expect(res.status).toBe(503);
    expect(res.body.status).toBe("error");
    expect(res.body.db.connected).toBe(false);
    expect(res.body.db.error).toBe("connection refused");
    expect(res.body.config.valid).toBe(true);
  });

  it("returns 503 with db.connected=false when the DB ping times out", async () => {
    saved = saveEnv();
    for (const key of VARS) delete process.env[key];
    mockQuery.mockImplementationOnce(
      () => new Promise((resolve) => setTimeout(resolve, 5000)),
    );

    const res = await request(createApp()).get("/healthz");

    expect(res.status).toBe(503);
    expect(res.body.db.connected).toBe(false);
    expect(res.body.db.error).toContain("timed out");
  });

  it("returns 503 with both config and db errors when both are unhealthy", async () => {
    saved = saveEnv();
    process.env["RASTERIZE_DPI"] = "bad";
    delete process.env["AI_VISION_CALLS_PER_RUN"];
    delete process.env["CLAUDE_VISION_BASE_DELAY_MS"];
    mockQuery.mockRejectedValueOnce(new Error("DB unavailable"));

    const res = await request(createApp()).get("/healthz");

    expect(res.status).toBe(503);
    expect(res.body.config.valid).toBe(false);
    expect(res.body.db.connected).toBe(false);
    expect(res.body.db.error).toBe("DB unavailable");
  });
});
