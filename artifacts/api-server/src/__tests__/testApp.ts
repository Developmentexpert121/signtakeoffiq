import express, { type Express } from "express";
import jobsRouter from "../routes/jobs";
import trainingRouter from "../routes/training";
import signsRouter from "../routes/signs";
import roomsRouter from "../routes/rooms";
import sheetsRouter from "../routes/sheets";
import savedDateRangesRouter from "../routes/savedDateRanges";
import dashboardRouter from "../routes/dashboard";
import filesRouter from "../routes/files";
import exportsRouter from "../routes/exports";

/**
 * Lightweight Express app for integration tests.
 * Skips Clerk middleware so tests can run without real Clerk credentials.
 * All requests must use a guest JWT (Authorization: Bearer <token>),
 * which is validated via the DB-backed guest token path in requireAuth.
 */
export function createTestApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/api", jobsRouter);
  app.use("/api", trainingRouter);
  app.use("/api", signsRouter);
  app.use("/api", roomsRouter);
  app.use("/api", sheetsRouter);
  app.use("/api", savedDateRangesRouter);
  app.use("/api", dashboardRouter);
  app.use("/api", filesRouter);
  app.use("/api", exportsRouter);
  return app;
}
