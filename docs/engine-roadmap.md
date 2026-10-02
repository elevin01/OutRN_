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
- **Batch 3b, part 2: parking near the venue.**
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
- **Batch 3b, part 3 (this PR): free photos of the place itself.**
  - `outrn ingest photos` takes the Commons files a venue's OSM records name (`wikimedia_commons`,
    or an `image` link to Commons), then its Wikidata item's image (P18). It keeps only photos
    (not maps, drawings or logos) that are freely licensed (public domain, CC0, CC BY, CC BY-SA)
    and credited as their license requires, up to 3 per venue. A file must have been on Commons, as
    it is now, for 30 days, and not be tagged for deletion: a vandal's fresh upload waits for
    Commons' patrollers.
  - Nothing is guessed: no search by name, no stock photo.
  - Live runs record every response (`--save`) and replay exactly (`--from-file`), like `ingest osm`.
  - Contract 1.5 (additive): `photos` on items and place details, each with its credit.
  - **Menu links:** only on the venue's own site or on a known menu or ordering platform. Anyone
    can edit `website:menu`, so a menu anywhere else is dropped at ingest (a normalizer bump
    re-checks stored ones) and again when links are shown.
    - The own site is the website's host or a subdomain of it. When the website is a page on a host
      shared by path (a Facebook page, a Google Site, a Linktree), only pages under that path count.
    - Platforms are ones where a page exists only for a signed-up merchant. Free site builders
      (Square Online) are not platforms: a menu there counts only when it is the venue's website.

## Next, in order

### Batch 10: taste first, and what's happening (the product's center)
The engine started as "what's open near me". It becomes "what should I do tonight": first what is
only happening now (a band in the park, fireworks, a street fair, a pop-up market), then ranked by
the person's taste, with places as the fallback and the "grab a bite after" stop.
- **Part 1 (this PR): taste ranks** (contract 1.8, additive).
  - **Interests:** sixteen, in the words people pick: live music, comedy, theatre & dance, movies,
    art, museums & history, restaurants, cafés & sweets, bars & drinks, nightlife, parks & outdoors,
    games & activities, markets & shopping, books & talks, sports, festivals & fairs
    (`core/interests.ts`).
    - Every place maps onto them by its category, or its subtype when that says more (a climbing gym
      is sports).
    - An event maps by what its title says ("Jazz on the Lawn" is live music), with the place it is
      held at counting for half.
  - **A taste** is a profile kept on the device and sent with each search: weights from -1 (skip) to
    1 (love). With a taste or a mood, the match is the largest part of an option's merit (0.4, then
    appeal 0.3, fit 0.2, novelty 0.1). Without either, ranking is exactly as before: the 23 earlier
    golden scenarios are unchanged.
    - A skip sinks an option, and variety never brings it back.
    - Variety is among the kinds of thing the person likes first.
    - A love (0.7 or more) is never left off the first page: when none of it is a love, the best love
      takes its last slot, keeping its class and caveats.
    - A love doesn't lift a poor idea for the hour (a park after dark).
    - The card says why: "matches your taste for live music".
  - **A mood is a like for one search** (culture: art, museums, theatre, movies, live music, comedy,
    at 0.6). Before, it moved a place about as much as a few minutes' walk; it never overrides a skip.
  - **Events are pushed harder:** an event's appeal boost is 0.25 (was 0.15), plus 0.05 when it
    starts within 90 minutes. Events and places compete on one list (the founder's choice: mixed by
    score, not a separate lane).
  - **Privacy:** runs keep how many interests a taste weighed, never which, and no option's match.
  - Golden scenarios added: a music lover on a Saturday evening, an art lover who skips bars, a Friday
    in the mood for culture, a Bronxville outdoors lover.
  - Seen on the captures: with no events loaded, the music lover's love is a music venue to "check
    what's on" in slot 3. Bronxville's parks list no hours, so they are Check first, and the outdoors
    lover sees one park on the first page. Both are data, not ranking: see parts 3 and 4.
  - `outrn recommend --like live_music,art:0.5 --skip drinks` runs a search with a taste.
- **Part 2: the apps.** Quick picks of interests on first open, then Go, Save and Dismiss sharpen the
  taste on the device; it goes with every search. Nothing about the person is kept on the server.
