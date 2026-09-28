import type { Command } from "commander";
import { getDb, withTx } from "@outrn/db";
import { materializeAll } from "@outrn/facts";
import { ingestOsmArea, ingestPhotos } from "@outrn/ingest";

export function registerIngest(program: Command): void {
  const ingest = program.command("ingest").description("Pull supply from a registered source into the raw store and onward to venues and facts");

  ingest
    .command("osm")
    .description("Ingest an area from Overpass (or replay a saved response)")
    .requiredOption("--area <slug>", "service area slug, e.g. les")
    .option("--from-file <path>", "replay a saved Overpass JSON response instead of fetching")
    .option("--save <path>", "save the fetched response for later replay")
    .option("--radius <m>", "override the derived ingest radius (catchment + max reach), metres", (v) => parseInt(v, 10))
    .action(async (o: { area: string; fromFile?: string; save?: string; radius?: number }) => {
      const db = getDb();
      const t0 = Date.now();
      const s = await ingestOsmArea(db, { areaSlug: o.area, ...(o.fromFile ? { fromFile: o.fromFile } : {}), ...(o.save ? { saveTo: o.save } : {}), ...(o.radius ? { radiusM: o.radius } : {}), log: (l) => console.log(l) });
      console.log("");
      console.log(`run ${s.runId} · area ${s.area} · extent ${s.extentM} m · ${Date.now() - t0} ms`);
      console.log(`  elements   ${s.fetched} kept, ${s.dropped} dropped${s.osmBaseTimestamp ? ` · OSM base ${s.osmBaseTimestamp}` : ""}`);
      console.log(`  raw        ${s.raw.new} new · ${s.raw.changed} changed · ${s.raw.unchanged} unchanged · ${s.raw.tombstoned} tombstoned${s.raw.renormalized ? ` · ${s.raw.renormalized} re-normalized (rules changed)` : ""}`);
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
      console.log(`  photos     ${s.photos} for ${s.withPhotos} of ${s.venues} venues that name a Commons file or a Wikidata item · ${s.skipped} files skipped (not free, uncredited, not a photo, or missing)`);
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
