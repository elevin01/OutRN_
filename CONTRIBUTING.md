# Working on OutRN

Two people can work here at the same time without stepping on each other: one on the **UI**, one
on the **engine and the services behind it**. They meet at a single, versioned HTTP contract.

```
 packages/web  ──HTTP──▶  packages/api  ──▶  engine · facts · ingest · identity · sources · db
   (UI owner)     ▲       (backend owner)
                  │
         packages/contracts   ← the agreement: schemas, types, fixtures (both review)
```

## Who owns what

| Path | Owner | Contains |
| --- | --- | --- |
| `packages/web` | UI | Pages, components, styling, accessibility, wording, the API client (`lib/api.ts`) |
| `packages/contracts` | **Both** | v1 request/response schemas, types, error codes, fixtures, generated JSON Schema |
| `packages/api` | Backend | HTTP server, request validation and defaults, result mapping, paging snapshots, ops routes, the mock server, the fixture generator |
| `packages/engine`, `facts`, `ingest`, `identity`, `sources`, `db`, `core`, `cli` | Backend | Feasibility, ranking, evidence, supply pipeline, schema, migrations |

`.github/CODEOWNERS` enforces this once branch protection requires code-owner review.

## The rules that keep the split working

1. **The UI talks to the backend only over HTTP, through `@outrn/contracts`.** `packages/web` may
   not depend on or import any other workspace package; `pnpm check:boundaries` fails the build
   if it does. The engine's `Evaluation`, database rows and raw source tags never reach the UI.
2. **The backend decides; the UI presents.** Eligibility, order, `ready` vs `check_first`, whether
   a claim ("hours confirmed") is justified — all backend. The UI owns layout, wording and
   formatting, but must not recompute feasibility, upgrade `check_first`, hide a `required`
   caveat, drop an age limit, or show an `estimate` as a fact.
3. **Tolerant reader.** Responses may gain fields, and open-ended codes (categories, reason and
   caveat codes, moods, error codes) may gain values at any time without a version bump. The UI
   renders unknown codes with the backend's default `text` / `label`. Closed enums (travel mode,
   item status, item kind, price kind…) only change in a breaking release.
4. **Build forms from `GET /v1/areas`.** Categories, moods, budgets and windows come from the API, so
   adding one is a backend-only change.

## Changing the contract

- **Additive** (new optional response field, new route, new optional request field, a new
  open-ended code): edit `packages/contracts/src`, run `pnpm contracts:schema`, commit
  `schema/v1.json`. Both owners review; the UI can adopt it whenever.
- **Breaking** (removing or renaming a field, making a field nullable, adding a value to a closed
  enum, a new required request field): CI's compatibility check fails. Either make it additive, or
  label the PR `contract-breaking` and ship the UI change in the same release. A large break gets a
  new route prefix (`/v2`) instead.
- **Fixtures** come from the real API: `pnpm fixtures` (needs the local database) seeds a throwaway
  database from the synthetic OSM data, runs the actual API at pinned times, and rewrites
  `packages/contracts/src/fixtures`. Regenerate when the contract changes or a scenario needs new
  data — not after every engine tweak. Scenarios are defined in `packages/api/scripts/fixtures.ts`;
  the UI owner can ask for new ones.

## Running things

| I want to… | Run | Needs |
| --- | --- | --- |
| Work on the UI | `pnpm dev:mock` → http://localhost:3000 | Node 22, pnpm 10. No database. |
| Run the whole stack | `pnpm db:start && pnpm db:migrate`, ingest (below), then `pnpm dev` | PostgreSQL 16 + PostGIS |
| Load test data | `pnpm outrn ingest osm --area les --from-file fixtures/osm/les-synthetic.json` | database |
| See exactly what the UI gets | `pnpm outrn recommend --area les --json` | database |
| Check boundaries / contract | `pnpm check:boundaries`, `pnpm --filter @outrn/contracts schema:check` | — |
| Run tests | `pnpm test` (DB tests skip without a local database) | — |

`pnpm dev` runs the API on :4000 and the web app on :3000. The web app finds the API at
`OUTRN_API_URL` (default `http://127.0.0.1:4000`); the mock listens on the same port, so the UI
cannot tell them apart.

## What CI checks on every PR

- **checks**: typecheck, import boundaries, contract schema up to date, contract backward
  compatible with the base branch (unless labelled `contract-breaking`), unit tests including every
  fixture against the schemas.
- **database**: the database-backed tests on PostgreSQL + PostGIS (a missing database fails, it
  never skips), the fixture generator, and a smoke test of the built UI against the real API.
- **web**: UI typecheck and production build with no database, and a smoke test against the mock.
