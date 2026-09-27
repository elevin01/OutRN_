import type { Command } from "commander";
import type { Category, TravelMode } from "@outrn/core";
import { getArea, getDb } from "@outrn/db";
import { explain, loadCandidates, loadParkingBuffer, loadPolicies, persistRun, recommend, type RequestContext } from "@outrn/engine";

export function registerRecommend(program: Command): void {
  program
    .command("recommend")
    .description("Run the engine for a point and window; prints the shortlist and the debug view")
    .option("--area <slug>", "service area (origin defaults to its center)")
    .option("--lat <n>", "origin latitude", parseFloat)
    .option("--lon <n>", "origin longitude", parseFloat)
    .option("--at <iso>", "pretend it is this time (ISO 8601); default now")
    .option("--minutes <n>", "free time in minutes", (v) => parseInt(v, 10), 180)
    .option("--back-by <iso>", "must be back at origin by this time")
    .option("--mode <walk|drive|transit>", "travel mode; default from area")
    .option("--max-travel <n>", "max one-way travel minutes", (v) => parseInt(v, 10))
    .option("--budget <n|free>", "per-person cap in USD, or 'free'")
    .option("--mood <relaxed|active|food|culture>")
    .option("--company <alone|date|friends|family>")
    .option("--categories <list>", "comma-separated categories to narrow to")
    .option("--wheelchair", "require wheelchair access")
    .option("--offset <n>", "skip this many options (\"More options\" pages by 3)", (v) => parseInt(v, 10), 0)
    .option("--all", "print every candidate with its class and exclusion reason")
    .option("--no-persist", "do not record the run")
    .action(async (o: Record<string, unknown>) => {
      const db = getDb();
      const area = o["area"] ? await getArea(db, String(o["area"])) : null;
      const origin = { lat: (o["lat"] as number | undefined) ?? area?.lat ?? 40.7185, lon: (o["lon"] as number | undefined) ?? area?.lon ?? -73.988 };
      const now = o["at"] ? new Date(String(o["at"])) : new Date();
      const mode = ((o["mode"] as string | undefined) ?? area?.travel_mode ?? "walk") as TravelMode;
      const ctx: RequestContext = { origin, now, windowMinutes: o["minutes"] as number, mode, timezone: area?.timezone ?? "America/New_York" };
      if (o["backBy"]) ctx.backBy = new Date(String(o["backBy"]));
      if (o["maxTravel"]) ctx.maxTravelMinutes = o["maxTravel"] as number;
      if (o["budget"]) ctx.budget = o["budget"] === "free" ? "free" : Number(o["budget"]);
      if (o["mood"]) ctx.mood = o["mood"] as NonNullable<RequestContext["mood"]>;
      if (o["company"]) ctx.company = o["company"] as NonNullable<RequestContext["company"]>;
      if (o["categories"]) ctx.categories = String(o["categories"]).split(",").map((x) => x.trim()) as Category[];
      if (o["wheelchair"]) ctx.requireWheelchair = true;
      if (area && mode === "drive") {
        const parking = await loadParkingBuffer(db, area.slug, now, ctx.timezone);
        if (parking !== undefined) ctx.parkingBufferMinutes = parking;
      }
      const t0 = Date.now();
      const windowEnd = new Date(now.getTime() + (ctx.windowMinutes ?? 180) * 60_000);
      const [candidates, policies] = await Promise.all([loadCandidates(db, origin, mode, now, windowEnd, ctx.maxTravelMinutes, ctx.parkingBufferMinutes), loadPolicies(db)]);
      const s = recommend(candidates, ctx, policies, { offset: o["offset"] as number });
      const ms = Date.now() - t0;
      const runId = o["persist"] === false ? null : await persistRun(db, area?.id ?? null, ctx, s, ms);

      console.log(`${now.toISOString()} · ${mode} · ${ctx.windowMinutes} min · ${candidates.length} candidates · ${ms} ms${runId ? ` · run ${runId}` : ""}`);
      const counts = { ready: 0, check_first: 0, ineligible: 0 } as Record<string, number>;
      for (const e of s.all) counts[e.class] = (counts[e.class] ?? 0) + 1;
      console.log(`ready ${counts["ready"]} · check first ${counts["check_first"]} · ineligible ${counts["ineligible"]}`);
      console.log("");
      s.items.forEach((e, i) => {
        const copy = explain(e, ctx.timezone);
        console.log(`${s.offset + i + 1}. ${e.candidate.name}  [${e.candidate.category}]  ${copy.cta ?? ""}`);
        console.log(`   ${copy.factLine}`);
        if (copy.sentence) console.log(`   ${copy.sentence}`);
        if (copy.caveat) console.log(`   ${copy.caveat}`);
        console.log(`   evidence ${e.scores.evidence} · fit ${e.scores.fit} · appeal ${e.scores.appeal} · novelty ${e.scores.novelty}`);
      });
      if (s.fewerThanThree) console.log(`\nOnly ${s.items.length} qualified. Try: ${s.relaxations.join(" · ") || "a different time"}`);
      if (s.hasMore) console.log(`\nMore options: --offset ${s.offset + s.items.length}`);
      if (o["all"]) {
        console.log("\n— all candidates —");
        const byClass = [...s.all].sort((a, b) => (a.class > b.class ? 1 : a.class < b.class ? -1 : 0));
        for (const e of byClass) {
          const tail = e.class === "ineligible" ? e.excludedBy : `${e.timing?.travel.minutes}min travel · ${e.timing?.usefulMinutes}min useful${e.unresolved.length ? " · " + e.unresolved.join(",") : ""}`;
          console.log(`  ${e.class.padEnd(12)} ${e.candidate.name.padEnd(34)} ${e.candidate.category.padEnd(12)} ${tail}`);
        }
      }
    });
}
