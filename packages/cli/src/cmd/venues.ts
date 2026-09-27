import type { Command } from "commander";
import { isCategory } from "@outrn/core";
import { getDb } from "@outrn/db";
import { parseFounderValue } from "@outrn/facts";
import { addFounderVenue, findVenues } from "@outrn/ingest";

export function registerVenues(program: Command): void {
  const venues = program.command("venues").description("Find venues; add places OSM does not have");

  venues
    .command("find <text>")
    .description("Venues whose name matches, with ids (for facts set, firstparty add, ops override)")
    .option("--area <slug>")
    .action(async (text: string, o: { area?: string }) => {
      const rows = await findVenues(getDb(), text, o.area ? { areaSlug: o.area } : {});
      if (!rows.length) console.log(`no venue matches "${text}"`);
      for (const r of rows) console.log(`  ${r.id}  ${r.name.padEnd(34)} ${r.category.padEnd(12)} ${r.publishState.padEnd(9)} ${(r.area ?? "").padEnd(11)} hours: ${r.hours ? `${r.hours} (${r.hoursSources.join(",")})` : "—"}`);
    });

  venues
    .command("add")
    .description("Add a place OSM lacks (links to the existing venue instead if OSM already has it)")
    .requiredOption("--name <text>")
    .requiredOption("--category <category>")
    .requiredOption("--lat <n>", "latitude of the entrance", parseFloat)
    .requiredOption("--lon <n>", "longitude of the entrance", parseFloat)
    .requiredOption("--evidence <text>", "how you know: 'visited 9/26', 'venue site + called'")
    .option("--area <slug>", "default: nearest service area")
    .option("--website <url>")
    .option("--phone <text>")
    .option("--hours <osm>", 'OSM opening_hours syntax, e.g. "Mo-Su 12:00-01:00"')
    .option("--verified <date>", "when you checked it (YYYY-MM-DD); default now")
    .action(async (o: { name: string; category: string; lat: number; lon: number; evidence: string; area?: string; website?: string; phone?: string; hours?: string; verified?: string }) => {
      if (!isCategory(o.category)) throw new Error(`unknown category '${o.category}'`);
      if (!Number.isFinite(o.lat) || !Number.isFinite(o.lon)) throw new Error("--lat and --lon must be numbers");
      if (o.hours) parseFounderValue("opening_hours", o.hours);
      if (o.website) parseFounderValue("website", o.website);
      const verifiedAt = o.verified ? new Date(o.verified) : undefined;
      const r = await addFounderVenue(getDb(), {
        name: o.name,
        category: o.category,
        point: { lat: o.lat, lon: o.lon },
        evidence: o.evidence,
        ...(o.area ? { areaSlug: o.area } : {}),
        ...(o.website ? { website: o.website } : {}),
        ...(o.phone ? { phone: o.phone } : {}),
        ...(o.hours ? { hours: o.hours } : {}),
        ...(verifiedAt ? { verifiedAt } : {}),
        actor: "cli",
      });
      if (!r.created) console.log(`already known: linked to existing venue ${r.venueId} (score ${r.score.toFixed(2)}); founder facts added to it`);
      else if (r.decision === "review") console.log(`created ${r.venueId} in ${r.area}; flagged for review against ${r.matchedVenueId} (score ${r.score.toFixed(2)}) — see ops queue`);
      else console.log(`created ${r.venueId} in ${r.area}${r.parentVenueId ? ` as a child of ${r.parentVenueId}` : ""}`);
    });
}
