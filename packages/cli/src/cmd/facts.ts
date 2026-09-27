import type { Command } from "commander";
import { getDb } from "@outrn/db";
import { isAttribute, parseFounderValue } from "@outrn/facts";
import { resolveVenueRef, setFounderFact } from "@outrn/ingest";

/**
 * Founder-entered facts. `facts set` writes a published fact with source 'founder' and your
 * evidence; `facts show` prints what the engine currently believes, with source and age.
 */
export function registerFacts(program: Command): void {
  const facts = program.command("facts").description("Founder-checked facts: set a value you verified, show what the engine believes");

  facts
    .command("set <venue> <attribute> <value>")
    .description('Record a fact you checked, e.g. facts set "Pete\'s Park Place Tavern" opening_hours "Mo-Su 16:00-04:00" --evidence "called 9/26"')
    .requiredOption("--evidence <text>", "what you checked and how: 'called 9/26', 'visited, posted hours on door'")
    .option("--verified <date>", "when you checked it (YYYY-MM-DD); default now")
    .option("--confidence <n>", "0–1; default 0.9", parseFloat)
    .option("--area <slug>", "narrow a name lookup to one area")
    .option("--json", "value is raw JSON in the stored shape (see core/evidence.ts)")
    .action(async (venueRef: string, attribute: string, raw: string, o: { evidence: string; verified?: string; confidence?: number; area?: string; json?: boolean }) => {
      const db = getDb();
      if (!isAttribute(attribute)) throw new Error(`unknown attribute '${attribute}'`);
      const value = parseFounderValue(attribute, raw, { json: o.json ?? false });
      const venue = await resolveVenueRef(db, venueRef, o.area ? { areaSlug: o.area } : {});
      const verifiedAt = o.verified ? new Date(o.verified) : undefined;
      if (verifiedAt && Number.isNaN(verifiedAt.getTime())) throw new Error(`--verified is not a date: ${o.verified}`);
      const r = await setFounderFact(db, { venueId: venue.id, attribute, value, evidence: o.evidence, ...(verifiedAt ? { verifiedAt } : {}), ...(o.confidence !== undefined ? { confidence: o.confidence } : {}), actor: "cli" });
      console.log(`${venue.name} [${venue.category}] · ${attribute} = ${JSON.stringify(value)}`);
      console.log(`  ${r.inserted ? "recorded" : "unchanged"}${r.superseded ? ` · superseded ${r.superseded} earlier founder value` : ""} · engine now uses: ${r.winnerSources.join(", ") || "—"}`);
      if (!r.winnerSources.includes("founder")) console.log(`  note: a higher-trust source still wins for ${attribute}; see \`outrn facts show ${venue.id}\``);
    });

  facts
    .command("show <venue>")
    .description("Current facts for a venue with evidence class, source and age")
    .option("--area <slug>", "narrow a name lookup to one area")
    .action(async (venueRef: string, o: { area?: string }) => {
      const db = getDb();
      const venue = await resolveVenueRef(db, venueRef, o.area ? { areaSlug: o.area } : {});
      const rows = await db.query<{ attribute: string; value: unknown; evidence_class: string; confidence: string; source_ids: string[]; conflict: boolean; as_of: Date | null; fetched_at: Date | null }>(
        `select cf.attribute, cf.value, cf.evidence_class, cf.confidence, cf.source_ids, cf.conflict,
                (select max(coalesce(f.observed_at, f.source_updated_at)) from facts f where f.id = any(cf.input_fact_ids)) as as_of,
                (select max(f.fetched_at) from facts f where f.id = any(cf.input_fact_ids)) as fetched_at
           from current_facts cf where cf.subject_kind = 'venue' and cf.subject_id = $1 order by cf.attribute`,
        [venue.id],
      );
      console.log(`${venue.name} [${venue.category}] · ${venue.publishState}${venue.area ? ` · ${venue.area}` : ""} · ${venue.id}`);
      for (const r of rows.rows) {
        const age = r.as_of ? `as of ${r.as_of.toISOString().slice(0, 10)}` : r.fetched_at ? `retrieved ${r.fetched_at.toISOString().slice(0, 10)}` : "";
        console.log(`  ${r.attribute.padEnd(18)} ${JSON.stringify(r.value).slice(0, 60).padEnd(60)} ${r.evidence_class.padEnd(11)} ${r.source_ids.join(",").padEnd(14)} ${Number(r.confidence).toFixed(2)}${r.conflict ? " CONFLICT" : ""}  ${age}`);
      }
    });
}
