import { resolve } from "node:path";
import type { RecommendationRequest } from "@outrn/contracts";
import { reset, type Db } from "@outrn/db";
import { caveatNotes, reasonNotes } from "@outrn/engine";
import { ingestOsmArea, ingestOverture } from "@outrn/ingest";
import { runEngine } from "../src/service/recommendations.js";

/**
 * The golden scenario set: fixed searches over real places (the OpenStreetMap captures in
 * fixtures/live, ODbL, © OpenStreetMap contributors), and the ranking each one gives. A change to the
 * engine that moves what people see shows up as a reviewable diff of fixtures/golden/scenarios.json,
 * not as a surprise: read it as "would I go there, then?". Accept a reviewed change with `pnpm golden`.
 */

export const GOLDEN_FILE = "fixtures/golden/scenarios.json";
/** How far down each ranking is pinned: the first two pages. */
export const GOLDEN_DEPTH = 6;

interface GoldenScenario {
  id: string;
  /** What someone would be doing, in words. */
  title: string;
  /** The request's instant, UTC. Titles give New York local time. */
  at: string;
  request: RecommendationRequest;
}

export const GOLDEN_SCENARIOS: GoldenScenario[] = [
  { id: "les-sat-morning", title: "LES, Saturday 10am, 3 hours, walking", at: "2026-10-03T14:00:00Z", request: { areaId: "les", windowMinutes: 180 } },
  { id: "les-sat-afternoon", title: "LES, Saturday 2pm, 2 hours", at: "2026-10-03T18:00:00Z", request: { areaId: "les", windowMinutes: 120 } },
  { id: "les-sat-afternoon-free", title: "LES, Saturday 2pm, 2 hours, free only", at: "2026-10-03T18:00:00Z", request: { areaId: "les", windowMinutes: 120, budget: { kind: "free" } } },
  { id: "les-sat-evening", title: "LES, Saturday 6:30pm, 3 hours", at: "2026-10-03T22:30:00Z", request: { areaId: "les", windowMinutes: 180 } },
  { id: "les-sat-late", title: "LES, Saturday 10:30pm, 2 hours", at: "2026-10-04T02:30:00Z", request: { areaId: "les", windowMinutes: 120 } },
  { id: "les-sun-brunch", title: "LES, Sunday 11am, 2 hours, food", at: "2026-10-04T15:00:00Z", request: { areaId: "les", windowMinutes: 120, categories: ["restaurant", "cafe"] } },
  { id: "les-sun-family", title: "LES, Sunday 1pm, 4 hours, family", at: "2026-10-04T17:00:00Z", request: { areaId: "les", windowMinutes: 240, company: "family" } },
  { id: "les-tue-breakfast", title: "LES, Tuesday 8am, 1 hour", at: "2026-09-29T12:00:00Z", request: { areaId: "les", windowMinutes: 60 } },
  { id: "les-tue-afternoon", title: "LES, Tuesday 3pm, 2 hours", at: "2026-09-29T19:00:00Z", request: { areaId: "les", windowMinutes: 120 } },
  { id: "les-wed-lunch-takeout", title: "LES, Wednesday 12:30pm, 45 minutes, food to go", at: "2026-09-30T16:30:00Z", request: { areaId: "les", windowMinutes: 45, categories: ["restaurant", "cafe"], visitStyle: "takeout" } },
  { id: "les-fri-date", title: "LES, Friday 7:30pm, 90 minutes, a date", at: "2026-10-02T23:30:00Z", request: { areaId: "les", windowMinutes: 90, company: "date" } },
  { id: "les-fri-dinner", title: "LES, Friday 7pm, 2 hours, dinner", at: "2026-10-02T23:00:00Z", request: { areaId: "les", windowMinutes: 120, categories: ["restaurant"] } },
  { id: "les-sat-long", title: "LES, Saturday noon, 5 hours", at: "2026-10-03T16:00:00Z", request: { areaId: "les", windowMinutes: 300 } },
  { id: "les-fri-movies", title: "LES, Friday 7pm, 3 hours, a movie or a show", at: "2026-10-02T23:00:00Z", request: { areaId: "les", windowMinutes: 180, categories: ["cinema", "theatre", "live_music"] } },
  { id: "les-fri-japanese", title: "LES, Friday 7pm, 2 hours, Japanese", at: "2026-10-02T23:00:00Z", request: { areaId: "les", windowMinutes: 120, cuisines: ["japanese"] } },
  { id: "les-sat-pizza", title: "LES, Saturday 1pm, 2 hours, pizza", at: "2026-10-03T17:00:00Z", request: { areaId: "les", windowMinutes: 120, cuisines: ["pizza"] } },
  { id: "les-sun-vegetarian", title: "LES, Sunday 12:30pm, 2 hours, vegetarian", at: "2026-10-04T16:30:00Z", request: { areaId: "les", windowMinutes: 120, diets: ["vegetarian"] } },
  { id: "les-tue-wifi", title: "LES, Tuesday 9am, 3 hours, wifi", at: "2026-09-29T13:00:00Z", request: { areaId: "les", windowMinutes: 180, features: ["wifi"] } },
  { id: "bronxville-sat-evening", title: "Bronxville, Saturday 7:30pm, 2 hours, driving", at: "2026-10-03T23:30:00Z", request: { areaId: "bronxville", windowMinutes: 120 } },
  { id: "bronxville-sun-family", title: "Bronxville, Sunday noon, 3 hours, family", at: "2026-10-04T16:00:00Z", request: { areaId: "bronxville", windowMinutes: 180, company: "family" } },
  { id: "bronxville-mon-after-work", title: "Bronxville, Monday 5:30pm, 90 minutes", at: "2026-09-28T21:30:00Z", request: { areaId: "bronxville", windowMinutes: 90 } },
];

