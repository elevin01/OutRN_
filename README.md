# OutRN

Feasibility-first local discovery. Someone opens it with a few hours free, sees three options that are
actually doable in that window, picks one, and leaves.

This repository holds the **supply pipeline and recommendation engine** (stages 0–3 of the build plan),
the **API** that serves them, and the **consumer web app** (stage 4). The UI and the backend meet only
at a versioned HTTP contract, `@outrn/contracts`, so they can be developed independently — see
[CONTRIBUTING.md](CONTRIBUTING.md).

```
sources ──▶ raw store ──▶ identity ──▶ facts (append-only) ──▶ current_facts ──▶ engine ──▶ 3 cards
 (OSM,        source_       venues,       evidence with        best value per      feasibility,
  first-      entities,     entity_       class · source ·     attribute, with     ranking,
  party,      ingestion_    links         age · lineage        confidence          diversity,
  NWS)        runs                                                                 reasons
```

## Principles the code enforces

- **Estimates never become facts.** Every fact carries an evidence class (`published`, `observation`,
  `estimate`). A category default can downgrade a card to *Check first*; it can never exclude on its own
  and is never rendered as a claim.
- **A fetch is not a verification.** `fetched_at`, `source_updated_at` and `observed_at` are separate
  columns. Copy like "hours checked today" can only come from an event that justifies it.
- **Agreement counts once per lineage.** Three directories repeating one upstream are one source.
- **Feasibility is a gate, not a score.** Arrival, admission cutoff, useful time and return deadline
  are computed; "open now" is never an input. Last entry limits *arrival*, not the end of the visit.
- **Nothing in the request path calls an external API.** The engine reads materialized tables only.
- **Every connector is gated by `source_policies`.** Unknown permission means disabled. A source with
  open conditions (Foursquare, Google, Ticketmaster) is registered but off.
- **Fewer than three is a real answer.** The engine names the specific relaxation; it never widens a
  budget, accessibility or travel constraint silently.

## Quick start

Requirements: Node 22+, pnpm 10, PostgreSQL 16 with PostGIS (local), or a Supabase project.

```bash
pnpm install
cp .env.example .env            # set OUTRN_USER_AGENT to something that identifies you
pnpm db:start                   # throwaway local cluster on port 54329 with PostGIS
pnpm db:migrate                 # schema + policy seeds + two test areas (les, bronxville)

# Offline: run the whole slice on the synthetic fixture
pnpm outrn ingest osm --area les --from-file fixtures/osm/les-synthetic.json
pnpm outrn recommend --area les --at 2026-10-03T22:30:00Z --minutes 180 --all
pnpm outrn backtest --area les

# Online (a machine that can reach overpass-api.de): ingest the real area and save the response
pnpm outrn ingest osm --area les --save fixtures/live/les.json
pnpm outrn ingest osm --area bronxville --save fixtures/live/bronxville.json
```

The ingest extent is derived, not configured: an area's `radius_m` is its origin catchment (where
people open the app from; the backtest samples origins there), and ingest covers that plus the
farthest a trip within the mode's max travel time can reach (walk ~1.5 km; drive ~13 km at night
with the Westchester evening parking rule). `--radius <m>` overrides it. `--save` records the extent
in the capture so a replay only tombstones records inside the area it actually covers.

## Areas

| Area | Default mode | State |
| --- | --- | --- |
| Lower East Side, Bronxville | walk, drive | test (served) |
| The Bronx | transit | ingest_only |
| Yonkers, Mount Vernon, New Rochelle, Scarsdale, White Plains, Mamaroneck & Larchmont, Rye, Port Chester, Tarrytown & Sleepy Hollow | drive | ingest_only |

An area's `launch_state` decides whether the API serves it: `test`, `private_beta` and `live` are
served; `ingest_only` areas are being filled and checked; `paused` ones are withdrawn. To bring one
online (needs network access to Overpass):

```bash
pnpm outrn areas list                                   # state, catchment, derived ingest extent, supply
pnpm outrn ingest osm --area white_plains --save fixtures/live/white_plains.json
pnpm outrn backtest --area white_plains                 # how often three options exist, by context
pnpm outrn recommend --area white_plains --all          # eyeball a run (works before launch)
pnpm outrn areas launch white_plains                    # the API and the UI dropdown now include it
```

