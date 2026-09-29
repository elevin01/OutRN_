# Engine roadmap

The engine side of OutRN is the engine, the API and the supply pipeline behind them. Work ships in
batches, one reviewed PR each, highest value first. A batch never needs a UI change to land. When
it adds something the UI can use, it's an additive contract change, noted in the contracts
changelog.

## Shipped

- **Batch 1:**
  - The Bronx, Yonkers and eight Westchester downtowns, with an area lifecycle (`outrn areas …`).
  - Engine about 14× faster at area scale.
  - Requests can carry the user's location, a be-back-by time, and seen/dismissed items.
  - Sunset is wired into requests.
- **Batch 2: how much to trust each OSM fact.**
  - A mapper's survey (`check_date:opening_hours`, `check_date`, `survey:date`) dates hours and
    status. Details read "checked by an OSM mapper Mar 2026", never "confirmed".
  - `end_date` in the past closes a place. `opening_date` in the future keeps it closed until that day.
  - `opening_hours:kitchen` gives restaurants last orders.
  - `charge=*` becomes a price.
  - Bars that don't serve food are estimated "usually 21+".
  - Closure tags (`disused:*`, `was:*`, `opening_hours=off|closed`) were already handled; vacant
    shops never map to a category.
  - The fact ledger is append-only and per record. A claim is its value plus its evidence, and it
    belongs to the OSM element it came from, so a node and its building keep their own claims.
  - Ingest re-normalizes when the rules change or a date in the tags comes due.
- **Batch 3a: what the visit takes, and the plan.**
  - **What a visit takes:** sit-down, counter service, takeout, or a visit; the minimum the engine
    checks and the typical length. Takeout on request; takeout-only counters and "no takeout" places
    handled from OSM `takeaway`.
  - **Card wording:** "takes about 1h20 · until 10pm" replaces "you'd have 1h40".
  - **The plan as steps:** leave, arrive, order by or last entry, wrap up, back by.
  - **Links** to the venue's own menu, Instagram and Facebook from OSM contact tags.
  - **Public holidays:** `PH` rules resolve to New York holidays (tested). They are flagged
    approximate only on or just before one.
  - Contract 1.2 (additive): `visitStyle`, `timing.visit`, `plan`, `actions.links`.
- **Batch 3b, part 1: crowds and waits.**
  - **How busy, at the arrival:** busy-hour patterns per kind of place, by day and hour, for NYC
    and Westchester. Public holidays follow Sunday, and after midnight counts as the night before.
    Always worded as "places like this are usually busy on Friday evenings", never as a claim about
    the venue. There's no pattern where the programme is the crowd (cinema, theatre, live music).
  - **Waits:** at busy times, a table (15–30 min, unless the place takes reservations), a line to
    order (5–15 min), lanes (20–45 min, unless booked), or the door of a club.
  - **Reports first:** a visitor report of the crowd or the line replaces the pattern, as long as
    it's still valid when the user arrives.
  - **In the time math:** waiting isn't time there, so the short end of the wait lowers the fit. If
    the long end would eat the visit or run past last orders, the card is Check first
    (`WAIT_MAY_NOT_FIT`). Like every estimate, it never excludes a place.
  - Contract 1.3 (additive): `conditions` on every item. The summary shows "~15–30 min wait".
- **Batch 3b, part 2 (this PR): parking near the venue.**
  - Ingest brings in OSM `amenity=parking` (named or not) and derives the places anyone may park:
    lots, garages and street spaces, with whether they charge and their hours. Private,
    customer-only, permit and resident lots are left out, as are carports and garage boxes. The
    most specific access tag for a car decides (`motorcar`, then `motor_vehicle`, `vehicle`,
    `access`).
  - A drive plan parks at the nearest one within about 400 m that is open from parking until the
    car is collected: "Park at Orchard Street Lot (paid), then walk ~2 min". The time allowed for
    parking is at least the walk from it.
  - Place details show the nearest public parking whatever the mode.
  - Contract 1.4 (additive): `parking` on items, `parkingNearby` on place details, the `park` step.

## Next, in order

### Batch 3b, the rest: photos (no new vendors)
- **Free photos:**
  - Wikimedia Commons and Wikidata, for parks, museums and landmarks.
  - Mapillary street view, to show the entrance.
  - The preview image from the venue's own site.
- **Whose host is a link on? (next PR, part 3, with the photos.)** A menu link from OSM may be on
  any public https host today, so a vandal can make a venue's "Menu" a phishing page. Accept a menu
  only on the venue's own site's domain or a short list of menu platforms, and drop the rest.
- **Counter-service supply (needs your call).** `amenity=fast_food` isn't ingested today, so
  slices, dumplings and bagel counters never appear. Adding it brings chains too; the plan would be
  to include it with chains ranked below independents.

