# OutRN

Feasibility-first local discovery. Someone opens it with a few hours free, sees three options that are
actually doable in that window, picks one, and leaves.

This repository is the **supply pipeline and recommendation engine** — stages 0–3 of the build plan.
The consumer web app (stage 4) sits on top of the same database and calls the same engine.

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

## Consumer web app

The Next.js app runs the recommendation engine on the server, persists each run, and includes the
three-card consumer view, place details, a Google Maps directions handoff, and an ops browser for
the full eligible-now decision set and recent recommendation runs.

```bash
# Database + production web build at http://localhost:3000
docker compose up --build web

# Or, with Node 22 and pnpm 10 installed locally
pnpm web:dev
```

Open `/ops/eligible` to evaluate candidates and inspect recent runs. Each consumer search also links
to its persisted run so the card selection can be traced without querying the database directly.

`fixtures/osm/*-synthetic.json` are **invented** — see `fixtures/README.md`. They exist so the pipeline
runs identically offline; the identity-resolution traps in them (node+way duplicate, chain branches,
museum café, closed bar, six-year-old hours) are the acceptance cases.

## Commands

| Command | What it does |
| --- | --- |
| `outrn migrate [--reset]` | Apply SQL migrations (reset drops everything; dev only) |
| `outrn ingest osm --area <slug> [--from-file p] [--save p] [--radius m]` | Overpass → raw store → identity → facts → materialize; extent = catchment + max reach |
| `outrn materialize [--area <slug>]` | Rebuild `current_facts`, publish states and verification tasks |
| `outrn recommend --area <slug> [--at iso] [--minutes n] [--back-by iso] [--budget n\|free] [--mood m] [--company c] [--categories a,b] [--wheelchair] [--offset n] [--all]` | Run the engine; `--offset` pages "More options"; `--all` prints every candidate with its class and exclusion reason (the debug view) |
| `outrn backtest --area <slug> [--grid n] [--hours ..] [--windows ..] [--budgets ..] [--days ..] [--out p]` | Coverage matrix: % of sample points × contexts with three options |
| `outrn ops queue` / `ops conflicts` / `ops health` | The two founder queues and the health strip |
| `outrn ops merge <from> <into> --reason` / `ops split <sourceEntityId> --reason` | Identity decisions, audited and reversible |
| `outrn ops override <venueId> boost\|exclude\|review --reason [--weight]` | Founder controls |
| `outrn firstparty add <venueId> <url> --reason` / `firstparty run [--force]` | Register a venue page; fetch JSON-LD → facts + occurrences |
| `outrn venues find <text> [--area]` | Venue ids by name, with current hours and their source |
| `outrn facts set <venue> <attribute> <value> --evidence "called 9/26" [--verified date] [--json]` | Record a fact you checked (published, source `founder`, trust 0.85); `<venue>` is an id or a unique name |
| `outrn facts show <venue>` | What the engine believes about a venue: value, evidence class, source, confidence, age |
| `outrn venues add --name --category --lat --lon --evidence [--hours --website --phone --area]` | Add a place OSM lacks; links to the existing venue instead if OSM has it |

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
packages/cli        the commands above
fixtures/           synthetic Overpass responses + generator
```

## Tests

```bash
pnpm test           # 59 tests: engine correctness suite, identity traps, normalization, hours, JSON-LD,
                    # and a DB integration test that ingests the fixture twice and asserts idempotence
pnpm typecheck
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

## What is deliberately not here yet

Foursquare OS Places connector (needs the export token; registered as disabled), Google Places/Routes
adapters (off by default, budget cap first), Ticketmaster (conditional), the LLM extraction rung (rung 4 of
the ladder; rungs 1–3 are JSON-LD, site parsers, and nothing), the consumer Next.js app, the post-Go
prompt endpoints, contributor reliability updates. Each has a table or a stub where it will land.

## Licensing note

OpenStreetMap data is ODbL. Facts derived from it are stored with `source_id = 'osm'` and lineage
`osm`, so the OSM-derived layer can be separated or the combined database published under ODbL —
that decision is open in the plan and must be made before production.
