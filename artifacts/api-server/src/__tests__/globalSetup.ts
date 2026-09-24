import { execSync } from "child_process";
import path from "path";

/**
 * Ensure the database schema is up-to-date before any tests run.
 * This matters in fresh environments (e.g. CI) where the DB has not yet
 * had the Drizzle schema pushed to it.
 */
export async function setup() {
  const dbConfigPath = path.resolve(
    import.meta.dirname,
    "../../../../lib/db/drizzle.config.ts",
  );

  try {
    execSync(
      `pnpm --filter @workspace/db exec drizzle-kit push --force --config ${dbConfigPath}`,
      { stdio: "inherit", cwd: path.resolve(import.meta.dirname, "../../../../") },
    );
  } catch (err) {
    console.warn("[globalSetup] drizzle-kit push failed — tests may fail if schema is stale:", err);
  }
}
