# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Netprime LMS: a serverless learning-management system that runs entirely on Cloudflare. It is a pnpm workspace with two packages:
- `backend/`: a Hono 4 API on Cloudflare Workers, using D1 (SQLite), R2, KV and Workers AI
- `frontend-admin/`: a React 18 + Vite 5 SPA served by its own Worker

The docs in `docs/` are in Thai. User-facing strings, error messages and many code comments are Thai too, so keep new ones consistent with that.

## Toolchain and commands

Node 22 and pnpm 10.33.0 (CI pins this version). Use pnpm only: `pnpm-lock.yaml` is committed, and other lockfiles are gitignored.

```sh
pnpm install --frozen-lockfile
pnpm run typecheck           # tsc for backend, frontend app, and frontend worker (frontend-admin/worker)
pnpm run check               # typecheck + every test suite + frontend build
pnpm run check:release       # check + test:readiness. CI runs this with db:init-sql:verify on every push/PR
pnpm test                    # smoke suite
pnpm run test:<suite>        # one suite, e.g. test:auth, test:payments, test:site (full list in package.json)
pnpm run db:init-sql:verify  # checks that backend/init.sql still generates from schema.sql (CI runs it)
```

Local dev (run these in two terminals):

```sh
pnpm run db:setup:local      # resets the local D1 from backend/schema.sql (includes demo accounts)
pnpm run dev:backend:local   # wrangler dev on 127.0.0.1:8787 with backend/wrangler.local.jsonc (mock secrets)
pnpm run dev:frontend:local  # Vite with VITE_API_BASE_URL forced to http://localhost:8787/api
```

The demo account credentials are in `docs/TESTING.md`. `.claude/launch.json` also has preview configs (backend on 8788, frontend on 5173).

### How tests work

There are two kinds of test, all in `tests/` and run with the Node test runner (`node --test`):
- **Pure unit tests** (`password`, `share-meta`, `notion`, `calendar`, `i18n`, `oidc`). These run straight with `node --test tests/<name>.test.mjs` and import TS sources directly, for example `frontend-admin/src/i18n/dictionary.ts`.
- **API suites** (all the others). These go through `scripts/test-local.mjs <suite>`, which:
  1. copies `backend/wrangler.local.jsonc` into a temp dir
  2. loads `backend/schema.sql` into a disposable local D1/KV/R2
  3. starts the real Worker on a random loopback port
  4. runs `tests/<suite>.test.mjs` with `NETPRIME_TEST_BASE` set
  5. deletes everything afterwards

  It strips `CLOUDFLARE_*`/`CF_*` env vars, and `tests/helpers.mjs` refuses any base URL that isn't `127.0.0.1`. You can't run an API suite with bare `node --test`. To run a single test, start a Worker yourself (`db:setup:local` + `dev:backend:local`), then run `NETPRIME_TEST_BASE=http://127.0.0.1:8787 node --test --test-name-pattern='<name>' tests/<suite>.test.mjs`. This changes your local dev DB, so run `db:setup:local` again afterwards.

A new API suite needs three changes: add it to the allow-list in `scripts/test-local.mjs`, add a `test:<name>` script, and append that script to the `check` chain in `package.json`.

Destructive deletes need an email confirmation code (`handlers/security.ts`, `utils/dangerConfirm.ts`, `X-Confirmation-Code` header). In tests, use `dangerCode()` from `tests/helpers.mjs`: the local Worker returns a `debug_code`.

## Database: schema.sql vs migrations vs init.sql

These three are easy to get wrong:
- `backend/schema.sql` is the **latest full schema plus demo seed** (starts with `DROP TABLE`, plaintext demo passwords). It is for local/test only.
- `backend/migrations/NNNN_*.sql` are for existing D1 databases (`wrangler d1 migrations apply`). For every schema change, add a **new numbered migration and also update `schema.sql`** to match. Never edit an existing migration.
- `backend/init.sql` is generated (gitignored) by `scripts/build-init-sql.mjs` for a brand-new remote DB. The script strips DROP and demo data, folds `ALTER TABLE ADD COLUMN` into `CREATE TABLE`, and marks all migrations as applied. Only the tables in its `REFERENCE_TABLES` keep their seed rows. If a new table needs startup data in production, add it there. If the script meets a statement it doesn't recognise, it stops with an error.