export interface GoldenItem {
  rank: number;
  name: string;
  category: string;
  status: "ready" | "check_first";
  /** Why it's a good option, strongest first (the card's sentence), then what to check. */
  reasons: string[];
  caveats: string[];
}

export interface GoldenResult {
  id: string;
  title: string;
  eligible: number;
  top: GoldenItem[];
  /** Offered when fewer than three qualify. */
  relaxations: string[];
}

/** A throwaway database seeded with the real captures: the same data every run. */
export async function seedGolden(db: Db, root: string): Promise<void> {
  await reset(db);
  // Just after the captures were made (OSM base 2026-09-27), so their survey dates all count.
  for (const area of ["les", "bronxville"]) await ingestOsmArea(db, { areaSlug: area, fromFile: resolve(root, `fixtures/live/${area}.json`), clock: () => new Date("2026-09-28T12:00:00Z") });
  // Then Overture's read of each (taken 29 Sep): whether places still operate, and the places OSM lacks.
  for (const area of ["les", "bronxville"]) await ingestOverture(db, { areaSlug: area, fromFile: resolve(root, `fixtures/live/${area}-overture.json`), clock: () => new Date("2026-09-29T12:00:00Z") });
}

export async function runGolden(db: Db): Promise<GoldenResult[]> {
  const out: GoldenResult[] = [];
  for (const s of GOLDEN_SCENARIOS) {
    const at = new Date(s.at);
    const run = await runEngine(db, s.request, { clock: () => at, persist: false });
    const { shortlist, ctx } = run;
    out.push({
      id: s.id,
      title: s.title,
      eligible: shortlist.all.filter((e) => e.class !== "ineligible").length,
      top: shortlist.ordered.slice(0, GOLDEN_DEPTH).map((e, i) => ({
        rank: i + 1,
        name: e.candidate.name,
        category: e.candidate.category,
        status: e.class as GoldenItem["status"],
        reasons: reasonNotes(e, ctx.timezone).map((n) => n.code),
        caveats: caveatNotes(e).map((n) => n.code),
      })),
      relaxations: shortlist.relaxations.map((r) => r.code),
    });
  }
  return out;
}

/** The golden file's contents, one scenario per line block, so a ranking change reads as a small diff. */
export function formatGolden(results: GoldenResult[]): string {
  return JSON.stringify({ note: "Generated by `pnpm golden`. Review the diff: it is how the engine's ranking changed.", scenarios: results }, null, 1) + "\n";
}
