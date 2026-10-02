import type { Command } from "commander";
import { RecommendationRequest, type Budget } from "@outrn/contracts";
import { page, runEngine, search, type InternalOverrides } from "@outrn/api";
import { getDb } from "@outrn/db";
import { explain } from "@outrn/engine";

/**
 * Same request resolution and engine run as the API (via @outrn/api), so what this prints is what
 * the UI would get. --json prints the exact v1 response.
 */
export function registerRecommend(program: Command): void {
  program
    .command("recommend")
    .description("Run the engine for an area and window; prints the shortlist and the debug view (or the v1 API response with --json)")
    .option("--area <slug>", "service area", "les")
    .option("--lat <n>", "origin latitude (default: the area's center)", parseFloat)
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
    .option("--cuisines <list>", "comma-separated cuisines (japanese, pizza…): only food places serving one")
    .option("--diets <list>", "comma-separated diets (vegetarian, vegan, gluten_free, halal, kosher): only food places known to serve all")
    .option("--features <list>", "comma-separated must-haves (outdoor_seating, wifi, wheelchair)")
    .option("--like <list>", "comma-separated interests this person likes, each optionally weighted (live_music, art:0.5…)")
    .option("--skip <list>", "comma-separated interests this person skips (drinks, nightlife…)")
    .option("--wheelchair", "require wheelchair access")
    .option("--youngest <age>", "age of the youngest person going (age limits gate on it; family without it assumes a minor)", (v) => parseInt(v, 10))
    .option("--offset <n>", "skip this many options (\"More options\" pages by 3)", (v) => parseInt(v, 10), 0)
    .option("--json", "print the v1 API response the UI would receive (first page; use --cursor for more)")
    .option("--cursor <c>", "with --json: print another page of an earlier search")
    .option("--all", "print every candidate with its class and exclusion reason")
    .option("--no-persist", "do not record the run")
    .action(async (o: Record<string, unknown>) => {
      const db = getDb();
      if (o["cursor"]) {
        console.log(JSON.stringify(await page(db, String(o["cursor"])), null, 2));
        return;
      }
      // A taste as the app would send it: likes weigh 1 (or the weight given), skips -1.
      const weighed = (list: unknown, sign: 1 | -1) =>
        list ? String(list).split(",").map((x) => x.trim()).filter(Boolean).map((x) => {
          const [interest, w] = x.split(":") as [string, string | undefined];
          return { interest, weight: sign * (w === undefined ? 1 : Number(w)) };
        }) : [];
      const taste = [...weighed(o["like"], 1), ...weighed(o["skip"], -1)];
      const budget: Budget | undefined = o["budget"] === undefined ? undefined : o["budget"] === "free" ? { kind: "free" } : { kind: "max", maxCents: Math.round(Number(o["budget"]) * 100), currency: "USD" };
      const parsed = RecommendationRequest.safeParse({
        areaId: String(o["area"]),
        windowMinutes: o["minutes"],
        ...(o["mode"] ? { travelMode: o["mode"] } : {}),
        ...(budget ? { budget } : {}),
        ...(o["mood"] ? { mood: o["mood"] } : {}),
        ...(o["company"] ? { company: o["company"] } : {}),
        ...(typeof o["youngest"] === "number" && Number.isFinite(o["youngest"]) ? { youngestAge: o["youngest"] } : {}),
        ...(o["categories"] ? { categories: String(o["categories"]).split(",").map((x) => x.trim()) } : {}),
        ...(o["cuisines"] ? { cuisines: String(o["cuisines"]).split(",").map((x) => x.trim()) } : {}),
        ...(o["diets"] ? { diets: String(o["diets"]).split(",").map((x) => x.trim()) } : {}),
        ...(o["features"] ? { features: String(o["features"]).split(",").map((x) => x.trim()) } : {}),
        ...(o["at"] ? { at: new Date(String(o["at"])).toISOString() } : {}),
        ...(taste.length ? { taste } : {}),
      });
      if (!parsed.success) {
        for (const i of parsed.error.issues) console.error(`${i.path.join(".") || "request"}: ${i.message}`);
        process.exitCode = 1;
        return;
      }
      // The CLI is an operator tool: it can evaluate areas that are not open yet.
      const overrides: InternalOverrides = { includeUnlaunched: true };
      if (typeof o["lat"] === "number" && typeof o["lon"] === "number") overrides.origin = { lat: o["lat"], lon: o["lon"] };
      if (o["backBy"]) overrides.backBy = new Date(String(o["backBy"]));
      if (o["maxTravel"]) overrides.maxTravelMinutes = o["maxTravel"] as number;
      if (o["wheelchair"]) overrides.requireWheelchair = true;

      if (o["json"]) {
        console.log(JSON.stringify(await search(db, parsed.data, { overrides }), null, 2));
        return;
      }

      const run = await runEngine(db, parsed.data, { overrides, persist: o["persist"] !== false });
      const { ctx, shortlist: s, candidates } = run;
      const offset = Math.max(0, (o["offset"] as number) ?? 0);
      const items = s.ordered.slice(offset, offset + 3);
      console.log(`${ctx.now.toISOString()} · ${ctx.mode} · ${ctx.windowMinutes} min · ${candidates.length} candidates · ${run.durationMs} ms${run.runId ? ` · run ${run.runId}` : ""}`);
      const counts = { ready: 0, check_first: 0, ineligible: 0 } as Record<string, number>;
      for (const e of s.all) counts[e.class] = (counts[e.class] ?? 0) + 1;
      console.log(`ready ${counts["ready"]} · check first ${counts["check_first"]} · ineligible ${counts["ineligible"]}`);
      console.log("");
      items.forEach((e, i) => {
        const copy = explain(e, ctx.timezone, ctx.cuisines);
        console.log(`${offset + i + 1}. ${e.candidate.name}  [${e.candidate.category}]  ${copy.cta ?? ""}`);
        console.log(`   ${copy.factLine}`);
        if (copy.sentence) console.log(`   ${copy.sentence}`);
        if (copy.caveat) console.log(`   ${copy.caveat}`);
        console.log(`   evidence ${e.scores.evidence} · fit ${e.scores.fit} · appeal ${e.scores.appeal} · novelty ${e.scores.novelty}${e.scores.taste === undefined ? "" : ` · taste ${e.scores.taste}`}`);
      });
      if (offset === 0 && s.fewerThanThree) console.log(`\nOnly ${s.items.length} qualified. Try: ${s.relaxations.map((r) => `${r.text} (+${r.admits})`).join(" · ") || "a different time"}`);
      if (s.ordered.length > offset + items.length && items.length) console.log(`\nMore options: --offset ${offset + items.length}`);
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
