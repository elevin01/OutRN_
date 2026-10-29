import type { Command } from "commander";
import { getDb, withTx } from "@outrn/db";
import { materializeAll } from "@outrn/facts";
import { readFileSync } from "node:fs";
import { OSM_MAX_DATA_AGE_DAYS } from "@outrn/sources";
import { ingestDestinations, ingestEvents, ingestNycParksEvents, ingestCalendars, ingestOsmArea, ingestOverture, ingestPhotos, ingestTicketedEvents, refreshFilmPopularity, TICKETING_KEYS, TMDB_KEY } from "@outrn/ingest";

export function registerIngest(program: Command): void {
  const ingest = program.command("ingest").description("Pull supply from a registered source into the raw store and onward to venues and facts");

  ingest
    .command("osm")
    .description("Ingest an area from Overpass (or replay a saved response)")
    .requiredOption("--area <slug>", "service area slug, e.g. les")
    .option("--from-file <path>", "replay a saved Overpass JSON response instead of fetching")
    .option("--save <path>", "save the fetched response for later replay")
    .option("--radius <m>", "override the derived ingest radius (catchment + max reach), metres", (v) => parseInt(v, 10))
    .option("--max-data-age <days>", `how old a fetched snapshot's data may be, in days (default ${OSM_MAX_DATA_AGE_DAYS}): a lagging mirror's is asked again, then refused`, (v) => parseFloat(v))
    .action(async (o: { area: string; fromFile?: string; save?: string; radius?: number; maxDataAge?: number }) => {
      const db = getDb();
      const t0 = Date.now();
      const s = await ingestOsmArea(db, {
        areaSlug: o.area,
        ...(o.fromFile ? { fromFile: o.fromFile } : {}),
        ...(o.save ? { saveTo: o.save } : {}),
        ...(o.radius ? { radiusM: o.radius } : {}),
        ...(o.maxDataAge !== undefined && Number.isFinite(o.maxDataAge) ? { maxDataAgeDays: o.maxDataAge } : {}),
        log: (l) => console.log(l),
      });
      console.log("");
      console.log(`run ${s.runId} · area ${s.area} · extent ${s.extentM} m · ${Date.now() - t0} ms`);
      console.log(`  elements   ${s.fetched} kept, ${s.dropped} dropped${s.osmBaseTimestamp ? ` · OSM base ${s.osmBaseTimestamp}` : ""}`);
      console.log(`  raw        ${s.raw.new} new · ${s.raw.changed} changed · ${s.raw.unchanged} unchanged${s.raw.older ? ` · ${s.raw.older} older than stored (kept)` : ""} · ${s.raw.tombstoned} tombstoned${s.raw.renormalized ? ` · ${s.raw.renormalized} re-normalized (rules changed)` : ""}`);
      if (s.behindOsmBase) console.log(`  note       the snapshot's data is older than the area's last (${s.behindOsmBase}): it withdrew nothing`);
      console.log(`  venues     ${s.venues.created} created · ${s.venues.linked} linked to existing · ${s.venues.review} flagged for review · ${s.venues.children} child venues · ${s.venues.skipped} skipped`);
      console.log(`  facts      ${s.facts.inserted} inserted · ${s.facts.superseded} superseded · ${s.facts.rejected} rejected`);
      console.log(`  current    ${s.materialized.subjects} venues materialized · ${s.materialized.conflicts} conflicts · ${s.materialized.tasks} verification tasks`);
      console.log(`  parking    ${s.parking.facilities} public places to park · ${s.parking.removed} removed`);
    });

  ingest
    .command("photos")
    .description("Free photos for an area's venues from Wikimedia Commons: files their OSM records name, then their Wikidata image")
    .requiredOption("--area <slug>", "service area slug, e.g. les")
    .option("--from-file <path>", "replay a saved capture instead of fetching")
    .option("--save <path>", "save every response for later replay")
    .option("--radius <m>", "override the derived extent (catchment + max reach), metres", (v) => parseInt(v, 10))
    .action(async (o: { area: string; fromFile?: string; save?: string; radius?: number }) => {
      const db = getDb();
      const t0 = Date.now();
      const s = await ingestPhotos(db, { areaSlug: o.area, ...(o.fromFile ? { fromFile: o.fromFile } : {}), ...(o.save ? { saveTo: o.save } : {}), ...(o.radius ? { radiusM: o.radius } : {}), log: (l) => console.log(l) });
      console.log("");
      console.log(`run ${s.runId} · area ${s.area} · ${Date.now() - t0} ms`);
      console.log(`  photos     ${s.photos} for ${s.withPhotos} of ${s.venues} venues that name a Commons file or a Wikidata item · ${s.skipped} files skipped (not free, uncredited, not a photo, new on Commons, tagged for deletion, or missing)`);
    });

  ingest
    .command("overture")
    .description("Check an area's venues against Overture Maps places (still operating, closed, missing websites and phones) and add the places OSM lacks (or replay a saved read)")
    .requiredOption("--area <slug>", "service area slug; ingest it from OSM first")
    .option("--from-file <path>", "replay a saved read instead of reading the Overture bucket")
    .option("--save <path>", "save what was read for later replay")
    .option("--release <name>", "an Overture release, e.g. 2026-09-23.1 (default: the newest)")
    .option("--no-new-places", "only check existing venues; add none of the places OSM lacks")
    .action(async (o: { area: string; fromFile?: string; save?: string; release?: string; newPlaces: boolean }) => {
      const db = getDb();
      const t0 = Date.now();
      const s = await ingestOverture(db, { areaSlug: o.area, newPlaces: o.newPlaces, ...(o.fromFile ? { fromFile: o.fromFile } : {}), ...(o.save ? { saveTo: o.save } : {}), ...(o.release ? { release: o.release } : {}), log: (l) => console.log(l) });
      console.log("");
      console.log(`run ${s.runId} · area ${s.area} · Overture ${s.release} · ${Date.now() - t0} ms`);
      if (s.read) console.log(`  read       ${s.read.rowGroups} of ${s.read.totalRowGroups} row groups · ${(s.read.bytes / 1_048_576).toFixed(0)} MB`);
      console.log(`  places     ${s.places} Overture places · ${s.venues.matched} of ${s.venues.considered} venues matched`);
      console.log(`  claims     ${s.claims.operating} operating · ${s.claims.closed} closed · ${s.claims.website} websites · ${s.claims.phone} phones`);
      if (s.newPlaces) {
        const n = s.newPlaces;
        const skipped = Object.entries(n.skipped).filter(([, c]) => c > 0).map(([k, c]) => `${c} ${k}`).join(", ") || "none";
        console.log(`  new places ${n.added} added · ${n.kept} kept · ${n.removed} removed · ${n.possibleDuplicates} left out as possible duplicates · skipped: ${skipped}`);
        if (n.examples.length) console.log(`             e.g. ${n.examples.join(", ")}`);
      }
      console.log(`  facts      ${s.facts.inserted} inserted · ${s.facts.superseded} superseded · ${s.facts.rejected} rejected`);
      console.log(`  current    ${s.materialized.subjects} venues materialized · ${s.materialized.conflicts} conflicts · ${s.materialized.tasks} verification tasks`);
    });

  ingest
    .command("destinations")
    .description("Add the places worth going out of the way for around an area (preserves, gardens, beaches, lookouts, estates), from the curated list and Overture Maps places (or replay a saved read)")
    .requiredOption("--area <slug>", "service area slug")
    .option("--from-file <path>", "replay a saved read instead of reading the Overture bucket")
    .option("--save <path>", "save what was read for later replay")
    .option("--release <name>", "an Overture release, e.g. 2026-09-23.1 (default: the newest)")
    .action(async (o: { area: string; fromFile?: string; save?: string; release?: string }) => {
      const db = getDb();
      const t0 = Date.now();
      const s = await ingestDestinations(db, { areaSlug: o.area, ...(o.fromFile ? { fromFile: o.fromFile } : {}), ...(o.save ? { saveTo: o.save } : {}), ...(o.release ? { release: o.release } : {}), log: (l) => console.log(l) });
      console.log("");
      console.log(`run ${s.runId} · area ${s.area} · Overture ${s.release} · ${Date.now() - t0} ms`);
      console.log(`  places       ${s.places} Overture places in reach · ${s.destinations.curated} curated destinations · ${s.destinations.gated} by their records`);
      console.log(`  venues       ${s.venues.added} added · ${s.venues.existing} already known · ${s.venues.removed} no longer destinations · ${s.venues.possibleDuplicates} left out as possible duplicates`);
      if (s.missing.length) console.log(`  not found    ${s.missing.join(", ")}`);
      console.log(`  facts        ${s.facts.inserted} inserted · ${s.facts.superseded} superseded · ${s.facts.rejected} rejected`);
    });

  ingest
    .command("events")
    .description("Add or update events from a file: what is happening, when and where (a venue we know, or a place of its own such as a pier for fireworks)")
    .requiredOption("--area <slug>", "service area slug")
    .requiredOption("--from-file <path>", 'JSON: { "source": "founder", "events": [{ "id", "title", "start", "end"?, "place": { "venue" } | { "name", "lat", "lon" }, "kinds"?, "forKids"?, "url"?, "price"?, "admission"?, "minAge"?, "status"?, "evidence" }] }')
    .action(async (o: { area: string; fromFile: string }) => {
      const db = getDb();
      const t0 = Date.now();
      const s = await ingestEvents(db, JSON.parse(readFileSync(o.fromFile, "utf8")), { areaSlug: o.area });
      console.log(`run ${s.runId} · area ${s.area} · source ${s.source} · ${Date.now() - t0} ms`);
      console.log(`  events     ${s.written} of ${s.events} written · ${s.sitesCreated} new event sites · ${s.rejected.length} left out`);
      for (const r of s.rejected) console.log(`  left out   #${r.index}${r.id ? ` ${r.id}` : ""}: ${r.reason}`);
      if (s.rejected.length) process.exitCode = 1;
    });

  ingest
    .command("nyc-parks")
    .description("Add the area's NYC Parks events (NYC Open Data, the next two weeks): classes, tours, festivals, film nights, concerts")
    .requiredOption("--area <slug>", "service area slug")
    .option("--from-file <path>", "replay a saved read instead of reading the table")
    .option("--save <path>", "save the rows the area holds, for replay")
    .action(async (o: { area: string; fromFile?: string; save?: string }) => {
      const db = getDb();
      const t0 = Date.now();
      const s = await ingestNycParksEvents(db, { areaSlug: o.area, ...(o.fromFile ? { fromFile: o.fromFile } : {}), ...(o.save ? { saveTo: o.save } : {}), log: (l) => console.log(l) });
      console.log(`run ${s.runId} · area ${s.area} · source ${s.source} · ${Date.now() - t0} ms`);
      console.log(`  events     ${s.written} of ${s.events} written (of ${s.rows} in the city) · ${s.sitesCreated} new event sites · ${s.withdrawn} withdrawn (no longer listed) · ${s.rejected.length} left out`);
      for (const r of s.rejected) console.log(`  left out   #${r.index}${r.id ? ` ${r.id}` : ""}: ${r.reason}`);
      if (s.rejected.length) process.exitCode = 1;
    });

  for (const source of ["ticketmaster", "seatgeek"] as const) {
    ingest
      .command(source)
      .description(`Add the area's ticketed events from ${source === "ticketmaster" ? "Ticketmaster's Discovery API" : "SeatGeek's API"} (the next two weeks): concerts, comedy, theatre, sports. Needs ${TICKETING_KEYS[source]}`)
      .requiredOption("--area <slug>", "service area slug")
      .option("--from-file <path>", "replay a saved read instead of asking the API")
      .option("--save <path>", "save the events read (never the key), for replay")
      .action(async (o: { area: string; fromFile?: string; save?: string }) => {
        const db = getDb();
        const t0 = Date.now();
        const s = await ingestTicketedEvents(db, { source, areaSlug: o.area, ...(o.fromFile ? { fromFile: o.fromFile } : {}), ...(o.save ? { saveTo: o.save } : {}), log: (l) => console.log(l) });
        console.log(`run ${s.runId} · area ${s.area} · source ${s.source} · ${Date.now() - t0} ms`);
        console.log(`  events     ${s.written} of ${s.events} written (of ${s.read} read) · ${s.sitesCreated} new event sites · ${s.withdrawn} withdrawn (no longer listed) · ${s.rejected.length} left out`);
        for (const r of s.rejected) console.log(`  left out   #${r.index}${r.id ? ` ${r.id}` : ""}: ${r.reason}`);
        if (s.rejected.length) process.exitCode = 1;
      });
  }

  ingest
    .command("films")
    .description(`Mark the screenings of the films people are going to now: TMDB's most popular films now playing or trending, matched by title. Needs ${TMDB_KEY}`)
    .option("--from-file <path>", "replay a saved read instead of asking TMDB")
    .option("--save <path>", "save the films read (never the key), for replay")
    .action(async (o: { fromFile?: string; save?: string }) => {
      const t0 = Date.now();
      const s = await refreshFilmPopularity(getDb(), { ...(o.fromFile ? { fromFile: o.fromFile } : {}), ...(o.save ? { saveTo: o.save } : {}), log: (l) => console.log(l) });
      console.log(`run ${s.runId} · ${Date.now() - t0} ms`);
      console.log(`  screenings ${s.popular} of ${s.screenings} upcoming are of a popular film · ${s.retracted} no longer`);
    });

  ingest
    .command("calendars")
    .description("Add events from libraries', towns' and nature centers' own calendars (a reviewed list of feeds; robots.txt obeyed)")
    .option("--area <slug>", "only this area's events (default: every area)")
    .option("--from-file <path>", "replay a saved read instead of reading the feeds")
    .option("--save <path>", "save what each feed gave, for replay")
    .option("--days <n>", "how far ahead to read", (v) => parseInt(v, 10))
    .action(async (o: { area?: string; fromFile?: string; save?: string; days?: number }) => {
      const db = getDb();
      const t0 = Date.now();
      const s = await ingestCalendars(db, { ...(o.area ? { areaSlug: o.area } : {}), ...(o.fromFile ? { fromFile: o.fromFile } : {}), ...(o.save ? { saveTo: o.save } : {}), ...(o.days ? { days: o.days } : {}), log: (l) => console.log(l) });
      const read = s.reads.filter((r) => r.status === "ok");
      console.log(`calendars · ${read.length} of ${s.reads.length} feeds read (${s.reads.filter((r) => r.status === "robots").length} kept out by robots.txt, ${s.reads.filter((r) => r.status === "failed").length} failed) · ${Date.now() - t0} ms`);
      console.log(`  skipped    ${Object.entries(s.skipped).map(([k, n]) => `${k} ${n}`).join(", ")}`);
      for (const a of s.areas) console.log(`  ${a.area.padEnd(13)}${a.written} written · ${a.withdrawn} withdrawn · ${a.rejected.length} left out`);
      for (const a of s.areas) for (const r of a.rejected) console.log(`  left out   ${a.area} #${r.index}${r.id ? ` ${r.id}` : ""}: ${r.reason}`);
    });

  program
    .command("materialize")
    .description("Rebuild current_facts and publish states from the facts table")
    .option("--area <slug>", "limit to one service area")
    .action(async (o: { area?: string }) => {
      const db = getDb();
      let areaId: string | undefined;
      if (o.area) areaId = (await db.query<{ id: string }>("select id from service_areas where slug = $1", [o.area])).rows[0]?.id;
      const r = await withTx(db, (tx) => materializeAll(tx, areaId));
      console.log(`materialized ${r.subjects} venues · ${r.attributes} attributes · ${r.conflicts} conflicts · ${r.tasksCreated} new verification tasks`);
    });
}
