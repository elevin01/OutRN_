import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { testDatabaseAvailable, reset } from "@outrn/db";
import type { Bbox, OvertureCapture, OverturePlace } from "@outrn/sources";
import { ingestOverture } from "../src/overture.js";
import { ingestOsmArea } from "../src/pipeline.js";

/** Overture places against the synthetic LES venues, on a real Postgres + PostGIS (outrn_test, reset per file). */

const BASE = process.env["DATABASE_URL"] ?? "postgres://outrn@127.0.0.1:54329/outrn";
const TEST_URL = BASE.replace(/\/[^/]+$/, "/outrn_test");
const FIXTURE = resolve(__dirname, "../../../fixtures/osm/les-synthetic.json");
const DIR = mkdtempSync(join(tmpdir(), "outrn-overture-"));
const LES: Bbox = { west: -74.02, south: 40.69, east: -73.96, north: 40.75 };

let db: pg.Pool;
const available = await testDatabaseAvailable(BASE);

beforeAll(async () => {
  if (!available) return;
  const admin = new pg.Pool({ connectionString: BASE });
  try {
    const exists = await admin.query("select 1 from pg_database where datname = 'outrn_test'");
    if (!exists.rowCount) await admin.query("create database outrn_test");
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

const place = (over: Partial<OverturePlace> & Pick<OverturePlace, "id" | "name" | "lat" | "lon">): OverturePlace => ({
  category: "restaurant",
  status: "open",
  statusSignal: null,
  statusUpdatedAt: null,
  confidence: 0.9,
  websites: [],
  phones: [],
  updatedAt: "2026-09-01T00:00:00.000Z",
  datasets: ["meta"],
  ...over,
});
const SIGNAL = { statusSignal: 1, statusUpdatedAt: "2026-06-26T16:25:14.000Z" };
// Beside the synthetic venues of the same names (fixtures/osm/les-synthetic.json).
const GRAND = place({ id: "ovt-grand", name: "Grand Kitchen", lat: 40.72698, lon: -73.99268, ...SIGNAL, websites: ["https://www.instagram.com/grandkitchen", "https://grandkitchen.example.com/"], phones: ["2125550100"] });
const BROOME = place({ id: "ovt-broome", name: "Broome Kitchen NYC", lat: 40.72663, lon: -73.9859, category: "casual_eatery", confidence: 0.85, phones: ["+1 (212) 555-0142"], datasets: ["Foursquare"] });
const HESTER_CLOSED = place({ id: "ovt-hester", name: "Hester Kitchen", lat: 40.7263, lon: -73.9816, status: "permanently_closed", ...SIGNAL });
// Closed by a company register only: no signal.
const ELDRIDGE = place({ id: "ovt-eldridge", name: "Eldridge Kitchen", lat: 40.70605, lon: -73.99103, status: "permanently_closed", datasets: ["BrightQuery"] });
// The same name, 300 m from the venue: another place.
const ESSEX_FAR = place({ id: "ovt-essex", name: "Essex Kitchen", lat: 40.7334, lon: -73.9723, ...SIGNAL });

function capture(name: string, places: OverturePlace[], bbox = LES): string {
  const path = join(DIR, `${name}.json`);
  const c: OvertureCapture = { outrn_capture: "overture", release: "2026-09-23.1", bbox, fetchedAt: "2026-09-29T00:00:00.000Z", places };
  writeFileSync(path, JSON.stringify(c));
  return path;
}

const venueId = async (name: string) => (await db.query<{ id: string }>(`select id from venues where canonical_name = $1 and publish_state <> 'merged'`, [name])).rows[0]!.id;
const current = async (name: string, attribute: string) =>
  (await db.query<{ value: Record<string, unknown>; source_ids: string[]; confidence: string }>(`select value, source_ids, confidence from current_facts where subject_kind = 'venue' and subject_id = $1 and attribute = $2`, [await venueId(name), attribute])).rows[0];
const state = async (name: string) => (await db.query<{ publish_state: string }>(`select publish_state from venues where id = $1`, [await venueId(name)])).rows[0]!.publish_state;
const overtureFacts = async (name: string) =>
  (await db.query<{ attribute: string }>(`select attribute from facts where subject_id = $1 and source_id = 'overture' and superseded_at is null order by attribute`, [await venueId(name)])).rows.map((r) => r.attribute);

describe.skipIf(!available)("Overture places on the synthetic LES venues", () => {
  it("confirms what is operating, closes only on Overture's signal, and fills contact details other sources lack", async () => {
    const s = await ingestOverture(db, { areaSlug: "les", fromFile: capture("first", [GRAND, BROOME, HESTER_CLOSED, ELDRIDGE, ESSEX_FAR]) });
    expect(s.release).toBe("2026-09-23.1");
    expect(s.venues.matched).toBe(4);
    expect(s.claims).toEqual({ operating: 2, closed: 1, website: 1, phone: 1 });
    expect(s.facts.rejected).toBe(0);

    expect(await current("Grand Kitchen", "business_status")).toMatchObject({ value: { status: "operating" }, source_ids: ["overture"], confidence: "0.750" });
    // Its own site, not the social profile listed first; OSM already has its phone.
    expect(await current("Grand Kitchen", "website")).toMatchObject({ value: { value: "https://grandkitchen.example.com/" }, source_ids: ["overture"] });
    expect((await current("Grand Kitchen", "phone"))?.source_ids).toEqual(["osm"]);
    expect(await current("Broome Kitchen", "business_status")).toMatchObject({ value: { status: "operating" }, confidence: "0.600" });
    expect(await current("Broome Kitchen", "phone")).toMatchObject({ value: { value: "+1 212-555-0142" }, source_ids: ["overture"] });

    // Closed on the signal: delisted, and someone is asked to confirm it.
    expect(await state("Hester Kitchen")).toBe("excluded");
    const task = await db.query(`select question from verification_tasks where subject_id = $1 and attribute = 'business_status'`, [await venueId("Hester Kitchen")]);
    expect(task.rows).toEqual([{ question: "Overture Maps now says this place has closed. Has it?" }]);
    // A company register's closure changes nothing; a same-name place 300 m off is not the venue.
    expect(await state("Eldridge Kitchen")).toBe("eligible");
    expect(await overtureFacts("Eldridge Kitchen")).toEqual([]);
    expect(await overtureFacts("Essex Kitchen")).toEqual([]);

    const run = await db.query(`select source_id, status, kind, params->>'release' as release, counts->>'venues_matched' as matched from ingestion_runs where id = $1`, [s.runId]);
    expect(run.rows).toEqual([{ source_id: "overture", status: "succeeded", kind: "replay", release: "2026-09-23.1", matched: "4" }]);
  });

  it("replaying the same read changes nothing", async () => {
    const s = await ingestOverture(db, { areaSlug: "les", fromFile: join(DIR, "first.json") });
    expect(s.facts).toEqual({ inserted: 0, superseded: 0, rejected: 0 });
    expect(s.materialized.subjects).toBe(0);
  });

  it("a place gone from Overture takes its claims along; a reopened one relists the venue", async () => {
    const HESTER_OPEN = { ...HESTER_CLOSED, status: "open" };
    const s = await ingestOverture(db, { areaSlug: "les", fromFile: capture("second", [BROOME, HESTER_OPEN]) });
    expect(s.claims).toEqual({ operating: 2, closed: 0, website: 0, phone: 1 });
    expect(await overtureFacts("Grand Kitchen")).toEqual([]);
    expect(await current("Grand Kitchen", "website")).toBeUndefined();
    expect(await state("Hester Kitchen")).toBe("eligible");
    expect(await current("Hester Kitchen", "business_status")).toMatchObject({ value: { status: "operating" }, source_ids: ["overture"] });
  });

  it("venues outside a read's box keep what an earlier read said", async () => {
    // Around Hester Kitchen, east of Broome Kitchen, with no places in it.
    const s = await ingestOverture(db, { areaSlug: "les", fromFile: capture("east", [], { west: -73.9845, south: 40.7, east: -73.96, north: 40.74 }) });
    expect(s.venues.considered).toBeGreaterThan(0);
    expect(await overtureFacts("Hester Kitchen")).toEqual([]);
    expect(await overtureFacts("Broome Kitchen")).toEqual(["business_status", "phone"]);
  });

  it("needs the area's venues first, and a capture that is one", async () => {
    await expect(ingestOverture(db, { areaSlug: "yonkers", fromFile: join(DIR, "first.json") })).rejects.toThrow(/ingest it from OSM first/);
    writeFileSync(join(DIR, "osm.json"), JSON.stringify({ elements: [] }));
    await expect(ingestOverture(db, { areaSlug: "les", fromFile: join(DIR, "osm.json") })).rejects.toThrow(/not an Overture capture/);
    await expect(ingestOverture(db, { areaSlug: "les", fromFile: join(DIR, "first.json"), release: "2026-08-20.0" })).rejects.toThrow(/is release 2026-09-23.1/);
  });
});