- **Part 3: pop-ups without a venue.** Fireworks over the river, a street fair, a parade: events with
  their own place and kind, from any source, mapped to interests.
- **Part 4: every free event source** (needs network access and two free keys; see the decisions
  below): NYC Parks events and NYC Open Data (concerts, outdoor movies, fireworks, street fairs),
  library calendars (NYPL, Westchester), venues' own sites (the first-party job), Ticketmaster and
  SeatGeek, and more.
- **Small follow-ups seen while testing:** "open late" is said of any place that closes an hour
  after the window ends, so a gallery closing at 6pm is "open late" at 2pm; it should mean late in the
  evening.

### Batch 3b, the rest (no new vendors)
- **More free photos:**
  - Commons categories a venue names (`wikimedia_commons=Category:…`), for more than one photo.
  - Mapillary street view, to show the entrance (needs a free token).
  - The preview image from the venue's own site (`og:image`, with the site's permission).
- **Counter-service supply (needs your call).** `amenity=fast_food` isn't ingested today, so
  slices, dumplings and bagel counters never appear. Adding it brings chains too; the plan would be
  to include it with chains ranked below independents.

### Batch 4: live conditions (free keys; jobs outside the request path)
- **Weather: done** (`outrn weather refresh`, hourly). The NWS hourly forecast is stored per area.
  Over a plan's first two hours, rain likely (50%+) or cold (38°F or below) sinks outdoor options,
  and a dry, mild forecast marks them "good weather for it". A forecast over 12 hours old is ignored.
- **Weather on the card: done.** Outdoor places (and outdoor events) carry a `weather` condition
  from the forecast: rain, cold, hot (90°F or more) or fair, with the hours it covers.
  - Rain likely is a caveat, so the place is Check first ("70% chance of rain between 2 and 4pm").
    It is never an exclusion.
  - Cold or heat goes on the fact line ("down to 34°F", "up to 93°F").
  - Heat is not "good weather for it".
  - Indoors, nothing is shown.
  - No contract change: condition kinds and caveat codes are open-ended.
  - Next, in the UIs: render `conditions` (crowd, wait and weather). Neither app shows them yet;
    today the rain reaches users through the caveat, and cold or heat through the fact line.
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
- **Part 1 (this PR): relevant results on real places.**
  - **Golden scenarios:** fifteen fixed searches over the real LES and Bronxville captures, with
    each ranking's top six pinned in `fixtures/golden/scenarios.json` and checked in CI.
    `pnpm golden` accepts an intended change as a reviewable diff. Places equal on merit are
    ordered by evidence, then distance, then name, so the same search always gives the same order.
  - **Time-of-day fit:** each kind of place has prime, fair and off hours. Parks and gardens are
    fair in the last 45 minutes before sunset and off after it. Off hours sink a place in ranking,
    and variety no longer promotes it. Examples: a park after dark, a bar at 10am or 3pm, a café at
    9pm. Prime hours lift it a little. It never excludes.
  - **Who can go:** `access=private` (and no, members, permit) and a university or school's own
    library are members only, and never an option.
  - **Free when it is:** a public library and a commercial art gallery are estimated free, and a
    gallery walk-in, so "free" and weekend afternoons include them.
  - **Children:** a bar that serves food and names no age limit is shown to families, flagged
    ("check children are welcome") and ranked below family places.
  - **Nothing listed:** a cinema, theatre or music venue with no events loaded but its own website
    is a Check-first "check what's on" in its time of day (evenings, weekend matinees). Without a
    site, or in the morning, it is still not an option.
  - **Travel against the window:** a walk counts against the time the user has, so a 15-minute
    walk weighs more in an hour than in an evening.
- **Part 2: variety and worth the trip.**
  - **Cuisine** is stored from OSM (`cuisine=italian;pizza`) for restaurants, cafés, dessert places
    and bars, shown on the details page ("Cuisine: Italian, pizza"), and settable by the founder.
  - **Variety within a type.** After one of each activity, each next slot goes to the best place
    once a repeat of the last three shown is paid for: 0.03 of merit per same category, 0.05 per
    same cuisine group (Italian and pizza are one; sushi and ramen are one) or activity subtype.
    A near-tie goes to the different place; a clearly better one keeps its slot. Class still comes
    first, and a category chip still gets only that category, with its cuisines varied.
  - **Worth the trip.** From 90 minutes, and fully from four hours, half the travel score is the
    share of the outing spent getting there and back. The same walk costs a two-hour museum less
    than a café, and a café less than an ice cream. Up to 90 minutes, ranking is unchanged.
  - Golden scenarios added: dinner with only restaurants, and a five-hour Saturday.
