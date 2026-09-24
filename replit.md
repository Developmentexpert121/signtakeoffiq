# Sign Takeoff IQ

## Overview

Sign Takeoff IQ is a multi-tenant SaaS platform designed to automate the extraction of interior signage data from architectural construction PDFs. It leverages a deterministic rules engine combined with building-type-specific logic to assign appropriate sign types to extracted rooms. The platform provides an interactive floor plan viewer, an editable sign table, and a per-tenant training feedback loop with rule overrides to enhance accuracy. The core business vision is to streamline the sign scheduling process in construction, reducing manual effort and improving the precision of sign placement and compliance, thereby increasing efficiency and reducing costs for AEC firms.

## User Preferences

The user prefers an iterative development approach, with clear explanations for any significant changes or additions. They value detailed communication regarding architectural decisions and system design. Before making any major changes or implementing new features, the user expects to be consulted and to approve the proposed modifications. They also prefer a dark, Bloomberg-terminal-like aesthetic for the UI.

## Test Coverage

- API server: **1,556 tests** across 32 test files (Session 10 added +16: 11 door-analysis unit tests in `door-analysis.test.ts`, 5 POST detect-doors route tests in `sheets.test.ts`)
- Web: **148 tests** across 12 test files (Session 9 added FloorPlanTab P2b layer tests + Review tab interaction tests)

## Session 10 P2 — Review Tab Qty Inline Edit

Signs cell in Review tab is now click-to-edit: clicking the count opens a number `<Input>` (Enter/blur saves, Escape cancels). `PATCH /api/jobs/:jobId/rooms/:roomId` now accepts `qtyOverride: number` (integer ≥ 0), which bulk-sets `qty` on all non-deleted signs for that room without triggering a rules re-run. On save, `reviewDirty` state is set, lighting a `<DirtyDot>` on the Review tab trigger identical to the Plans tab pattern. Changes: `rooms.ts` (+qtyOverride field), `job-detail.tsx` (state, handler, cell, DirtyDot).

## Session 10 P3 — Per-Sign-Type XLSX Description Column + Dictionary Pricing

Takeoff sheet in XLSX export now has 13 columns (was 12). New **Description** column (col 9) is populated from `projectSignDictionary.signTypes[].description` when a project sign dictionary was extracted (stored in `job.metadata.projectSignDictionary`). **Material** column (col 10) uses `dictEntry.material` when available, falling back to `spec.materialName`. Unit price uses dictionary size (parsed from `"WxH"` string) for area-based calculation when available. Jobs without a sign dictionary fall through to existing `DEFAULT_SIGN_PRICING` behavior unchanged. Subtotal/grand total merge spans updated to 12 cols (col 13 = Extended). Change: `exports.ts` only.

## System Architecture

The project is structured as a monorepo using pnpm workspaces. The frontend is a React application built with Vite, utilizing Clerk for authentication, Wouter for routing, TanStack Query for data fetching, shadcn/ui for components, recharts for charting, react-zoom-pan-pinch for image manipulation, and uppy for file uploads. The backend is an Express 5 server with TypeScript, employing Clerk middleware for authentication and pino for logging. A Python 3.11 FastAPI service acts as a PDF sidecar for PDF processing tasks like word extraction, rasterization, and drawing index parsing. The database is PostgreSQL, managed with Drizzle ORM. The API contract is defined using OpenAPI and code-generated with Orval for type safety and client/server synchronization. Data validation is handled by Zod.

The system incorporates a 10-step processing pipeline for PDF intake, parsing, rasterization, room and sign extraction, rule application, and validation. A semantic mapper module uses building-type-aware room flag mapping for enhanced accuracy, loading lexicons from the database. The architecture supports multi-tenancy by filtering all database queries by `tenantId`. A training loop is implemented where user corrections contribute to auto-generated, tenant-specific rule overrides, improving the system's intelligence over time.

## P1 Door Analysis Feature (Session 10)

`analyzeDoors(jobId, sheetId, tenantId)` — exported from `pipeline.ts`. Feeds the sheet's rasterized PNG to Gemini 2.5 Flash with a door-detection prompt, parses the JSON response, writes `door_side`/`door_type` to each matched room, and shifts `coord_x` ±15,000 units toward the latch-side wall (clamped 0–100,000). Triggered via `POST /api/jobs/:jobId/sheets/:sheetId/detect-doors`. Button in marker popover conditionally renders when `activeSheet?.rasterizedPath` is set.

## External Dependencies

- **Auth**: Clerk (`@clerk/express`, `@clerk/react`)
- **Object Storage**: Replit Object Storage
- **AI**: Gemini 2.5 Pro for vision pipeline (room extraction, plaque, occupant loads); Gemini 2.5 Flash for door analysis. Google AI SDK via `@workspace/integrations-gemini-ai`.
- **Database**: PostgreSQL
- **ORM**: Drizzle ORM
- **PDF Processing**: `pdfplumber`, `pdf2image` (via Python FastAPI sidecar)
- **API Spec Generation**: Orval
- **UI Components**: shadcn/ui
- **Charting**: recharts
- **Image Manipulation**: react-zoom-pan-pinch
- **File Uploads**: uppy
- **Logging**: pino
