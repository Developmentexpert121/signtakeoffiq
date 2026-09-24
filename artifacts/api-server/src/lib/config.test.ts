import { describe, expect, it } from "vitest";
import {
  parseAnthropicApiKey,
  parseRasterizeDpi,
  parseAiVisionCallsPerRun,
  parseClaudeBaseDelayMs,
  validateStartupConfig,
} from "./config-parsers";

// ---------------------------------------------------------------------------
// parseRasterizeDpi
// ---------------------------------------------------------------------------

describe("parseRasterizeDpi – defaults", () => {
  it("returns 150 when RASTERIZE_DPI is absent", () => {
    expect(parseRasterizeDpi({})).toBe(150);
  });

  it("returns 150 when RASTERIZE_DPI is an empty string", () => {
    expect(parseRasterizeDpi({ RASTERIZE_DPI: "" })).toBe(150);
  });
});

describe("parseRasterizeDpi – valid overrides", () => {
  it("parses a positive integer string", () => {
    expect(parseRasterizeDpi({ RASTERIZE_DPI: "300" })).toBe(300);
  });

  it("parses a positive float string", () => {
    expect(parseRasterizeDpi({ RASTERIZE_DPI: "72.5" })).toBe(72.5);
  });

  it("parses '1' as the minimum positive value", () => {
    expect(parseRasterizeDpi({ RASTERIZE_DPI: "1" })).toBe(1);
  });
});

describe("parseRasterizeDpi – invalid values", () => {
  it("throws for zero", () => {
    expect(() => parseRasterizeDpi({ RASTERIZE_DPI: "0" })).toThrow(
      /Invalid RASTERIZE_DPI/,
    );
  });

  it("throws for a negative number", () => {
    expect(() => parseRasterizeDpi({ RASTERIZE_DPI: "-150" })).toThrow(
      /Invalid RASTERIZE_DPI/,
    );
  });

  it("throws for a non-numeric string", () => {
    expect(() => parseRasterizeDpi({ RASTERIZE_DPI: "high" })).toThrow(
      /Invalid RASTERIZE_DPI/,
    );
  });

  it("throws for NaN", () => {
    expect(() => parseRasterizeDpi({ RASTERIZE_DPI: "NaN" })).toThrow(
      /Invalid RASTERIZE_DPI/,
    );
  });

  it("throws for Infinity", () => {
    expect(() => parseRasterizeDpi({ RASTERIZE_DPI: "Infinity" })).toThrow(
      /Invalid RASTERIZE_DPI/,
    );
  });
});

// ---------------------------------------------------------------------------
// parseAiVisionCallsPerRun
// ---------------------------------------------------------------------------

describe("parseAiVisionCallsPerRun – defaults", () => {
  it("returns null when AI_VISION_CALLS_PER_RUN is absent (caller defaults to 10)", () => {
    expect(parseAiVisionCallsPerRun({})).toBeNull();
  });

  it("returns null when AI_VISION_CALLS_PER_RUN is an empty string", () => {
    expect(parseAiVisionCallsPerRun({ AI_VISION_CALLS_PER_RUN: "" })).toBeNull();
  });

  it("null ?? 10 evaluates to the expected default of 10", () => {
    expect(parseAiVisionCallsPerRun({}) ?? 10).toBe(10);
  });
});

describe("parseAiVisionCallsPerRun – valid overrides", () => {
  it("parses a positive integer string", () => {
    expect(parseAiVisionCallsPerRun({ AI_VISION_CALLS_PER_RUN: "5" })).toBe(5);
  });

  it("parses '1' as the minimum positive integer", () => {
    expect(parseAiVisionCallsPerRun({ AI_VISION_CALLS_PER_RUN: "1" })).toBe(1);
  });

  it("parses a large positive integer", () => {
    expect(parseAiVisionCallsPerRun({ AI_VISION_CALLS_PER_RUN: "100" })).toBe(100);
  });
});