`outrn areas add <slug> --name --lat --lon [--radius m] [--mode]` adds another town;
`outrn areas set` corrects a center or catchment. The new areas' centers were placed by hand on
each downtown's main street; check them on a map before launch. Drive areas' ingest extents are
~13–15 km and overlap, so venues are shared between neighbours.

## Container quick start

Docker Compose packages Node 22, the pinned pnpm dependency tree, the CLI, and PostgreSQL 16 with
PostGIS. No host Node, pnpm, or PostgreSQL installation is needed.

```bash
# Build the application image and start the database
docker compose build app
docker compose up -d db

# Initialize the schema and use the CLI
docker compose run --rm app migrate
docker compose run --rm app ingest osm --area les --from-file fixtures/osm/les-synthetic.json
docker compose run --rm app recommend --area les --at 2026-10-03T22:30:00Z --minutes 180 --all

# Run all tests (including the PostgreSQL/PostGIS integration test) and the full offline workflow
docker compose --profile test run --rm test
docker compose --profile test run --rm e2e

# Stop services. Add -v only when you also want to delete the local database volume.
docker compose down
```

Set `OUTRN_USER_AGENT` in the shell or a local `.env` before making live source requests. Compose
uses the named `outrn_postgres-data` volume so application data survives container replacement.

## API and web app

```
packages/web  ──HTTP──▶  packages/api  ──▶  engine · facts · db
                 ▲
        packages/contracts  (v1 schemas, types, fixtures)
```

`@outrn/api` (Hono, port 4000) validates requests, runs the engine, maps results to the v1 contract
and serves "More options" from a frozen snapshot of each search. The Next.js app (port 3000) has the
three-card view, place details, a Google Maps directions handoff, and an ops browser for the full
eligible-now decision set and persisted runs; it reaches the backend only through the API.

```bash
pnpm dev:mock          # UI work: mock API over the contract fixtures + web. No database.
pnpm dev               # real API (needs DATABASE_URL) + web
docker compose up --build web                  # database + API + web at http://localhost:3000
docker compose --profile mock up --build web-mock   # mock API + web, no database
```

Open `/ops/eligible` to evaluate candidates and inspect recent runs. Each consumer search links to
its persisted run. Ops pages are for operators: set `OUTRN_OPS_TOKEN` on the API and the web app,
and sign in with any username and the token as the password (HTTP Basic). The web app checks the
visitor's credential and forwards only that credential to the API, which checks it again; it never
attaches one on a visitor's behalf. Without a token, ops are off (web 404, API 401) unless
`NODE_ENV=development`, which `pnpm dev` sets; an unset `NODE_ENV` counts as production. Use a long
random token and serve both apps over HTTPS: Basic auth sends the password with every request.

`fixtures/osm/*-synthetic.json` are **invented** — see `fixtures/README.md`. They exist so the pipeline
runs identically offline; the identity-resolution traps in them (node+way duplicate, chain branches,
museum café, closed bar, six-year-old hours) are the acceptance cases.

## Commands

| Command | What it does |
| --- | --- |
| `outrn migrate [--reset] [--reapply <file>]` | Apply SQL migrations (reset drops everything; dev only). Refuses to run if an applied migration was edited since; `--reapply` re-runs one on a database that applied an earlier draft |
| `outrn ingest osm --area <slug> [--from-file p] [--save p] [--radius m]` | Overpass → raw store → identity → facts → materialize; extent = catchment + max reach |
| `outrn materialize [--area <slug>]` | Rebuild `current_facts`, publish states and verification tasks |
| `outrn recommend --area <slug> [--at iso] [--minutes n] [--back-by iso] [--budget n\|free] [--mood m] [--company c] [--categories a,b] [--wheelchair] [--offset n] [--all] [--json]` | Run the engine through the same request resolution as the API; `--offset` pages "More options"; `--all` prints every candidate with its class and exclusion reason; `--json` prints the exact v1 response the UI receives (`--cursor c` for more pages) |
| `outrn backtest --area <slug> [--grid n] [--hours ..] [--windows ..] [--budgets ..] [--days ..] [--out p]` | Coverage matrix: % of sample points × contexts with three options |
| `outrn ops queue` / `ops conflicts` / `ops health` | The two founder queues and the health strip |
| `outrn ops merge <from> <into> --reason` / `ops split <sourceEntityId> --reason` | Identity decisions, audited and reversible |
| `outrn ops override <venueId> boost\|exclude\|review --reason [--weight]` | Founder controls |
| `outrn firstparty add <venueId> <url> --reason` / `firstparty run [--force]` | Register a venue page; fetch JSON-LD → facts + occurrences |
| `outrn venues find <text> [--area]` | Venue ids by name, with current hours and their source |
| `outrn facts set <venue> <attribute> <value> --evidence "called 9/26" [--verified date] [--json]` | Record a fact you checked (published, source `founder`, trust 0.85); `<venue>` is an id or a unique name |
| `outrn facts show <venue>` | What the engine believes about a venue: value, evidence class, source, confidence, age |
| `outrn venues add --name --category --lat --lon --evidence [--hours --website --phone --area]` | Add a place OSM lacks; links to the existing venue instead if OSM has it |
| `outrn areas list` / `add` / `set` / `launch` / `pause` | Service areas and their lifecycle (see Areas) |

