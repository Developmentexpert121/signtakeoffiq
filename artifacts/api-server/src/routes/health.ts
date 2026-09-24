import { Router, type IRouter } from "express";
import { validateStartupConfig } from "../lib/config-parsers";
import { pool } from "@workspace/db";

const router: IRouter = Router();

const DB_PING_TIMEOUT_MS = 2000;

type DbResult =
  | { connected: true }
  | { connected: false; error: string };

async function pingDatabase(): Promise<DbResult> {
  try {
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error("DB ping timed out after 2s")),
        DB_PING_TIMEOUT_MS,
      ),
    );
    await Promise.race([pool.query("SELECT 1"), timeoutPromise]);
    return { connected: true };
  } catch (err) {
    return {
      connected: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

router.get("/healthz", async (_req, res) => {
  const errors = validateStartupConfig(
    process.env as Record<string, string | undefined>,
  );
  const dbResult = await pingDatabase();

  const configValid = errors.length === 0;
  const dbConnected = dbResult.connected;

  if (configValid && dbConnected) {
    res.status(200).json({
      status: "ok",
      config: { valid: true },
      db: { connected: true },
    });
  } else {
    res.status(503).json({
      status: "error",
      config: configValid ? { valid: true } : { valid: false, errors },
      db: dbResult,
    });
  }
});

export default router;