describe("parseAiVisionCallsPerRun – invalid values", () => {
  it("throws for zero", () => {
    expect(() =>
      parseAiVisionCallsPerRun({ AI_VISION_CALLS_PER_RUN: "0" }),
    ).toThrow(/Invalid AI_VISION_CALLS_PER_RUN/);
  });

  it("throws for a negative integer", () => {
    expect(() =>
      parseAiVisionCallsPerRun({ AI_VISION_CALLS_PER_RUN: "-5" }),
    ).toThrow(/Invalid AI_VISION_CALLS_PER_RUN/);
  });

  it("throws for a float (non-integer)", () => {
    expect(() =>
      parseAiVisionCallsPerRun({ AI_VISION_CALLS_PER_RUN: "3.5" }),
    ).toThrow(/Invalid AI_VISION_CALLS_PER_RUN/);
  });

  it("throws for a non-numeric string", () => {
    expect(() =>
      parseAiVisionCallsPerRun({ AI_VISION_CALLS_PER_RUN: "many" }),
    ).toThrow(/Invalid AI_VISION_CALLS_PER_RUN/);
  });

  it("throws for NaN", () => {
    expect(() =>
      parseAiVisionCallsPerRun({ AI_VISION_CALLS_PER_RUN: "NaN" }),
    ).toThrow(/Invalid AI_VISION_CALLS_PER_RUN/);
  });

  it("throws for a value with trailing decimal (e.g. '10.')", () => {
    expect(() =>
      parseAiVisionCallsPerRun({ AI_VISION_CALLS_PER_RUN: "10." }),
    ).toThrow(/Invalid AI_VISION_CALLS_PER_RUN/);
  });
});

// ---------------------------------------------------------------------------
// parseClaudeBaseDelayMs
// ---------------------------------------------------------------------------

describe("parseClaudeBaseDelayMs – defaults", () => {
  it("returns 5000 when CLAUDE_VISION_BASE_DELAY_MS is absent", () => {
    expect(parseClaudeBaseDelayMs({})).toBe(5_000);
  });

  it("returns 5000 when CLAUDE_VISION_BASE_DELAY_MS is an empty string", () => {
    expect(parseClaudeBaseDelayMs({ CLAUDE_VISION_BASE_DELAY_MS: "" })).toBe(5_000);
  });
});

describe("parseClaudeBaseDelayMs – valid overrides", () => {
  it("parses a positive integer string", () => {
    expect(parseClaudeBaseDelayMs({ CLAUDE_VISION_BASE_DELAY_MS: "1000" })).toBe(1_000);
  });

  it("parses a positive float string", () => {
    expect(parseClaudeBaseDelayMs({ CLAUDE_VISION_BASE_DELAY_MS: "500.5" })).toBe(500.5);
  });
});

describe("parseClaudeBaseDelayMs – invalid values", () => {
  it("throws for zero", () => {
    expect(() =>
      parseClaudeBaseDelayMs({ CLAUDE_VISION_BASE_DELAY_MS: "0" }),
    ).toThrow(/Invalid CLAUDE_VISION_BASE_DELAY_MS/);
  });

  it("throws for a negative number", () => {
    expect(() =>
      parseClaudeBaseDelayMs({ CLAUDE_VISION_BASE_DELAY_MS: "-100" }),
    ).toThrow(/Invalid CLAUDE_VISION_BASE_DELAY_MS/);
  });

  it("throws for a non-numeric string", () => {
    expect(() =>
      parseClaudeBaseDelayMs({ CLAUDE_VISION_BASE_DELAY_MS: "fast" }),
    ).toThrow(/Invalid CLAUDE_VISION_BASE_DELAY_MS/);
  });
});

// ---------------------------------------------------------------------------
// parseAnthropicApiKey
// ---------------------------------------------------------------------------

