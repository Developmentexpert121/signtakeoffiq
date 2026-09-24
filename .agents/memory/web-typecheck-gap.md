---
name: Web typecheck not caught locally vs DigitalOcean build
description: Why @workspace/web type errors slip past local checks but break the DO build, and how orval query options force queryKey at call sites.
---

# Web typecheck gap (local vs DigitalOcean)

The DigitalOcean build runs the **root** `build` = `pnpm run typecheck && pnpm -r run build`,
and root `typecheck` includes `@workspace/web` (`tsc -p tsconfig.json --noEmit`).

Locally this is easy to miss because:
- The `typecheck` **workflow** only covers db + api-server (NOT web).
- The web `build` is plain `vite build` with **no** `tsc` step.

**How to apply:** before trusting that a web change is safe for deploy, run
`pnpm --filter @workspace/web run typecheck` (or the root `typecheck`), not just the
web build or the local typecheck workflow.

## orval-generated query hooks require `queryKey` at the call site
orval v8.5.3 types a hook's `query` option as a full `UseQueryOptions` where `queryKey`
is **required**, even though the hook injects a default at runtime
(`queryOptions?.queryKey ?? getXQueryKey(...)`). So `useX(id, { query: { enabled } })`
fails typecheck with TS2741 (missing queryKey).

**Fix that is behavior-neutral:** pass `queryKey: getXQueryKey(id)` — the generated
getter returns exactly the hook's runtime default, so there is zero behavior change.
If a local const shadows the generated getter name, import it aliased
(e.g. `getListRoomsQueryKey as apiListRoomsQueryKey`).

**Why:** matching the runtime default keeps cache keys identical; inventing a new key
would split the query cache and cause stale/duplicate fetches.

## Vite config must not require runtime env at build time
A vite.config.ts that `throw`s when `PORT` / `BASE_PATH` are unset breaks the DO
production build, because DO sets neither at build time (they only exist when the
service is *served*). Mirror the web artifact's forgiving pattern: default
`PORT`→3000 and `BASE_PATH`→"/", and only throw if `PORT` is set but invalid.

**Why:** `pnpm -r --if-present run build` builds *every* package with a build
script (including mockup-sandbox), so any package's config-eval throw fails the
whole deploy build.

## DO App Platform needs a start command (Procfile)
After the build succeeds, DO fails to launch with "when there is no default process
a command is required" if there is no Procfile and no root `start` script. Fix: a
root `Procfile` with a `web:` process. The api-server is the web component — it serves
the built frontend from `artifacts/web/dist/public` (path resolved from the bundle's
own dirname, so cwd-independent), so the launch command is:
`web: node --enable-source-maps artifacts/api-server/dist/index.mjs`.

**Why:** invoking node directly (not `pnpm --filter ... start`) avoids depending on
pnpm/workspace resolution being on PATH at runtime.

## Spec drift fix pattern
The committed orval output (lib/api-client-react, lib/api-zod) is generated from
`lib/api-spec/openapi.yaml`. For DB-backed fields the web reads but the serializer may
not always emit, add them as **optional** (not in `required`) — types match with zero
runtime change. Regenerate with `pnpm --filter @workspace/api-spec run codegen`.