- **Part 3: cuisine on the card and in the search** (contract 1.6).
  - **On the card:** items list what a food place serves (`cuisines`, up to 3), and the summary
    leads with it: "Thai · ~12 min walk · …". A café's coffee isn't repeated.
  - **From the name** when no mapper gave a cuisine ("Arturo's Coal Oven Pizza", "Taqueria Diana",
    "Great Szechuan"), as an estimate. Whole words that name a cuisine or a dish nothing else is,
    never ones names use for anything ("kitchen", "fish"). This covers OSM food places without a tag
    and Overture's new places, which have none. On the LES and Bronxville captures, all 27 read
    from OSM names are right; 766 of the LES Overture capture's 4,495 food places have one.
  - **In the search:** `cuisines` (up to 5 of 24: Japanese, pizza, Mexican, Thai…). Only food
    places serving one are options.
    - A cuisine takes in its kinds: Japanese finds sushi and ramen, and Italian finds pizzerias.
      Sushi finds only sushi.
    - An unknown cuisine is not a match.
    - It narrows the request like a category chip does (no activity diversity), and each card
      leads with the cuisine asked for.
    - When few match, it offers "try any cuisine" (`any_cuisine`), not other kinds of place.
  - Golden scenarios added: Japanese on a Friday evening, and pizza on a Saturday afternoon.
- **Part 4: what a place offers at the hour.** No contract change: reason codes are open-ended.
  - **Happy hour** from OSM `happy_hours` (opening-hours syntax; 58 places on the LES and
    Bronxville captures). When it's on at the arrival with at least 20 minutes left, or starts
    within 30 minutes of it, the card says so ("happy hour until 7pm", "happy hour from 5pm";
    `HAPPY_HOUR`, params `from`, `until`) and appeal rises 0.05.
    - Never for a party with a minor.
    - Never for a happy hour that never ends.
    - Place details show it with today's times ("On now until 7pm").
  - **Tables outside** from OSM `outdoor_seating` (any kind: sidewalk, garden, roof; 219 places yes,
    62 no). When the forecast is dry (rain under 30%), 55°F or warmer and not hot, the card says
    "good weather to sit outside" (`OUTDOOR_SEATING`) and appeal rises 0.05.
  - Neither ever excludes a place or changes its class: an offer breaks a near-tie.
  - Golden: three places move up for their happy hour. Ten Bells is #2 on Saturday at 6:30pm.
    Superbueno (Tuesday) and Botantica Bar (Saturday) open straight into theirs at 4pm.
