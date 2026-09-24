import { clerkMiddleware } from "@clerk/express";
import cors from "cors";
import express, { type Express } from "express";
import expressStaticGzip from "express-static-gzip";
import { existsSync } from "fs";
import type { ServerResponse } from "http";
import path from "path";
import pinoHttp from "pino-http";
import { logger } from "./lib/logger";
import router from "./routes";
import healthRouter from "./routes/health";
import { migrateLegacyBuildingTypes } from "./routes/jobs.js";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

app.use(cors({ credentials: true, origin: true }));
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

// Clerk's middleware authenticates every request and throws "Publishable key is
// missing" when CLERK_PUBLISHABLE_KEY is absent — which 500s every /api route
// before requireAuth's DEV_BYPASS_AUTH path can run. Locally we run with
// DEV_BYPASS_AUTH=true and no Clerk keys, so only mount real Clerk when it's
// configured. Otherwise attach a signed-out auth object so any stray getAuth()
// resolves to "no user" instead of throwing. Mirrors clerkProxyMiddleware's
// no-op-when-unconfigured guard; production (keys set) behaves exactly as before.
if (process.env.CLERK_PUBLISHABLE_KEY) {
  app.use(clerkMiddleware());
} else {
  app.use((req, _res, next) => {
    (req as unknown as { auth: () => unknown }).auth = () => ({
      tokenType: "session_token",
      userId: null,
      sessionId: null,
      sessionClaims: null,
    });
    next();
  });
}

app.use(healthRouter);

app.use("/api", router);

const webDistDir = path.resolve(import.meta.dirname, "../../web/dist/public");

if (existsSync(webDistDir)) {
  app.use(
    "/assets",
    expressStaticGzip(path.join(webDistDir, "assets"), {
      enableBrotli: true,
      orderPreference: ["br", "gz"],
      serveStatic: {
        immutable: true,
        maxAge: "365d",
      },
    }),
  );

  app.use(
    expressStaticGzip(webDistDir, {
      enableBrotli: true,
      orderPreference: ["br", "gz"],
      serveStatic: {
        setHeaders(_res: ServerResponse, filePath: string) {
          if (filePath.endsWith(".html")) {
            _res.setHeader("Cache-Control", "no-cache");
          }
        },
      },
    }),
  );

  app.get("*splat", (_req, res) => {
    res.sendFile(path.join(webDistDir, "index.html"));
  });
} else {
  logger.info({ webDistDir }, "Web dist not found; skipping static file serving");
}

migrateLegacyBuildingTypes().catch((err) =>
  logger.error({ err }, "Building type migration failed"),
);

export default app;
