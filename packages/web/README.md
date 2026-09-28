# @outrn/web — the OutRN UI

Next.js 16 (App Router, server components). This package talks to the backend **only** through the
v1 HTTP API described in [`@outrn/contracts`](../contracts/README.md). You can build and test every
screen without a database, an engine, or any credentials.

## Start in two minutes

```bash
# Node 22+ and pnpm 10 (corepack enable)
pnpm install
pnpm dev:mock          # mock API on :4000 + this app on :3000
```

Open http://localhost:3000. The mock serves real responses captured from the actual API. Every
state a screen has to handle is one **Neighborhood** choice away:

| Neighborhood | What you get |
| --- | --- |
| Lower East Side | Walking, 3 hours: three Ready cards, four pages via "More options" |
| Bronxville | Driving (the area default); travel includes parking; four pages |
| Mock · bars, date night | Bars; Clinton Bar has **hours confirmed**; open Hester Bar's details for a stale check (**due for recheck**) and **sources disagree** |
| Mock · family, age limits | Bars at 1am with a child: each is **Check first**, "usually 21+" (an estimate, never an exclusion) |
| Mock · a scheduled event | A theatre performance: `kind: "event"` with start/end times |
| Mock · fewer than three | Two options and `insufficient` with relaxations |
| Mock · nothing fits | Zero items |
| Mock · expired pages | Page 1 works; "More options" returns `CURSOR_EXPIRED` (the app re-runs the search) |
| Mock · service unavailable | The search fails with a retryable `UNAVAILABLE` |

Place details work for every card. `/ops/eligible` and `/ops/runs/:id` work too (open in
`next dev`; a production build asks for the operator password, see below).

## Where things are

```
app/page.tsx              search form + results (cards, paging, "we won't pad the answer")
app/places/[id]/page.tsx  place details: facts with provenance, directions, contact
app/ops/…                 operator views (all candidates, scores, persisted runs)
components/               PlaceCard, SearchForm, ApiProblem
lib/api.ts                the API client: fetch + validate every response against the contract
lib/request.ts            search form (URL query) ⇄ API request
```

## What the data means (read before redesigning a card)

Each `RecommendationItem` carries both **structured fields** and the backend's **default copy**
(`item.copy.summary / sentence / caveat / action`). Rendering `copy` verbatim reproduces today's
cards; the structured fields let you design your own:

- `status`: `ready` or `check_first`. Never recompute or upgrade it.
- `caveats[]`: every one has `required: true` and explains a `check_first`. Keep them visible.
- `reasons[]`: why it's a good option, strongest first. Optional to show.
- `ageLimit`: always show when present. `evidence: "estimate"` reads "usually 21+", never "21+".
- `price`: `free` / `paid` (cents, may be null = amount unknown) / `unknown`. Estimates say so.
- `timing.travel.isEstimate`: travel times are estimates today; show "~12 min".
- Codes (`reasons[].code`, `caveats[].code`, `category.id`…) are open-ended: style the ones you
  know; for any other, fall back to the `text` / `label` the API sends.
- Times are ISO instants; format them in the area's `timezone` (`response.area.timezone`).
- Place facts (`/v1/places/:id`) are open-ended rows with their own `label`, like `kitchen_hours`
  ("Kitchen") for restaurants that publish it. `provenance.freshness` may read "checked by an OSM
  mapper Mar 2026". That is a volunteer's survey, not a confirmation; only `verifiedAt` is one.

Paging: "More options" and "Previous" just send `{ cursor }`. Every page of a search is a slice of
one frozen list (`requestId`), so nothing reshuffles. Pages expire after 20 minutes
(`expiresAt`); the API then answers `CURSOR_EXPIRED` with `restart`, which the home page turns into
a fresh search.

## Available from the API, not used by the screens yet

Contract 1.1 accepts these on a search. Each is optional, so adopt them when the design is ready:

- `origin`: the device's location (for example, from `navigator.geolocation`). Travel is then
  planned from where the user is instead of the neighborhood's center, which matters most in big
  areas like the Bronx and Yonkers. The API rounds it to about 100 m and rejects a point outside
  the chosen area. **Keep it out of URLs:** query strings end up in server logs and browser
  history. Send it only in the search request body (from a server action or a POST handler), or
  round it to 3 decimals in the browser before it goes anywhere.
- `backBy`: "be home by 11". The return trip counts against the plan.
- `seenIds` / `dismissedIds`: item ids (UUIDs) this device already showed (ranked lower) or the
  user dismissed (never shown). Keep them in local storage; send up to 200 of each. The API
  stores only how many were sent, never the ids.
- `visitStyle: "takeout"` (1.2): a "grab food to go" toggle. Food places become a ~15-minute stop,
  and places that don't do takeout drop out.

Contract 1.2 also adds, on every item:

- `timing.visit`: how the visit is done (`label`, e.g. "Sit-down meal") and what it takes. Show
  `typicalMinutes` as "takes about 1h20". It's not a limit on how long the user stays.
- `plan`: the card's timed steps ("Leave at 7pm", "Arrive around 7:13pm", "Order by 9:45pm",
  "Wrap up by 11pm, when it closes"). Show `isEstimate` times as "~7:13pm".
- `actions.links` (and `actions.links` on place details): the place's own Menu, Instagram and
  Facebook pages, always https.

The default `copy.summary` now reads "takes about 1h20 · until 10pm" instead of "you'd have 1h40".

## Rules

- Import only `@outrn/contracts` from the workspace. Engine, db, api and ingestion packages are
  off-limits (`pnpm check:boundaries` fails CI otherwise), and so is reaching into another package
  by relative path. Add npm packages freely.
- Need something the API doesn't give you? Ask for a contract change (see
  [CONTRIBUTING.md](../../CONTRIBUTING.md)): additive changes are quick; the backend owner adds the
  field and regenerates the fixtures.

## Against the real backend

```bash
pnpm db:start && pnpm db:migrate
pnpm outrn ingest osm --area les --from-file fixtures/osm/les-synthetic.json
pnpm dev               # real API on :4000 + this app on :3000
```

Environment: `OUTRN_API_URL` (default `http://127.0.0.1:4000`), and `OUTRN_OPS_TOKEN`, the password
operators sign in with on `/ops/*` (HTTP Basic, any username). `proxy.ts` challenges anyone
without it, each ops page re-checks with `requireOps()` (`lib/ops.ts`), and `api.ops.*` only
forwards the credential the visitor presented. Without a token, `next dev` serves ops pages openly
and a production build serves none.

## Checks

```bash
pnpm --filter @outrn/web typecheck
pnpm web:build
pnpm check:boundaries
bash scripts/smoke.sh mock     # builds must exist: runs the built app against the mock
```
