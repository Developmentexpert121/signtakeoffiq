/**
 * Integration-style tests for the server startup path.
 *
 * Verifies that index.ts refuses to bind the HTTP server when operator env
 * vars are invalid, logs every bad value in a single summary, and exits with
 * code 1.  Each test does a fresh module import (vi.resetModules) so that the
 * top-level module code in index.ts re-runs with the env vars set for that
 * test.
 *
 * process.exit is replaced with a spy so we can assert the exit code without
 * actually killing the test process.  Because the spy is a no-op, the module
 * code continues to run after the validation block; all downstream mocks are
 * therefore kept in place to avoid unhandled errors.
 */
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

vi.mock("../app", () => ({
  default: {
    listen: vi.fn((_port: number, cb: (err?: Error) => void) => cb()),
  },
}));

vi.mock("../lib/guestCleanup", () => ({
  startGuestCleanupJob: vi.fn(),
}));

vi.mock("../lib/logger", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

describe("server startup — config validation guard", () => {
  const saved: Record<string, string | undefined> = {};
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    saved["PORT"] = process.env["PORT"];
    saved["AI_VISION_CALLS_PER_RUN"] = process.env["AI_VISION_CALLS_PER_RUN"];
    saved["RASTERIZE_DPI"] = process.env["RASTERIZE_DPI"];
    saved["ANTHROPIC_API_KEY"] = process.env["ANTHROPIC_API_KEY"];
    process.env["PORT"] = "19999";
    process.env["ANTHROPIC_API_KEY"] = "sk-ant-test-key";
    delete process.env["AI_VISION_CALLS_PER_RUN"];
    delete process.env["RASTERIZE_DPI"];
    vi.resetModules();

    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as () => never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    if (saved["PORT"] === undefined) delete process.env["PORT"];
    else process.env["PORT"] = saved["PORT"];
    if (saved["AI_VISION_CALLS_PER_RUN"] === undefined)
      delete process.env["AI_VISION_CALLS_PER_RUN"];
    else process.env["AI_VISION_CALLS_PER_RUN"] = saved["AI_VISION_CALLS_PER_RUN"];
    if (saved["RASTERIZE_DPI"] === undefined)
      delete process.env["RASTERIZE_DPI"];
    else process.env["RASTERIZE_DPI"] = saved["RASTERIZE_DPI"];
    if (saved["ANTHROPIC_API_KEY"] === undefined)
      delete process.env["ANTHROPIC_API_KEY"];
    else process.env["ANTHROPIC_API_KEY"] = saved["ANTHROPIC_API_KEY"];
  });

  // -------------------------------------------------------------------------
  // AI_VISION_CALLS_PER_RUN
  // -------------------------------------------------------------------------

  it('calls process.exit(1) when AI_VISION_CALLS_PER_RUN is "ten"', async () => {
    process.env["AI_VISION_CALLS_PER_RUN"] = "ten";
    await import("../index.js");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('calls process.exit(1) when AI_VISION_CALLS_PER_RUN is "-1"', async () => {
    process.env["AI_VISION_CALLS_PER_RUN"] = "-1";
    await import("../index.js");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('calls process.exit(1) when AI_VISION_CALLS_PER_RUN is "0"', async () => {
    process.env["AI_VISION_CALLS_PER_RUN"] = "0";
    await import("../index.js");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('calls process.exit(1) when AI_VISION_CALLS_PER_RUN is "3.5"', async () => {
    process.env["AI_VISION_CALLS_PER_RUN"] = "3.5";
    await import("../index.js");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('does NOT call process.exit when AI_VISION_CALLS_PER_RUN is "5"', async () => {
    process.env["AI_VISION_CALLS_PER_RUN"] = "5";
    await import("../index.js");
    expect(exitSpy).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // RASTERIZE_DPI
  // -------------------------------------------------------------------------

  it('calls process.exit(1) when RASTERIZE_DPI is "abc"', async () => {
    process.env["RASTERIZE_DPI"] = "abc";
    await import("../index.js");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('calls process.exit(1) when RASTERIZE_DPI is "0"', async () => {
    process.env["RASTERIZE_DPI"] = "0";
    await import("../index.js");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('calls process.exit(1) when RASTERIZE_DPI is "-72"', async () => {
    process.env["RASTERIZE_DPI"] = "-72";
    await import("../index.js");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('does NOT call process.exit when RASTERIZE_DPI is "200"', async () => {
    process.env["RASTERIZE_DPI"] = "200";
    await import("../index.js");
    expect(exitSpy).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Both vars invalid at once — all errors must appear in one summary
  // -------------------------------------------------------------------------

  it("logs aggregated errors and exits once when BOTH vars are invalid", async () => {
    process.env["RASTERIZE_DPI"] = "0";
    process.env["AI_VISION_CALLS_PER_RUN"] = "bad";

    const { logger } = vi.mocked(await import("../lib/logger"));
    vi.clearAllMocks();

    await import("../index.js");

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(exitSpy).toHaveBeenCalledTimes(1);

    const calls = (logger.error as ReturnType<typeof vi.fn>).mock.calls;
    const summaryCall = calls.find(
      (c) => typeof c[0] === "object" && c[0] !== null && "configErrors" in c[0],
    );
    expect(summaryCall).toBeDefined();
    const configErrors = (summaryCall![0] as { configErrors: string[] }).configErrors;
    expect(configErrors).toHaveLength(2);
    expect(configErrors.some((e) => e.includes("RASTERIZE_DPI"))).toBe(true);
    expect(configErrors.some((e) => e.includes("AI_VISION_CALLS_PER_RUN"))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Defaults — no env vars set
  // -------------------------------------------------------------------------

  it("does NOT call process.exit when both vars are absent (defaults apply)", async () => {
    await import("../index.js");
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
