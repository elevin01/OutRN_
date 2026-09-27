# @outrn/api — the backend's HTTP boundary

Validates requests, resolves defaults, runs the engine, maps results to
[`@outrn/contracts`](../contracts/README.md), and serves paging from frozen snapshots. Every
response is checked against its contract schema before it is sent, so a backend change that would
break the UI fails here with a clear error instead of in the browser.

```
src/service/context.ts          request → engine context (one place: API, ops and CLI all use it)
src/service/recommendations.ts  search (engine run + snapshot) and page (slice of the snapshot); cursors
src/service/places.ts           place details with provenance
src/service/ops.ts              operator views
src/map/                        engine Evaluation / facts → contract types
src/http/app.ts                 Hono routes, ops auth, error mapping
src/mock/app.ts                 the same routes answered from the fixtures (no database)
scripts/fixtures.ts             regenerates the contract fixtures from the real API
```

## Run

```bash
pnpm api:dev     # watch mode, :4000, needs DATABASE_URL
pnpm api:start   # same, no watch
pnpm api:mock    # the mock, no database
```

| Env | Default | |
| --- | --- | --- |
| `DATABASE_URL` | — | Postgres with the OutRN schema |
| `PORT` / `HOST` | `4000` / `127.0.0.1` | |
| `OUTRN_OPS_TOKEN` | unset | Bearer token for `/ops/v1/*`. Unset: disabled (401), except under `NODE_ENV=development` (`pnpm dev`) where they are open. An unset `NODE_ENV` is not development |
| `OUTRN_WEB_ORIGINS` | `http://localhost:3000,…` | Browser origins allowed to call `/v1/*` directly (CORS) |

## Paging snapshots

A new search runs the engine once, maps its whole display order (up to the engine's page limit)
to contract items, and stores them in `recommendation_snapshots` (migration 0009). Pages are
slices of that list: consistent across "More options", and no engine run per page. Snapshots
expire after `SNAPSHOT_TTL_MINUTES` (20) and are deleted a day later.
