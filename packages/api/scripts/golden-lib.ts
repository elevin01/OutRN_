import { resolve } from "node:path";
import type { RecommendationRequest } from "@outrn/contracts";
import { reset, setLaunchState, type Db } from "@outrn/db";
import { caveatNotes, reasonNotes } from "@outrn/engine";
import { ingestDestinations, ingestOsmArea, ingestOverture } from "@outrn/ingest";
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
  { id: "les-fri-dinner-wheelchair", title: "LES, Friday 7pm, 2 hours, dinner, step-free", at: "2026-10-02T23:00:00Z", request: { areaId: "les", windowMinutes: 120, categories: ["restaurant"], features: ["wheelchair"] } },
  { id: "les-sun-toddler", title: "LES, Sunday 12:30pm, 2 hours, food with a 2-year-old", at: "2026-10-04T16:30:00Z", request: { areaId: "les", windowMinutes: 120, categories: ["restaurant", "cafe", "dessert"], youngestAge: 2 } },
  // Taste: what the person likes leads, a skip sinks, a mood is a like for this search.
  { id: "les-sat-evening-music-lover", title: "LES, Saturday 6:30pm, 3 hours, loves live music", at: "2026-10-03T22:30:00Z", request: { areaId: "les", windowMinutes: 180, taste: [{ interest: "live_music", weight: 1 }] } },
  { id: "les-sat-afternoon-art-no-bars", title: "LES, Saturday 2pm, 2 hours, loves art, skips bars", at: "2026-10-03T18:00:00Z", request: { areaId: "les", windowMinutes: 120, taste: [{ interest: "art", weight: 1 }, { interest: "drinks", weight: -1 }] } },
  // A taste never pushes a bar for a party with a child: the like of drinks is not applied.
  { id: "les-sat-evening-family-loves-drinks", title: "LES, Saturday 7pm, 3 hours, family with a 10-year-old, loves bars & drinks", at: "2026-10-03T23:00:00Z", request: { areaId: "les", windowMinutes: 180, company: "family", youngestAge: 10, taste: [{ interest: "drinks", weight: 1 }] } },
  { id: "les-fri-culture-mood", title: "LES, Friday 7pm, 3 hours, in the mood for culture", at: "2026-10-02T23:00:00Z", request: { areaId: "les", windowMinutes: 180, mood: "culture" } },
  // Late, for someone who'd rather laugh or play than drink: comedy clubs run past 10pm, and an arcade bar is games.
  { id: "les-fri-late-comedy-games", title: "LES, Friday 10:30pm, 3 hours, loves comedy and games", at: "2026-10-03T02:30:00Z", request: { areaId: "les", windowMinutes: 180, taste: [{ interest: "comedy", weight: 1 }, { interest: "games", weight: 1 }] } },
  { id: "bronxville-sat-evening", title: "Bronxville, Saturday 7:30pm, 2 hours, driving", at: "2026-10-03T23:30:00Z", request: { areaId: "bronxville", windowMinutes: 120 } },
  { id: "bronxville-sun-family", title: "Bronxville, Sunday noon, 3 hours, family", at: "2026-10-04T16:00:00Z", request: { areaId: "bronxville", windowMinutes: 180, company: "family" } },
  { id: "bronxville-mon-after-work", title: "Bronxville, Monday 5:30pm, 90 minutes", at: "2026-09-28T21:30:00Z", request: { areaId: "bronxville", windowMinutes: 90 } },
  { id: "bronxville-sat-afternoon", title: "Bronxville, Saturday 1pm, 4 hours, driving", at: "2026-10-03T17:00:00Z", request: { areaId: "bronxville", windowMinutes: 240 } },
  { id: "bronxville-sat-afternoon-outdoors", title: "Bronxville, Saturday 1pm, 4 hours, loves the outdoors", at: "2026-10-03T17:00:00Z", request: { areaId: "bronxville", windowMinutes: 240, taste: [{ interest: "outdoors", weight: 1 }] } },
  { id: "bronxville-sat-sunset", title: "Bronxville, Saturday 5pm, 3 hours, driving", at: "2026-10-03T21:00:00Z", request: { areaId: "bronxville", windowMinutes: 180 } },
  // White Plains (captured 18 Oct): driving, a downtown where most places list no hours, county parks around.
  { id: "white_plains-sat-family", title: "White Plains, Saturday 1pm, 4 hours, family with a 6-year-old", at: "2026-10-24T17:00:00Z", request: { areaId: "white_plains", windowMinutes: 240, company: "family", youngestAge: 6 } },
  { id: "white_plains-fri-date", title: "White Plains, Friday 7:30pm, 2½ hours, a date", at: "2026-10-23T23:30:00Z", request: { areaId: "white_plains", windowMinutes: 150, company: "date" } },
  { id: "white_plains-sun-evening", title: "White Plains, Sunday 6pm, 3 hours", at: "2026-10-25T22:00:00Z", request: { areaId: "white_plains", windowMinutes: 180 } },
  { id: "white_plains-wed-lunch", title: "White Plains, Wednesday 12:30pm, 1 hour, food", at: "2026-10-21T16:30:00Z", request: { areaId: "white_plains", windowMinutes: 60, categories: ["restaurant", "cafe"] } },
  { id: "white_plains-sat-morning-active", title: "White Plains, Saturday 9:30am, 3 hours, in the mood for something active", at: "2026-10-24T13:30:00Z", request: { areaId: "white_plains", windowMinutes: 180, mood: "active" } },
  { id: "white_plains-wed-late", title: "White Plains, Wednesday 10:30pm, 2 hours", at: "2026-10-22T02:30:00Z", request: { areaId: "white_plains", windowMinutes: 120 } },
  { id: "bronxville-sat-outdoors-lover", title: "Bronxville, Saturday 11am, 3 hours, loves the outdoors and good food", at: "2026-10-03T15:00:00Z", request: { areaId: "bronxville", windowMinutes: 180, taste: [{ interest: "outdoors", weight: 1 }, { interest: "food", weight: 0.5 }] } },
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