### Batch 4: live conditions (free keys; jobs outside the request path)
- **Weather: done** (`outrn weather refresh`, hourly). The NWS hourly forecast is stored per area.
  Over a plan's first two hours, rain likely (50%+) or cold (38°F or below) sinks outdoor options,
  and a dry, mild forecast marks them "good weather for it". A forecast over 12 hours old is ignored.
  Next: show the rain as a `conditions` kind on outdoor cards.
- **Traffic:** 511NY incidents, closures and construction, for NYC and Westchester.
- **Transit:** MTA subway, bus and Metro-North realtime delays and service alerts.
- **Events:** Ticketmaster Discovery for events with images and on-sale status, and for big games
  and concerts, which drive the crowd and traffic signals. For example, "Yankees home game: expect
  crowds and traffic" becomes a `crowd` condition on places near the stadium.
- Weather, traffic and transit arrive as more `conditions` kinds, so the UI shows them the same way.
- Each job writes to a table. A search only reads, so it still makes no external calls.

### Batch 5: photos, reviews and "must try" (paid; needs your call)
- **Fetched live only for the places being shown and the one being opened.** It has a short
  timeout, and content is cached only as long as each provider's terms allow. It never affects
  ranking, because these terms forbid storing the content.
- **Candidates:**
  - Google Places: photos, up to 5 reviews, rating, and its own AI review summary.
  - Foursquare: tips, photos, popular hours. Its terms may allow keeping data, which would let
    popularity rank; to confirm first.
  - Yelp: 3 review excerpts and photos.
  - Tripadvisor, for attractions.
- **Drive time with live traffic** from a routing API, for the cards shown.
- **Not possible:** Instagram and TikTok posts found by place (neither offers that to apps), and
  Google's "popular times" or live wait times (no API; scraping breaks their terms). Specific
  posts can be embedded by URL, curated or sent in by venues, and YouTube has an API.

### Batch 6: ranking quality
- **Time-of-day fit.** Open isn't the same as a good idea: a café at 10pm, a bar at 3pm or a museum 40 minutes before close should rank lower.
- **Window fit and worth the trip.** Long windows should allow bigger, farther places; short ones should favour close and quick.
- **Diversity within a type.** Avoid three Italian restaurants; use subtype and cuisine, not only activity type.
- **A golden scenario set per area**, like the 26 Sep case, run in CI. Ranking changes then show up as reviewable diffs rather than surprises.

### Batch 7: travel realism (needs data from outside this sandbox, once)
- **Transit from GTFS.** MTA subway, MTA buses and Metro-North give station-to-station times plus walking legs, replacing the straight-line estimate. This matters most for the Bronx, Yonkers and Metro-North towns.
- **Drive profiles.** Speed by time of day per area, then a self-hosted routing adapter (OSRM) with cached travel times.
- **Parking.** Check the new areas' parking estimates the way Bronxville's evening rule was checked.

### Batch 8: supply breadth
- **Events.** First-party JSON-LD events, library and community calendars, and cinema showtimes (the programme gap from the 26 Sep audit).
- **Foursquare OS Places** to fill OSM gaps (needs the export token).
- **`outrn ingest osm --all`**, one merged query across overlapping area extents instead of ten.

### Batch 9: learning from use
- Interaction events (go, details, dismiss) become a popularity prior and time-of-day patterns per venue.
- A post-trip "was it open? was it busy?" prompt becomes an observation, closing the verification
  loop and giving real crowd and wait data.
- **People's own reviews and photos in the app:** content we own, with moderation.

## Performance budget

- **Target:** under 300 ms engine time per request at 5,000 venues within reach.
- **Now:** the engine takes about 140 ms warm and 340 ms cold, and loading takes about 310 ms, at 3,850 candidates.
- **Next:** a set-based candidate query or a precomputed per-venue fact document to cut load time.

`pnpm --filter @outrn/engine bench <area>` measures it.

## Decisions that need the founder

1. **Bars and age** (batch 2): is "usually 21+ unless it serves food" the right default? It's in
   place now, at low confidence.
2. Check the new areas' centers on a map before launch (`outrn areas set <slug> --lat --lon`).
3. Network-bound steps have to run on your machine: `ingest osm` for each new area, then the batch 4 jobs.
4. **Batch 4 keys:** free keys for 511NY and the MTA (Metro-North); Ticketmaster.
5. **Counter-service supply** (batch 3b): ingest `amenity=fast_food`, with chains ranked below independents?
6. **Batch 5 provider and budget:** Google, Foursquare or Yelp; set their keys on the deployment.
   Also, whether live calls are acceptable when places are shown or opened.