describe("parseAnthropicApiKey – present key", () => {
  it("returns ANTHROPIC_API_KEY when set", () => {
    expect(parseAnthropicApiKey({ ANTHROPIC_API_KEY: "sk-ant-test-key" })).toBe("sk-ant-test-key");
  });

  it("returns the key unchanged (no trimming of value)", () => {
    expect(parseAnthropicApiKey({ ANTHROPIC_API_KEY: "sk-ant-abc123" })).toBe("sk-ant-abc123");
  });

  it("falls back to AI_INTEGRATIONS_ANTHROPIC_API_KEY when ANTHROPIC_API_KEY is absent", () => {
    expect(
      parseAnthropicApiKey({ AI_INTEGRATIONS_ANTHROPIC_API_KEY: "integration-key" }),
    ).toBe("integration-key");
  });

  it("prefers ANTHROPIC_API_KEY over AI_INTEGRATIONS_ANTHROPIC_API_KEY when both are set", () => {
    expect(
      parseAnthropicApiKey({
        ANTHROPIC_API_KEY: "direct-key",
        AI_INTEGRATIONS_ANTHROPIC_API_KEY: "integration-key",
      }),
    ).toBe("direct-key");
  });
});

describe("parseAnthropicApiKey – missing key", () => {
  it("throws when both ANTHROPIC_API_KEY and AI_INTEGRATIONS_ANTHROPIC_API_KEY are absent", () => {
    expect(() => parseAnthropicApiKey({})).toThrow(/ANTHROPIC_API_KEY is required/);
  });

  it("throws when ANTHROPIC_API_KEY is empty and AI_INTEGRATIONS_ANTHROPIC_API_KEY is also absent", () => {
    expect(() => parseAnthropicApiKey({ ANTHROPIC_API_KEY: "" })).toThrow(/ANTHROPIC_API_KEY is required/);
  });

  it("throws when both keys are whitespace only", () => {
    expect(() =>
      parseAnthropicApiKey({ ANTHROPIC_API_KEY: "   ", AI_INTEGRATIONS_ANTHROPIC_API_KEY: "   " }),
    ).toThrow(/ANTHROPIC_API_KEY is required/);
  });

  it("falls back successfully when ANTHROPIC_API_KEY is empty but integration key is set", () => {
    expect(
      parseAnthropicApiKey({ ANTHROPIC_API_KEY: "", AI_INTEGRATIONS_ANTHROPIC_API_KEY: "integration-key" }),
    ).toBe("integration-key");
  });

  it("error message mentions the env var name", () => {
    expect(() => parseAnthropicApiKey({})).toThrow(/ANTHROPIC_API_KEY/);
  });
});

// ---------------------------------------------------------------------------
// validateStartupConfig – ANTHROPIC_API_KEY coverage
// ---------------------------------------------------------------------------

describe("validateStartupConfig – ANTHROPIC_API_KEY", () => {
  it("returns an error when ANTHROPIC_API_KEY is absent", () => {
    const errors = validateStartupConfig({});
    expect(errors.some((e) => e.startsWith("ANTHROPIC_API_KEY"))).toBe(true);
  });

  it("returns an error when ANTHROPIC_API_KEY is an empty string", () => {
    const errors = validateStartupConfig({ ANTHROPIC_API_KEY: "" });
    expect(errors.some((e) => e.startsWith("ANTHROPIC_API_KEY"))).toBe(true);
  });

  it("does not include an ANTHROPIC_API_KEY error when the key is present", () => {
    const errors = validateStartupConfig({ ANTHROPIC_API_KEY: "sk-ant-valid-key" });
    expect(errors.some((e) => e.startsWith("ANTHROPIC_API_KEY"))).toBe(false);
  });

  it("collects ANTHROPIC_API_KEY error alongside other config errors", () => {
    const errors = validateStartupConfig({ RASTERIZE_DPI: "-1" });
    expect(errors.some((e) => e.startsWith("ANTHROPIC_API_KEY"))).toBe(true);
    expect(errors.some((e) => e.includes("RASTERIZE_DPI"))).toBe(true);
  });
});
