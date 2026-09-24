import { describe, it, expect } from "vitest";
import {
  parseAiVisionCallsPerRun,
  parseRasterizeDpi,
  parseClaudeBaseDelayMs,
  parsePort,
} from "../lib/config-parsers";

describe("parseAiVisionCallsPerRun", () => {
  it("returns null when the env var is absent", () => {
    expect(parseAiVisionCallsPerRun({})).toBeNull();
  });

  it("returns null when the env var is an empty string", () => {
    expect(parseAiVisionCallsPerRun({ AI_VISION_CALLS_PER_RUN: "" })).toBeNull();
  });

  it("accepts a valid positive integer string", () => {
    expect(parseAiVisionCallsPerRun({ AI_VISION_CALLS_PER_RUN: "5" })).toBe(5);
    expect(parseAiVisionCallsPerRun({ AI_VISION_CALLS_PER_RUN: "10" })).toBe(10);
  });

  it('throws a descriptive error for "ten" (non-numeric string)', () => {
    expect(() =>
      parseAiVisionCallsPerRun({ AI_VISION_CALLS_PER_RUN: "ten" }),
    ).toThrow(/Invalid AI_VISION_CALLS_PER_RUN value: "ten"/);
  });

  it('throws a descriptive error for "-1" (negative integer)', () => {
    expect(() =>
      parseAiVisionCallsPerRun({ AI_VISION_CALLS_PER_RUN: "-1" }),
    ).toThrow(/Invalid AI_VISION_CALLS_PER_RUN value: "-1"/);
  });

  it('throws a descriptive error for "0" (zero)', () => {
    expect(() =>
      parseAiVisionCallsPerRun({ AI_VISION_CALLS_PER_RUN: "0" }),
    ).toThrow(/Invalid AI_VISION_CALLS_PER_RUN value: "0"/);
  });

  it('throws a descriptive error for "3.5" (non-integer float)', () => {
    expect(() =>
      parseAiVisionCallsPerRun({ AI_VISION_CALLS_PER_RUN: "3.5" }),
    ).toThrow(/Invalid AI_VISION_CALLS_PER_RUN value: "3.5"/);
  });

  it("error messages mention that a positive integer is required", () => {
    expect(() =>
      parseAiVisionCallsPerRun({ AI_VISION_CALLS_PER_RUN: "ten" }),
    ).toThrow(/positive integer/);
  });
});

describe("parseRasterizeDpi", () => {
  it("returns the default 150 when the env var is absent", () => {
    expect(parseRasterizeDpi({})).toBe(150);
  });

  it("returns the default 150 when the env var is an empty string", () => {
    expect(parseRasterizeDpi({ RASTERIZE_DPI: "" })).toBe(150);
  });

  it("accepts a valid positive number string", () => {
    expect(parseRasterizeDpi({ RASTERIZE_DPI: "300" })).toBe(300);
    expect(parseRasterizeDpi({ RASTERIZE_DPI: "72.5" })).toBe(72.5);
  });

  it("throws a descriptive error for a non-numeric string", () => {
    expect(() =>
      parseRasterizeDpi({ RASTERIZE_DPI: "high" }),
    ).toThrow(/Invalid RASTERIZE_DPI value: "high"/);
  });

  it("throws a descriptive error for a negative value", () => {
    expect(() =>
      parseRasterizeDpi({ RASTERIZE_DPI: "-100" }),
    ).toThrow(/Invalid RASTERIZE_DPI value: "-100"/);
  });

  it("throws a descriptive error for zero", () => {
    expect(() =>
      parseRasterizeDpi({ RASTERIZE_DPI: "0" }),
    ).toThrow(/Invalid RASTERIZE_DPI value: "0"/);
  });
});

describe("parseClaudeBaseDelayMs", () => {
  it("returns the default 5000 when the env var is absent", () => {
    expect(parseClaudeBaseDelayMs({})).toBe(5_000);
  });

  it("returns the default 5000 when the env var is an empty string", () => {
    expect(parseClaudeBaseDelayMs({ CLAUDE_VISION_BASE_DELAY_MS: "" })).toBe(5_000);
  });

  it("accepts a valid positive integer string", () => {
    expect(parseClaudeBaseDelayMs({ CLAUDE_VISION_BASE_DELAY_MS: "2000" })).toBe(2_000);
    expect(parseClaudeBaseDelayMs({ CLAUDE_VISION_BASE_DELAY_MS: "10000" })).toBe(10_000);
  });

  it("accepts a valid positive float string", () => {
    expect(parseClaudeBaseDelayMs({ CLAUDE_VISION_BASE_DELAY_MS: "1500.5" })).toBe(1500.5);
  });

  it("throws a descriptive error for a non-numeric string", () => {
    expect(() =>
      parseClaudeBaseDelayMs({ CLAUDE_VISION_BASE_DELAY_MS: "slow" }),
    ).toThrow(/Invalid CLAUDE_VISION_BASE_DELAY_MS value: "slow"/);
  });

  it("throws a descriptive error for a negative value", () => {
    expect(() =>
      parseClaudeBaseDelayMs({ CLAUDE_VISION_BASE_DELAY_MS: "-500" }),
    ).toThrow(/Invalid CLAUDE_VISION_BASE_DELAY_MS value: "-500"/);
  });

  it("throws a descriptive error for zero", () => {
    expect(() =>
      parseClaudeBaseDelayMs({ CLAUDE_VISION_BASE_DELAY_MS: "0" }),
    ).toThrow(/Invalid CLAUDE_VISION_BASE_DELAY_MS value: "0"/);
  });

  it("error messages indicate a positive number is required", () => {
    expect(() =>
      parseClaudeBaseDelayMs({ CLAUDE_VISION_BASE_DELAY_MS: "abc" }),
    ).toThrow(/positive number/);
  });
});

describe("parsePort", () => {
  it("throws when PORT is absent", () => {
    expect(() => parsePort({})).toThrow(/PORT environment variable is required/);
  });

  it("throws when PORT is an empty string", () => {
    expect(() => parsePort({ PORT: "" })).toThrow(/PORT environment variable is required/);
  });

  it("throws a descriptive error for a non-numeric string", () => {
    expect(() => parsePort({ PORT: "abc" })).toThrow(/Invalid PORT value: "abc"/);
  });

  it("throws a descriptive error for zero", () => {
    expect(() => parsePort({ PORT: "0" })).toThrow(/Invalid PORT value: "0"/);
  });

  it("throws a descriptive error for a negative value", () => {
    expect(() => parsePort({ PORT: "-1" })).toThrow(/Invalid PORT value: "-1"/);
  });

  it("accepts a valid positive integer port", () => {
    expect(parsePort({ PORT: "3000" })).toBe(3000);
    expect(parsePort({ PORT: "8080" })).toBe(8080);
  });

  it("throws for PORT=1 (privileged port)", () => {
    expect(() => parsePort({ PORT: "1" })).toThrow(/privileged port/);
  });

  it("throws for PORT=1023 (privileged port boundary)", () => {
    expect(() => parsePort({ PORT: "1023" })).toThrow(/privileged port/);
  });

  it("accepts PORT=1024 (first non-privileged port)", () => {
    expect(parsePort({ PORT: "1024" })).toBe(1024);
  });

  it("error message for privileged port includes the port number", () => {
    expect(() => parsePort({ PORT: "80" })).toThrow(/PORT 80/);
  });

  it("error message for privileged port mentions >= 1024", () => {
    expect(() => parsePort({ PORT: "443" })).toThrow(/1024/);
  });
});