- **Part 5: diets and must-haves in the search** (contract 1.7).
  - **Diets** from OSM `diet:*` (vegetarian 66, vegan 58, gluten-free 18, kosher 10 and halal 9 places
    on the LES capture), or, only when it has no `diet:*` tags at all, the name ("Jisu Vegetarian",
    "East Side Glatt"), as an estimate. A place known only by its name is Check first
    (`DIET_FROM_NAME`) and never labelled: kosher, halal and gluten-free are needs, and a name is
    not a record ("kosher-style" delis are not kosher). A search for diets keeps food places known to serve all of them (`yes` or `only`; a
    vegan place serves vegetarians). A diet is a need, so it is never relaxed.
  - **Must-haves:** tables outside (`outdoor_seating`), wifi (`internet_access=wlan`: 50 LES places,
    libraries included; `yes` is internet of an unknown kind and doesn't count) and step-free access
    (`wheelchair`). Unknown is no. Going
    without tables outside or wifi is offered as a relaxation; step-free access never is.
  - Cards list `diets` and `features`; place details read "Vegan; gluten-free options" and
    "Internet: Wi-Fi".
  - Golden scenarios added: a vegetarian Sunday lunch (74 options) and a Tuesday morning with wifi
    (37: cafés, restaurants, two public libraries).
- **Part 6: restrooms and what a place has for children.** No contract change: reason
  and caveat codes are open-ended.
  - **Facts** from OSM, where mappers tag them:
    - `restroom` from `toilets`, `toilets:access` and `toilets:wheelchair` (`designated` is
      accessible). On the LES capture, 95 places say whether they have one, and 37 say whether it
      is step-free (20 yes, 17 no).
    - `kid_facilities` from `highchair`, `changing_table` and `kids_area`, as OSM documents them
      (only a handful so far). "Limited" is kept, not dropped: somewhere to change a diaper that
      isn't a table, a limited kids' area. `kids_area=designated` and `kids_area:indoor|outdoor=yes`
      count; the documented mistake `kids_area=indoor|outdoor` counts only when nothing else says.
  - **Who it matters to decides what the card says:**
    - **A wheelchair user** (`features: ["wheelchair"]`): an inaccessible restroom is Check first
      ("its restroom isn't wheelchair accessible", `RESTROOM_NOT_ACCESSIBLE`; limited access is
      `RESTROOM_ACCESS_LIMITED`), never an exclusion. An accessible one is a reason ("an accessible
      restroom") and lifts appeal 0.05.
    - **Children:** high chairs when the youngest is under 5, a changing table under 3, a kids' area
      under 12, all of them for a family whose ages we don't know (`HIGH_CHAIRS`, `CHANGING_TABLE`,
      `KIDS_AREA`, param `level`). A limited one reads as what it is ("somewhere to change a
      diaper", "a limited kids' area"). One lift of 0.05 however many. No restroom sinks a place 0.05 when the youngest
      is under 10, with nothing on the card: it is on the place's details.
  - Place details read "Restroom: Yes, not wheelchair accessible" and "For kids: High chairs; no
    changing table".
  - Golden scenarios added: a step-free Friday dinner (Ms. Yoo moves from #3 to #1 for its accessible
    restroom) and a Sunday lunch with a 2-year-old (Van Leeuwen, with no restroom, moves from #2 to #7).
  - **Next:** public restrooms in parks. OSM maps them as their own points (`amenity=toilets`),
    which the captures don't fetch yet; a park with one nearby would be worth saying to a family.
- **Part 7 (this PR): a community centre's time of day.** A relevance audit (364 searches over both
  captures, every day of the week, 8am to 1am) found Tuckahoe Community Center (no hours, no site)
  at #2 to #5 in Bronxville every night at 10pm and 1am. `community` had no time-of-day rule, so it
  never took the off-hours sink a gallery or patisserie takes.
  - `community` now has one: prime 9am to 9pm, off otherwise. Ranking only, like every day-part
    rule: `amenity=community_centre` also covers drop-in centres (social support, youth and family,
    public information), so published hours still decide whether one is open, and a centre with a
    listed event keeps its own row. Tuckahoe now ranks #12 at 1am and about #40 at 10pm.
  - Golden: unchanged.
- **Still to do:**
  - **Bigger places need evidence to lead.** In a long LES afternoon, the museums (Tenement Museum,
    Museum of Chinese in America) are all Check first (tours, unlisted hours), so they never
    outrank a Ready place. Founder checks or the museums' own sites would let them lead.
  - In the apps: cuisine chips beside the category shortcuts, and `cuisines` on the card.
  - Add golden scenarios for the new areas once their real data is ingested.

### Batch 7: travel realism (needs data from outside this sandbox, once)
- **Transit from GTFS.** MTA subway, MTA buses and Metro-North give station-to-station times plus walking legs, replacing the straight-line estimate. This matters most for the Bronx, Yonkers and Metro-North towns.
- **Drive profiles.** Speed by time of day per area, then a self-hosted routing adapter (OSRM) with cached travel times.
- **Parking.** Check the new areas' parking estimates the way Bronxville's evening rule was checked.

### Batch 8: supply breadth
- **Events.** First-party JSON-LD events, library and community calendars, and cinema showtimes (the programme gap from the 26 Sep audit).
- **Overture Maps places: done for existing venues** (`outrn ingest overture`). It gives whether a place still
  operates, signal-backed closures, and websites and phones OSM lacks. Only CDLA-Permissive-2.0 and CC0-1.0
  records are kept: Foursquare's (Apache-2.0) are left out until its NOTICE ships with the data and the
  API's developer documentation, so Overture does not stand in for Foursquare OS Places.
- **Overture places OSM lacks: done** (the same command; `--no-new-places` turns it off).
  - **What is added:** only a place that is open, confidently recorded (0.8+), updated in the last
    two years, and not from a company register alone. Its kind must change faster than mappers keep
    up: restaurants, cafés, bars, galleries, music venues, clubs, arcades, farmers markets. Not fast
    food (the founder's call), and not parks, museums or libraries: OSM maps them well, and
    Overture's extras of those kinds were mostly not places to visit.
  - **The name** must be a real one: not generic words, an address, a street, a company, a shop, or
    mostly another script (records misplaced from abroad). It is not a chain's (a built-in list plus
    every brand OSM tags).
  - **A way to check first:** a phone number, or a website of its own.
  - **Duplicates:** anything close is left out rather than risk two cards for one place:
    - a venue with its name within 500 m;
    - one sharing a distinctive word within 100 m ("Hunan 3" beside "Hunan III");
    - one of its family (food, drink, art) within 10 m, most likely the storefront's earlier or
      later tenant ("Milk & Honey" where Attaboy is now);
    - anything identity resolution would flag for review.
  - **The kind:** from Overture's category, or from the name when Overture only says "restaurant"
    (ice cream or cheesecake is dessert, a bakery a café).
  - **What it knows:** name, kind, status, website and phone, and the estimates any venue of its
    kind gets. It has no hours, so it is always Check first.
  - **Lifecycle:** it loses its claims, and stops being shown, when a later read no longer supports
    it. A venue OSM later maps at the same spot joins it rather than duplicating it. A venue no
    source speaks for any more (OSM deleted it, Overture dropped it) is no longer shown.
  - **Scope:** a live read covers the area's venues from other sources (OSM, a founder) and a
    margin. Venues made from Overture's places never widen it, so the reads don't creep outward
    run after run.
  - **Scale, on the captures:**
    - LES: +1,130. Left out: 526 as possible duplicates, 125 chains, 212 stale records, 51 with
      nothing to check them by. Candidates within reach go from 1,682 to 2,402; loading takes about
      400 ms instead of 230, and ranking about 190 ms.
    - Bronxville: 63 venues to 94. Its Sunday family search has 85 options instead of 54, and the
      Ready places still lead.
  - **Golden scenarios** now replay the Overture captures too. Places stay the same when their
    number is written differently ("Hunan III" matches Overture's "Hunan 3"), and a music venue
    named for karaoke is an activity, not a show.
  - **Next:** hours for these places from their own sites (first-party JSON-LD), so the best of
    them can be Ready.
- **`outrn ingest osm --all`**, one merged query across overlapping area extents instead of ten.

### Batch 9: learning from use
- Interaction events (go, details, dismiss) become a popularity prior and time-of-day patterns per venue.
- A post-trip "was it open? was it busy?" prompt becomes an observation, closing the verification
  loop and giving real crowd and wait data.
- **People's own reviews and photos in the app:** content we own, with moderation.

## Performance budget

- **Target:** under 300 ms engine time per request at 5,000 venues within reach.
- **Now:** the engine takes about 140 ms warm and 340 ms cold, at 3,850 candidates.
- **Loading: done.** Each venue's current facts are kept as one document (`venues.facts_doc`),
  rebuilt by materialization with the same SQL the loader used to run per candidate. On the LES
  capture with Overture's places (2,402 candidates), loading takes about 125 ms instead of 325; the
  database part is about 30 ms. A set-based query was tried first: it was slower (2.6 s), because
  it cannot use the index to find each fact's inputs.
- **Next:** landmark and brand come from the source records per candidate (about 16 ms at 2,400);
  they could join the document if loading matters again.

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
7. **Event sources (batch 10, part 4):** allow data.cityofnewyork.us, www.nycgovparks.org,
   www.nypl.org, app.ticketmaster.com, api.seatgeek.com and venues' own sites in the environment's
   network access, and create free Ticketmaster and SeatGeek keys.
8. **Parks without hours:** treat a public park or garden with no listed hours as usually open dawn to
   dusk (Ready, labelled as an estimate), so the outdoors lover sees more than one park?