## Layout

```
packages/core       controlled vocabulary, evidence classes, geo + time helpers, name keys
packages/db         pg client, migration runner, migrations/, policy loaders
packages/sources    guarded fetch (rate limit, size cap, no private hosts, no cross-host redirects),
                    Overpass connector, raw store, NWS forecast, first-party JSON-LD extractor
packages/ingest     OSM tags → category + facts; the area pipeline; first-party job
packages/identity   pairwise scoring (strong/supporting/negative evidence), resolver, merge/split
packages/facts      append-only fact writer, opening-hours evaluation, current_facts materialization
packages/engine     feasibility, four scores, diversity, reason codes → card copy, DB loader, run persistence
packages/contracts  the v1 API contract: zod schemas, types, error codes, fixtures, schema/v1.json
packages/api        HTTP boundary: validation, request resolution, result mapping, paging snapshots, ops, mock
packages/web        the Next.js UI; depends on @outrn/contracts only
packages/cli        the commands above
fixtures/           synthetic Overpass responses + generator
```

## Tests

```bash
pnpm test           # engine correctness suite, identity traps, normalization, hours, JSON-LD, the contract
                    # (every fixture against the schemas), the mock API, and DB integration tests
                    # (pipeline idempotence, loader, founder facts, the v1 API end to end)
pnpm typecheck
pnpm check:boundaries   # the UI imports only @outrn/contracts
bash scripts/smoke.sh mock   # built web app against the mock API (`real` for the real API)
```

The engine suite (`packages/engine/src/feasibility.test.ts`) is the correctness list from the plan:
open-now-but-closed-before-arrival, last entry earlier than closing, overnight intervals, DST
boundaries, cancelled occurrence, late entry unknown, strict budget with unknown price, required
accessibility with unknown data, back-by deadlines, diversity, fewer than three.

## Deploying the database to Supabase

Migrations are plain SQL and run unchanged. Set `DATABASE_URL` to the project's direct (not pooled)
connection string and run `pnpm db:migrate`. Migration `0005_rls.sql` enables RLS and creates
anonymous read policies for eligible venues, occurrences and current facts when the `anon` and
`authenticated` roles exist. Workers and the API use the service role.

Workers (ingest, materialize, firstparty run, expiry) are ordinary CLI invocations; schedule them from a
small Node process on Railway/Fly with pg-boss, or from pg_cron calling an HTTP endpoint. Never run
them inside a serverless request.

Run `ingest osm` for each served area at least daily. Dates in OSM tags take effect at local
midnight in the area's timezone. A closing date is enforced at request time from that moment, and
no visit is planned past it. The first ingest afterwards records the closed status and unpublishes
the venue. Opening dates and survey expiries lapse on their own and are re-normalized on the next
ingest, even when nothing upstream changed.

## What is deliberately not here yet

Foursquare OS Places connector (needs the export token; registered as disabled), Google Places/Routes
adapters (off by default, budget cap first), Ticketmaster (conditional), the LLM extraction rung (rung 4 of
the ladder; rungs 1–3 are JSON-LD, site parsers, and nothing), the post-Go
prompt endpoints, contributor reliability updates. Each has a table or a stub where it will land.

## Licensing note

OpenStreetMap data is ODbL. Facts derived from it are stored with `source_id = 'osm'` and lineage
`osm`, so the OSM-derived layer can be separated or the combined database published under ODbL —
that decision is open in the plan and must be made before production.