/**
 * Each world is seeded on its own: White Plains' capture reaches over Bronxville's, and seeded
 * together they would pin the two areas' results to each other's data.
 */
export const GOLDEN_WORLDS = ["les_bronxville", "white_plains"] as const;
export type GoldenWorld = (typeof GOLDEN_WORLDS)[number];
const worldOf = (s: GoldenScenario): GoldenWorld => (s.request.areaId === "white_plains" ? "white_plains" : "les_bronxville");

/** A throwaway database seeded with one world's real captures: the same data every run. */
export async function seedGolden(db: Db, root: string, world: GoldenWorld = "les_bronxville"): Promise<void> {
  await reset(db);
  if (world === "white_plains") {
    // Captured 18 Oct (OSM, Overture and its destinations), read a day after: the first Westchester
    // town with every source, driving, where most places list no hours.
    const wp = () => new Date("2026-10-19T12:00:00Z");
    await ingestOsmArea(db, { areaSlug: "white_plains", fromFile: resolve(root, "fixtures/live/white_plains.json"), clock: wp });
    await ingestOverture(db, { areaSlug: "white_plains", fromFile: resolve(root, "fixtures/live/white_plains-overture.json"), clock: wp });
    await ingestDestinations(db, { areaSlug: "white_plains", fromFile: resolve(root, "fixtures/live/white_plains-destinations.json"), clock: wp });
    // Served, as `pnpm real` serves it (seeded areas outside the city start ingest-only).
    await setLaunchState(db, "white_plains", "test");
    return;
  }
  // Just after the captures were made (OSM base 2026-09-27), so their survey dates all count.
  for (const area of ["les", "bronxville"]) await ingestOsmArea(db, { areaSlug: area, fromFile: resolve(root, `fixtures/live/${area}.json`), clock: () => new Date("2026-09-28T12:00:00Z") });
  // Then Overture's read of each (taken 29 Sep): whether places still operate, and the places OSM lacks.
  for (const area of ["les", "bronxville"]) await ingestOverture(db, { areaSlug: area, fromFile: resolve(root, `fixtures/live/${area}-overture.json`), clock: () => new Date("2026-09-29T12:00:00Z") });
  // And the destinations worth a longer outing around Bronxville (read 5 Oct: the records selection reads).
  await ingestDestinations(db, { areaSlug: "bronxville", fromFile: resolve(root, "fixtures/live/bronxville-destinations.json"), clock: () => new Date("2026-09-29T12:00:00Z") });
}

/**
 * Every scenario, each world seeded in turn into the database `open` connects to, in the scenarios'
 * order. A fresh pool per world: re-seeding recreates PostGIS, which a pool's open connections
 * would still know by its old ids.
 */
export async function runAllGolden(open: () => Db, root: string): Promise<GoldenResult[]> {
  const byId = new Map<string, GoldenResult>();
  for (const world of GOLDEN_WORLDS) {
    const db = open();
    try {
      await seedGolden(db, root, world);
      for (const r of await runGolden(db, world)) byId.set(r.id, r);
    } finally {
      await db.end();
    }
  }
  return GOLDEN_SCENARIOS.map((s) => byId.get(s.id)!);
}

/** The scenarios of one world (default: every scenario) against what `db` holds. */
export async function runGolden(db: Db, world?: GoldenWorld): Promise<GoldenResult[]> {
  const out: GoldenResult[] = [];
  for (const s of GOLDEN_SCENARIOS.filter((x) => !world || worldOf(x) === world)) {
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
