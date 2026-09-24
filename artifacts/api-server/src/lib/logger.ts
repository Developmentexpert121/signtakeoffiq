import pino from "pino";
import fs from "fs";
import path from "path";
import util from "node:util";
import { appendLogLine } from "./timing";

const isProduction = process.env.NODE_ENV === "production";

const baseOpts: pino.LoggerOptions = {
  level: process.env.LOG_LEVEL ?? "info",
  redact: [
    "req.headers.authorization",
    "req.headers.cookie",
    "res.headers['set-cookie']",
  ],
};

/**
 * Tee every `console.*` call into the per-job log buffer (always) and, when a
 * LOG_FILE is configured, into that file too — while preserving normal terminal
 * output.
 *
 * The pipeline writes its human-readable narrative — `[Step …]`, `[pipeline] …`,
 * `[timing] …`, `[PIPELINE SUMMARY]` — through `console.log`/`console.error`
 * (pipeline.ts aliases `const logger = console`). Those never flow through pino.
 * Patching the `console` methods captures them verbatim: `util.format(...args)`
 * reproduces exactly what the terminal shows (including `Error` stacks from
 * `console.error(msg, err)`), `appendLogLine` feeds the per-job buffer the UI
 * reads back from `jobs.metadata.pipelineLog`, and we still delegate to the
 * original method so terminal output is unchanged.
 *
 * The per-job capture must run in EVERY environment (including production): the
 * UI log viewer is DB-backed via `metadata.pipelineLog`, so it must not depend
 * on LOG_FILE or NODE_ENV. The optional file write is the only LOG_FILE-gated
 * part. HTTP-request JSON is intentionally NOT captured — pino keeps that on the
 * terminal only (see buildLogger).
 */
let _logFilePath: string | undefined;

function teeConsole(stream?: fs.WriteStream): void {
  const methods = ["log", "info", "warn", "error", "debug"] as const;
  for (const method of methods) {
    const original = console[method].bind(console);
    console[method] = (...args: unknown[]) => {
      const line = util.format(...args);
      if (stream) stream.write(line + "\n");
      appendLogLine(line);
      original(...args);
    };
  }
}

function buildLogger(): pino.Logger {
  // Capture the console narrative into the per-job buffer in ALL environments so
  // the DB-backed UI log (jobs.metadata.pipelineLog) works on demo/prod too. Only
  // the file write is opt-in via LOG_FILE.
  _logFilePath = process.env.LOG_FILE
    ? path.resolve(process.cwd(), process.env.LOG_FILE)
    : undefined;
  const fileStream = _logFilePath
    ? fs.createWriteStream(_logFilePath, { flags: "a" })
    : undefined;
  teeConsole(fileStream);

  // pino keeps request/JSON logs on the terminal: pretty in dev, plain in prod.
  if (isProduction) return pino(baseOpts);
  const prettyTransport = pino.transport({ target: "pino-pretty", options: { colorize: true } });
  return pino(baseOpts, prettyTransport);
}

/** Truncate the log file so each new pipeline run starts fresh. No-op when LOG_FILE is unset. */
export function clearLogFile(): void {
  if (_logFilePath) {
    try {
      fs.truncateSync(_logFilePath, 0);
    } catch {
      // File may not exist yet on first run — safe to ignore.
    }
  }
}

export const logger = buildLogger();
