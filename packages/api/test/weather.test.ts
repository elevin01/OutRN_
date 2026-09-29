import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import type { RecommendationRequest } from "@outrn/contracts";
import { reset, testDatabaseAvailable } from "@outrn/db";
import { ingestOsmArea, refreshWeather } from "@outrn/ingest";
import { toItem } from "../src/map/item.js";
import { runEngine, search } from "../src/service/recommendations.js";

/** Stored NWS forecasts shaping recommendations, on the synthetic LES fixture (outrn_test, reset per file). */

const BASE = process.env["DATABASE_URL"] ?? "postgres://outrn@127.0.0.1:54329/outrn";
const TEST_URL = BASE.replace(/\/[^/]+$/, "/outrn_test");
const FIXTURE = resolve(__dirname, "../../../fixtures/osm/les-synthetic.json");
// Saturday 3 Oct, noon to 8pm in New York, issued 15:30Z: clear at noon, showers 2pm to 5pm.
const FORECAST = resolve(__dirname, "../../../fixtures/nws/les-hourly-sample.json");
const NWS_CREDIT = "NOAA / National Weather Service";
const OUTDOOR = new Set(["park", "garden", "waterfront", "viewpoint"]);

let db: pg.Pool;
const available = await testDatabaseAvailable(BASE);

beforeAll(async () => {
  if (!available) return;
  const admin = new pg.Pool({ connectionString: BASE });
  try {
    if (!(await admin.query("select 1 from pg_database where datname = 'outrn_test'")).rowCount) await admin.query("create database outrn_test");
  } finally {
    await admin.end();
  }
  db = new pg.Pool({ connectionString: TEST_URL });
  await db.query("create extension if not exists postgis; create extension if not exists pgcrypto;");
  await reset(db);
  await ingestOsmArea(db, { areaSlug: "les", fromFile: FIXTURE });
});

afterAll(async () => {
  if (db) await db.end();
});

const request: RecommendationRequest = { areaId: "les", windowMinutes: 120 };
const at = (iso: string) => () => new Date(iso);
/** Where the first outdoor place comes in the whole ordered list. */
async function firstOutdoor(clock: () => Date, req = request) {
  const run = await runEngine(db, req, { clock, persist: false });
  return { rank: run.shortlist.ordered.findIndex((e) => OUTDOOR.has(e.candidate.category)), weather: run.ctx.weather ?? null, run };
}

describe.skipIf(!available)("weather from the National Weather Service", () => {
  let dry: number;

  it("with no forecast stored, plans ignore the weather and credit no one for it", async () => {
    const r = await firstOutdoor(at("2026-10-03T18:00:00Z"));
    expect(r.weather).toBeNull();
    expect(r.rank).toBeGreaterThanOrEqual(0);
    dry = r.rank;
    expect((await search(db, request, { clock: at("2026-10-03T18:00:00Z") })).attributions).not.toContain(NWS_CREDIT);
  });

  it("a stored forecast of showers sinks outdoor places, and is credited", async () => {
    const [stored] = await refreshWeather(db, { areaSlug: "les", fromFile: FORECAST });
    expect(stored).toMatchObject({ area: "les", hours: 8, issuedAt: new Date("2026-10-03T15:30:12Z") });
    const r = await firstOutdoor(at("2026-10-03T18:00:00Z"));
    // 2pm to 4pm: the 55% and 80% hours.
    expect(r.weather).toMatchObject({ temperatureF: 61, precipProbability: 80 });
    expect(r.rank).toBeGreaterThan(dry);
    expect((await search(db, request, { clock: at("2026-10-03T18:00:00Z") })).attributions).toContain(NWS_CREDIT);
  });

  it("the card says it: an outdoor place in the showers is Check first with the chance and the hours", async () => {
    // Over the whole ordered list, as the API maps it: the showers sink outdoor places off the first page.
    const run = await runEngine(db, { ...request, windowMinutes: 180 }, { clock: at("2026-10-03T18:00:00Z"), persist: false });
    const all = run.shortlist.ordered.map((e) => toItem(e, run.ctx));
    const outdoor = all.filter((i) => OUTDOOR.has(i.category.id));
    expect(outdoor.length).toBeGreaterThan(0);
    for (const item of outdoor) {
      expect(item.status).toBe("check_first");
      expect(item.conditions.find((c) => c.kind === "weather")).toMatchObject({ level: "rain", basis: "forecast", isEstimate: true, text: "80% chance of rain between 2 and 4pm" });
      expect(item.caveats).toContainEqual({ code: "RAIN_LIKELY", text: "80% chance of rain between 2 and 4pm", params: { chance: 80 }, required: true });
      expect(item.copy.caveat).toContain("80% chance of rain between 2 and 4pm");
    }
    // Indoors, the weather is not a caveat.
    expect(all.filter((i) => !OUTDOOR.has(i.category.id)).every((i) => !i.caveats.some((c) => c.code === "RAIN_LIKELY") && !i.conditions.some((c) => c.kind === "weather"))).toBe(true);
  });

  it("dry at noon: outdoor places are good for it", async () => {
    const r = await firstOutdoor(at("2026-10-03T16:00:00Z"), { ...request, windowMinutes: 60 });
    expect(r.weather).toMatchObject({ temperatureF: 58, precipProbability: 10 });
    const outdoor = r.run.shortlist.ordered.filter((e) => OUTDOOR.has(e.candidate.category));
    expect(outdoor.length).toBeGreaterThan(0);
    expect(outdoor.every((e) => e.reasons.includes("WEATHER_SUITABLE"))).toBe(true);
    // Noon to 1pm: dry, 58°F.
    expect(outdoor.every((e) => e.timing!.conditions.find((c) => c.kind === "weather")?.text === "Dry between 12 and 1pm, 58°F")).toBe(true);
  });

  it("a forecast over 12 hours old, or one that does not reach the plan, is not used", async () => {
    // Planning for 3pm, asked at 4am the next day: the 15:30Z forecast is 12.5 hours old.
    const stale = await runEngine(db, { ...request, at: "2026-10-03T19:00:00Z" }, { clock: at("2026-10-04T04:00:00Z"), persist: false });
    expect(stale.ctx.weather ?? null).toBeNull();
    expect((await firstOutdoor(at("2026-10-04T02:00:00Z"))).weather).toBeNull();
  });

  it("a bad forecast fails its run and keeps the last good one; a file needs an area", async () => {
    const dir = mkdtempSync(join(tmpdir(), "outrn-weather-"));
    writeFileSync(join(dir, "bad.json"), JSON.stringify({ properties: { periods: [] } }));
    await expect(refreshWeather(db, { areaSlug: "les", fromFile: join(dir, "bad.json") })).rejects.toThrow(/les: the forecast has no hours/);
    const run = await db.query(`select status from ingestion_runs where source_id = 'nws' order by started_at desc limit 1`);
    expect(run.rows).toEqual([{ status: "failed" }]);
    expect((await firstOutdoor(at("2026-10-03T18:00:00Z"))).weather?.precipProbability).toBe(80);
    await expect(refreshWeather(db, { fromFile: FORECAST })).rejects.toThrow(/need --area/);
  });
});
