# Running Sign Takeoff IQ locally

This app was built for Replit and deploys to DigitalOcean. These steps run it on
a local machine (Windows/macOS/Linux), configured entirely through environment
variables. File storage uses **DigitalOcean Spaces** (S3-compatible) so uploads
and the full PDF pipeline work the same locally and in production.

## Prerequisites
- **Node 22.x** and **pnpm 10+** (`corepack enable` or install pnpm).
- **Docker Desktop** (for Postgres + the PDF sidecar).
- A **DigitalOcean Spaces** bucket + access keys (or any S3-compatible store).
- An **Anthropic API key** (required to boot). A **Gemini key** is recommended
  (primary vision model). A free **Clerk** publishable key (dev bypass still
  mounts ClerkProvider).

## 1. Configure environment
```bash
cp .env.example .env                       # repo-root: backend secrets
cp artifacts/web/.env.example artifacts/web/.env.local
```
Fill in `.env`:
- `DATABASE_URL` — leave as-is to use the Docker Postgres below.
- `ANTHROPIC_API_KEY`, `AI_INTEGRATIONS_ANTHROPIC_API_KEY`,
  `AI_INTEGRATIONS_ANTHROPIC_BASE_URL` — required for the server to start.
- `STORAGE_DRIVER=s3`, `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`,
  `S3_SECRET_ACCESS_KEY`, `PRIVATE_OBJECT_DIR=/<bucket>/private`,
  `PUBLIC_OBJECT_SEARCH_PATHS=/<bucket>/public`.
- `GEMINI_API_KEY` — optional but recommended.

Fill in `artifacts/web/.env.local`:
- `VITE_CLERK_PUBLISHABLE_KEY=pk_test_...`

> **Ports:** the API reads `PORT` (3001) from `.env`. Don't export `PORT` in your
> shell, or the web dev server (default **3000**) would collide. The web proxies
> `/api` to `VITE_API_PROXY_TARGET` (default `http://localhost:3001`).

## 2. Spaces bucket: one-time CORS
The browser uploads files via a presigned `PUT` directly to Spaces, so the bucket
needs CORS allowing `PUT` (and the `Content-Type` header) from your dev origin
(`http://localhost:3000`). Set it in the DO console (Spaces → Settings → CORS) or
with `s3cmd`/`aws s3api put-bucket-cors`. Object **downloads** are streamed
through the API (`/api/storage/objects/*`), so they don't need CORS.

## 3. Start infrastructure
```bash
pnpm install           # also fetches Windows-native build binaries (rollup/oxide/etc.)
pnpm infra:up          # docker compose up -d → starts Postgres only (:5432)
```

The **PDF sidecar** is optional and lives behind a Docker Compose profile, so it
does *not* start with `pnpm infra:up`. It's only needed once you upload a PDF to
run the extraction pipeline. Start it when you want it:
```bash
pnpm infra:sidecar     # docker compose --profile sidecar up -d  (builds + runs :8008)
```
> Heads-up: building the sidecar image downloads `poppler-utils` from the Debian
> apt mirror. Some restricted networks (school/corporate wifi) block that mirror,
> which makes the build fail with "connection refused/timeout". If that happens,
> build it once on an unrestricted network (Docker caches the image) — the rest
> of the app runs fine without it in the meantime.

## 4. Initialize the database
```bash
pnpm db:push           # create the schema (drizzle-kit push)
pnpm db:seed           # default tenant, building-type profiles, lexicons, pricing
```

## 5. Run the app
```bash
pnpm dev               # api-server (:3001) + web (:3000) together
```
Then open **http://localhost:3000**. With dev bypass on you're routed straight to
`/dashboard` as the seeded `default` tenant.

Run pieces individually if you prefer: `pnpm dev:api`, `pnpm dev:web`.

## Verify it works
- `curl http://localhost:3001/healthz` → 200.
- Upload a PDF, then trigger processing. Watch the sidecar logs
  (`docker compose logs -f pdf-sidecar`) rasterize pages, confirm the object
  appears in your Spaces bucket, and watch the job advance through the pipeline
  steps in the UI.

## Storage driver notes
- `STORAGE_DRIVER` selects the backend: `s3` (DO Spaces / S3) or `gcs` (Replit).
  Implementation: `artifacts/api-server/src/lib/s3ObjectStorage.ts` +
  `objectStorage.ts`. The interface lives in `storage-types.ts`.
- For a local S3 without DO, point `S3_ENDPOINT` at MinIO and set
  `S3_FORCE_PATH_STYLE=true`.

## Troubleshooting
- **Server won't boot** — it fail-fasts on missing env (`DATABASE_URL`,
  `AI_INTEGRATIONS_ANTHROPIC_*`, `PRIVATE_OBJECT_DIR`). Read the logged list.
- **Uploads fail in the browser** — almost always Spaces CORS (step 2).
- **`Missing VITE_CLERK_PUBLISHABLE_KEY`** — set it in `artifacts/web/.env.local`.
- **DB tooling can't find the URL** — `pnpm db:push`/`db:seed` load the repo-root
  `.env`; make sure `DATABASE_URL` is set there.
- **`Cannot find module @rollup/rollup-win32-x64-msvc`** — re-run `pnpm install`;
  the workspace ships Linux-only binaries by default and install fetches the
  Windows ones.
- **`AI_INTEGRATIONS_GEMINI_BASE_URL must be set`** — should no longer block boot
  (the Gemini integration is now lazy). The app uses your `GEMINI_API_KEY` /
  Anthropic key for vision; the `AI_INTEGRATIONS_GEMINI_*` vars are only needed if
  you specifically use that Replit integration path.
