import { describe, it, expect } from "vitest";
import {
  parseMaxConcurrentPipelines,
  parseSheetBatchSize,
  parseStep2FileConcurrency,
} from "./config-parsers";

// All three S2/S3 knobs share the same positive-integer parser, so the
// behaviour table (default / valid / invalid) is identical — assert each.
const cases: Array<{
  name: string;
  parse: (env: Record<string, string | undefined>) => number;
  envVar: string;
  default: number;
}> = [
  { name: "parseMaxConcurrentPipelines", parse: parseMaxConcurrentPipelines, envVar: "MAX_CONCURRENT_PIPELINES", default: 4 },
  { name: "parseSheetBatchSize", parse: parseSheetBatchSize, envVar: "SHEET_BATCH_SIZE", default: 4 },
  { name: "parseStep2FileConcurrency", parse: parseStep2FileConcurrency, envVar: "STEP2_FILE_CONCURRENCY", default: 3 },
];

describe.each(cases)("$name", ({ parse, envVar, default: dflt }) => {
  it("returns the default when absent or empty", () => {
    expect(parse({})).toBe(dflt);
    expect(parse({ [envVar]: "" })).toBe(dflt);
  });

  it("parses a valid positive integer", () => {
    expect(parse({ [envVar]: "8" })).toBe(8);
    expect(parse({ [envVar]: " 6 " })).toBe(6);
  });

  it("throws on zero, negatives, and non-integers", () => {
    expect(() => parse({ [envVar]: "0" })).toThrow(envVar);
    expect(() => parse({ [envVar]: "-2" })).toThrow(envVar);
    expect(() => parse({ [envVar]: "2.5" })).toThrow(envVar);
    expect(() => parse({ [envVar]: "abc" })).toThrow(envVar);
  });
});