Never run `schema.sql` against a remote DB. A new remote DB uses `pnpm run db:init:remote`. An existing one uses `pnpm run db:backup` first, then migrations. Details are in `docs/CLOUDFLARE-DEPLOY.md`.

## Backend architecture (`backend/src`)

- `index.ts` mounts about 30 routers from `handlers/` under `/api`. **Mount order matters**: `platformRouter` comes first because its `/api/*` middleware sends queued webhooks after each response. `/api/v1` is the API-key public API (`publicapi.ts`, `middleware/apikey.ts`). CORS origins come from the `FRONTEND_ORIGINS` var (`utils/origins.ts`). The `scheduled` export runs cron jobs from `jobs.ts`.
- **Auth/RBAC** (`middleware/rbac.ts`): `rbac([roles])` checks the Bearer JWT, the KV revocation list (logged-out tokens), `users.sessions_revoked_at` against the `iat_ms` claim, and suspended status, then reloads the user from D1. One account can hold several roles (table `user_roles`). `user.role` is set to the highest role the route allows (admin > coordinator > instructor > partner > student). The primary role is `COALESCE(staff_role, role)`: coordinators are stored as `role=student, staff_role=coordinator`, so queries that list learners must filter `staff_role IS NULL`.
- **Fine-grained permissions**: `permit(...perms)` from `utils/permissions.ts` comes after `rbac()` and checks `role_permissions` (admin always passes). `/auth/login` and `/auth/me` return `permissions`, and the frontend uses them to hide tabs.
- Card payments (Omise) are disabled: those endpoints return 410. Purchases are bank transfers with slip upload and staff confirmation (`course_orders`, migration 0013). Slips go in private R2 under `slips/`.
- Self-learning lessons (`handlers/selfLearning.ts`) are uploaded HTML files that run their own scripts. They are served from the API origin (or `SELF_LEARNING_ORIGIN`), never the site's, and framed only by `FRONTEND_ORIGINS`. Lessons talk to the site through the Lesson Kit `postMessage` protocol (`docs/SELF-LEARNING-LESSON-KIT.md`).
- Email (Resend) is only logged locally. Long-running side effects go through `c.executionCtx.waitUntil`.

## Frontend architecture (`frontend-admin/`)

- There is **no router library**. The public website (`src/site/`) uses a tiny `useSyncExternalStore` router (`site/router.tsx`: `navigate`, `useLocation`). `App.tsx` either renders `PublicSite` for public paths or the logged-in console. The console is a tab switcher (`ConsoleTab`) whose nav items are shown by role or permission (`can`, `hasRole` from `hooks/useApi.ts`, plus `pages/tabPermissions.ts`). Console pages are `React.lazy` chunks to keep the main bundle small, so keep new staff pages lazy.
- `hooks/useApi.ts` is the fetch wrapper. The JWT lives in `localStorage`, and the API base comes from `VITE_API_BASE_URL`, baked in at build time (`.env.production` / `.env.staging` are committed and hold public values only).
- Public-site i18n lives in `src/i18n/dictionary.ts`. `test:i18n` requires every key to exist in both `th` and `en` with identical `{placeholders}`.
- `frontend-admin/worker/` is a small Worker in front of the static assets. It injects per-page `<meta>`/OG tags for `/blog/:slug`, `/p/:slug` and `/courses/:id`, and serves `sitemap.xml`/`robots.txt` (only those paths run worker-first, per `wrangler.jsonc`). It has its own tsconfig. `test:share-meta` covers it.
- The article editor is BlockNote, loaded lazily. There is also a PWA (`src/pwa/`, `public/sw.js`).

## Deploy

Each package has `wrangler.jsonc` with an `env.staging` block. Vars and bindings are not inherited across envs, so give each env its own full set. Deploy the backend before the frontend: `pnpm run deploy:backend[:staging]`, then `deploy:frontend[:staging]`. Apply pending D1 migrations before deploying backend code that reads new columns. The CI deploy job is written but commented out.

## Project status docs

`docs/GAP-ANALYSIS.md` lists what is still incomplete before go-live. `docs/ARCHITECTURE.md` gives the full module, table and flow overview, but parts of it predate later modules (for example, it lists 11 handlers).
