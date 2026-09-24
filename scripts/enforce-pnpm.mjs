/**
 * Cross-platform preinstall guard (replaces a bash `case` one-liner that failed
 * on Windows shells). Two jobs:
 *   1. Remove stray npm/yarn lockfiles so only pnpm-lock.yaml is authoritative.
 *   2. Refuse installs run through a package manager other than pnpm.
 *
 * Uses only Node built-ins so it runs identically on Windows, macOS and Linux
 * before any dependency is installed.
 */
import { rmSync } from "node:fs";

for (const f of ["package-lock.json", "yarn.lock"]) {
  try {
    rmSync(f, { force: true });
  } catch {
    // Ignore — file may not exist.
  }
}

const ua = process.env.npm_config_user_agent ?? "";
// Empty UA happens for some tooling/CI paths — allow it; only block a known
// non-pnpm client (npm/yarn/bun).
if (ua && !ua.startsWith("pnpm/")) {
  console.error("\nThis repository uses pnpm. Install it (https://pnpm.io) and run `pnpm install`.\n");
  process.exit(1);
}
