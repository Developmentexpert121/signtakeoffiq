import { config as loadEnv } from "dotenv";
import { defineConfig } from "drizzle-kit";
import path from "path";

// drizzle-kit can't take --env-file, so load env here. This config runs with
// cwd = lib/db; load the repo-root .env first, then lib/db/.env as an override.
loadEnv({ path: path.resolve(process.cwd(), "../../.env") });
loadEnv();

const dbUrl = process.env.DO_DATABASE_URL || process.env.DATABASE_URL;
if (!dbUrl) {
  throw new Error("DO_DATABASE_URL or DATABASE_URL must be set");
}

export default defineConfig({
  // Use a relative, forward-slash path: drizzle-kit glob-matches this string,
  // and a Windows backslash absolute path (from path.join/__dirname) breaks the
  // glob (backslashes are escape chars). cwd is lib/db when push/generate run.
  schema: "./src/schema/index.ts",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
});
