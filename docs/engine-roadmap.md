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
- **Batch 2 (this PR): how much to trust each OSM fact.**
  - A mapper's survey (`check_date:opening_hours`, `check_date`, `survey:date`) dates hours and
    status. Details read "checked by an OSM mapper Mar 2026", never "confirmed".
  - `end_date` in the past closes a place. `opening_date` in the future keeps it closed until that day.
  - `opening_hours:kitchen` gives restaurants last orders.
  - `charge=*` becomes a price.
  - Bars that don't serve food are estimated "usually 21+".
  - Closure tags (`disused:*`, `was:*`, `opening_hours=off|closed`) were already handled; vacant
    shops never map to a category.

## Next, in order

### Batch 3: what the visit takes, and the plan (no new vendors)
- **Time an experience takes**, by how it's done:
  - The engine already enforces a minimum per category (restaurant 60 min, café 30, bar 45,
    museum 80), but never shows it and doesn't know dine-in from takeout.
  - Derive sit-down, counter-service and takeout visits from OSM (`amenity=fast_food`,
    `takeaway=only|yes`, cuisine), time of day and party. An optional request field lets the user
    say "dine in" or "takeout".
- **Card wording.** "Takes about 1h15 · open till 10" replaces "you'd have 1h40". The user's time
  stays theirs; the minimum only decides what fits.
- **The plan as steps:** leave at, arrive, order by or last entry, head back by.
- **Crowd and wait estimates**, labelled as estimates:
  - Busy-hour patterns per category and day, plus reservation policy.
  - Big nearby events, for example "Yankees home game: expect crowds and traffic".
- **Parking near the venue:** nearest OSM lot or garage, its fee, and the walk from it.
- **Free photos:**
  - Wikimedia Commons and Wikidata, for parks, museums and landmarks.
  - Mapillary street view, to show the entrance.
  - The preview image from the venue's own site.
- **Links** to the venue's own Instagram, Facebook and menu, often already tagged in OSM.
- **Holidays.** Check that `PH` rules resolve to New York public holidays, with tests for July
  4th, Thanksgiving and Christmas.
- Contract 1.2 (additive): `visit`, `plan`, `media`, `links`.

- **Per-record OSM claims.** Key OSM facts by the element they came from. A venue mapped as both
  a node and a building then keeps each record's claims side by side; today they share one row,
  and the last record processed decides its evidence.

### Batch 4: live conditions (free keys; jobs outside the request path)
- **Weather:** an NWS hourly forecast per area. Rain or cold sinks outdoor options; clear evenings
  surface them.
- **Traffic:** 511NY incidents, closures and construction, for NYC and Westchester.
- **Transit:** MTA subway, bus and Metro-North realtime delays and service alerts.
- **Events:** Ticketmaster Discovery for events with images and on-sale status, and for big games
  and concerts, which drive the crowd and traffic signals.
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
5. **Batch 5 provider and budget:** Google, Foursquare or Yelp; set their keys on the deployment.
   Also, whether live calls are acceptable when places are shown or opened.
