# Engine roadmap

The engine side of OutRN is the engine, the API and the supply pipeline behind them. Work ships in
batches, one reviewed PR each, highest value first. A batch never needs a UI change to land. When
it adds something the UI can use, it's an additive contract change, noted in the contracts
changelog.

## Shipped

- **Batch 1** (this PR):
  - The Bronx, Yonkers and eight Westchester downtowns, with an area lifecycle (`outrn areas …`).
  - Engine about 14× faster at area scale.
  - Requests can carry the user's location, a be-back-by time, and seen/dismissed items.
  - Sunset is wired into requests.

## Next, in order

### Batch 2: how much to trust each fact (offline, no new sources)
- **OSM survey dates.** A venue's `timestamp` changes on *any* tag edit, so a name fix makes six-year-old hours look fresh. Use `check_date:opening_hours` / `check_date` as the hours' verification date, and treat the element's edit time as an upper bound only.
- **Closure signals.** Venues tagged `disused:*`/`was:*`, with `end_date` in the past, `opening_hours=closed`, or `shop=vacant` should not be recommended.
- **Kitchen and last orders.** `opening_hours:kitchen` gives restaurants a last-order time. Late dinners stop being Ready when the kitchen closes before you arrive.
- **Admission detail.** `reservation=required|recommended`, `fee=yes|no` and `charge=*` feed admission and price, and remove "Check first" where OSM already answers the question.
- **Bars and age.** An estimated "usually 21+" for bars that don't serve food. A family sees Check first, never an exclusion. *Needs your call.*

### Batch 3: context the engine scores but never receives
- **Weather.** An NWS hourly-forecast job per area writes to a forecasts table, and each request reads the forecast for the arrival hour. The request path still makes no external calls. Rain or cold sinks outdoor options; clear evenings surface them. *The NWS fetch runs on a machine with network access.*
- **Holidays.** Check that `PH` rules resolve to New York public holidays, with explicit tests for July 4th, Thanksgiving and Christmas.

### Batch 4: ranking quality
- **Time-of-day fit.** Open isn't the same as a good idea: a café at 10pm, a bar at 3pm or a museum 40 minutes before close should rank lower.
- **Window fit and worth the trip.** Long windows should allow bigger, farther places; short ones should favour close and quick.
- **Diversity within a type.** Avoid three Italian restaurants; use subtype and cuisine, not only activity type.
- **A golden scenario set per area**, like the 26 Sep case, run in CI. Ranking changes then show up as reviewable diffs rather than surprises.

### Batch 5: travel realism (needs data from outside this sandbox, once)
- **Transit from GTFS.** MTA subway, MTA buses and Metro-North give station-to-station times plus walking legs, replacing the straight-line estimate. This matters most for the Bronx, Yonkers and Metro-North towns.
- **Drive profiles.** Speed by time of day per area, then a self-hosted routing adapter (OSRM) with cached travel times.
- **Parking.** Check the new areas' parking estimates the way Bronxville's evening rule was checked.

### Batch 6: supply breadth
- **Events.** First-party JSON-LD events, library and community calendars, and cinema showtimes (the programme gap from the 26 Sep audit).
- **Foursquare OS Places** to fill OSM gaps (needs the export token).
- **`outrn ingest osm --all`**, one merged query across overlapping area extents instead of ten.

### Batch 7: learning from use
- Interaction events (go, details, dismiss) become a popularity prior and time-of-day patterns per venue.
- A post-trip "was it open?" prompt becomes an observation, closing the verification loop.

## Performance budget

- **Target:** under 300 ms engine time per request at 5,000 venues within reach.
- **Now:** the engine takes about 140 ms warm and 340 ms cold, and loading takes about 310 ms, at 3,850 candidates.
- **Next:** a set-based candidate query or a precomputed per-venue fact document to cut load time.

`pnpm --filter @outrn/engine bench <area>` measures it.

## Decisions that need the founder

1. Bars and age (batch 2): is "usually 21+ unless it serves food" the right default?
2. Check the new areas' centers on a map before launch (`outrn areas set <slug> --lat --lon`).
3. Network-bound steps have to run on your machine: `ingest osm` for each new area, then the NWS and GTFS jobs when batches 3 and 5 land.
