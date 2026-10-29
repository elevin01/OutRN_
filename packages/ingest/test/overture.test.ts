import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { testDatabaseAvailable, reset } from "@outrn/db";
import type { Bbox, OvertureCapture, OverturePlace } from "@outrn/sources";
import { setFounderFact } from "../src/founder.js";
import { ingestOverture, overtureReadBox } from "../src/overture.js";
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
  licenses: ["CDLA-Permissive-2.0"],
  ...over,
});
const SIGNAL = { statusSignal: 1, statusUpdatedAt: "2026-06-26T16:25:14.000Z" };
// Beside the synthetic venues of the same names (fixtures/osm/les-synthetic.json).
const GRAND = place({ id: "ovt-grand", name: "Grand Kitchen", lat: 40.72698, lon: -73.99268, ...SIGNAL, websites: ["https://www.instagram.com/grandkitchen", "https://grandkitchen.example.com/"], phones: ["2125550100"] });
const BROOME = place({ id: "ovt-broome", name: "Broome Kitchen NYC", lat: 40.72663, lon: -73.9859, category: "casual_eatery", confidence: 0.85, phones: ["+1 (212) 555-0142"], datasets: ["Microsoft"] });
const HESTER_CLOSED = place({ id: "ovt-hester", name: "Hester Kitchen", lat: 40.7263, lon: -73.9816, status: "permanently_closed", ...SIGNAL });
// Closed by a company register only: no signal.
const ELDRIDGE = place({ id: "ovt-eldridge", name: "Eldridge Kitchen", lat: 40.70605, lon: -73.99103, status: "permanently_closed", datasets: ["BrightQuery"] });
// The same name, 300 m from the venue: another place.
const ESSEX_FAR = place({ id: "ovt-essex", name: "Essex Kitchen", lat: 40.7334, lon: -73.9723, ...SIGNAL });

function capture(name: string, places: unknown[], bbox = LES): string {
  const path = join(DIR, `${name}.json`);
  // unknown[]: the malformed captures below hold what no OverturePlace can.
  const c: Omit<OvertureCapture, "places"> & { places: unknown[] } = { outrn_capture: "overture", release: "2026-09-23.1", bbox, fetchedAt: "2026-09-29T00:00:00.000Z", places };
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
    const hester = await venueId("Hester Kitchen");
    const task = await db.query(`select question, dedupe_key from verification_tasks where subject_id = $1 and attribute = 'business_status'`, [hester]);
    // Its own key: an OSM closure check already answered for the venue would not swallow it.
    expect(task.rows).toEqual([{ question: "Overture Maps now says this place has closed. Has it?", dedupe_key: `venue:${hester}:map_closure` }]);
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

  it("a malformed capture is refused whole before a run starts: nothing dropped, nothing written", async () => {
    await ingestOverture(db, { areaSlug: "les", fromFile: capture("good", [GRAND, BROOME]) });
    const snapshot = async () => ({
      facts: (await db.query(`select id, subject_id, attribute, value, confidence, superseded_at from facts where source_id = 'overture' order by id`)).rows,
      current: (await db.query(`select subject_id, attribute, value, source_ids, confidence from current_facts where subject_id = any($1::uuid[]) order by subject_id, attribute`, [[await venueId("Grand Kitchen"), await venueId("Broome Kitchen")]])).rows,
      runs: (await db.query<{ n: number }>(`select count(*)::int as n from ingestion_runs where source_id = 'overture'`)).rows[0]!.n,
    });
    const before = await snapshot();
    expect(before.facts.length).toBeGreaterThan(0);
    for (const [name, places] of [
      // A phone that is not text crashed the run halfway.
      ["phone", [GRAND, { ...BROOME, phones: [42] }]],
      // "1" read as a signal of 0.9 or more.
      ["signal", [GRAND, { ...BROOME, statusSignal: "1" }]],
      ["date", [{ ...GRAND, statusUpdatedAt: "not a date" }, BROOME]],
      // A place the old loader dropped: its venue would lose its claims as if the place had gone.
      ["lat", [{ ...GRAND, lat: "40.72698" }, BROOME]],
      ["duplicate", [GRAND, BROOME, { ...BROOME, name: "Broome Kitchen Bar" }]],
    ] as const) {
      await expect(ingestOverture(db, { areaSlug: "les", fromFile: capture(`bad-${name}`, [...places]) }), name).rejects.toThrow(/is not a valid Overture capture, so nothing was written/);
      expect(await snapshot(), name).toEqual(before);
    }
  });

  it("a founder's check since Overture's closure keeps the venue listed; one from before does not", async () => {
    const at = async (name: string) => (await db.query<{ lat: number; lon: number }>(`select ST_Y(geom::geometry) as lat, ST_X(geom::geometry) as lon from venues where id = $1`, [await venueId(name)])).rows[0]!;
    const closedBeside = async (id: string, name: string) => place({ id, name, ...(await at(name)), status: "permanently_closed", ...SIGNAL }); // signal of 26 Jun
    const closureTasks = async (name: string) => (await db.query<{ dedupe_key: string }>(`select dedupe_key from verification_tasks where subject_id = $1 and dedupe_key like '%closure'`, [await venueId(name)])).rows.map((r) => r.dedupe_key);
    expect([await state("Norfolk Kitchen"), await state("Orchard Kitchen")]).toEqual(["eligible", "eligible"]);
    const operating = { attribute: "business_status" as const, value: { status: "operating" }, evidence: "called" };
    await setFounderFact(db, { venueId: await venueId("Norfolk Kitchen"), ...operating, verifiedAt: new Date("2026-09-20T18:00:00Z") });
    await setFounderFact(db, { venueId: await venueId("Orchard Kitchen"), ...operating, verifiedAt: new Date("2026-06-01T18:00:00Z") });

    const s = await ingestOverture(db, { areaSlug: "les", fromFile: capture("closures", [await closedBeside("ovt-norfolk", "Norfolk Kitchen"), await closedBeside("ovt-orchard", "Orchard Kitchen")]) });
    expect(s.claims.closed).toBe(2);
    // Checked on 20 Sep, after the 26 Jun signal: the founder's call stands, and nobody is asked again.
    expect(await overtureFacts("Norfolk Kitchen")).toEqual(["business_status"]);
    expect(await state("Norfolk Kitchen")).toBe("eligible");
    expect(await current("Norfolk Kitchen", "business_status")).toMatchObject({ value: { status: "operating" }, source_ids: ["founder"] });
    expect(await closureTasks("Norfolk Kitchen")).toEqual([]);
    // Checked on 1 Jun, before it: the closure is newer, so the venue is delisted and someone asked.
    expect(await state("Orchard Kitchen")).toBe("excluded");
    expect(await current("Orchard Kitchen", "business_status")).toMatchObject({ value: { status: "closed_permanently" }, source_ids: ["overture"] });
    expect(await closureTasks("Orchard Kitchen")).toEqual([`venue:${await venueId("Orchard Kitchen")}:map_closure`]);

    // Overture re-asserts its closure on every run: still nothing changes for the venue checked since.
    await ingestOverture(db, { areaSlug: "les", fromFile: join(DIR, "closures.json") });
    expect(await state("Norfolk Kitchen")).toBe("eligible");
    expect(await closureTasks("Norfolk Kitchen")).toEqual([]);
  });

  it("an undated closure never outranks a founder's check, on the first run or a replay", async () => {
    const at = async (name: string) => (await db.query<{ lat: number; lon: number }>(`select ST_Y(geom::geometry) as lat, ST_X(geom::geometry) as lon from venues where id = $1`, [await venueId(name)])).rows[0]!;
    await setFounderFact(db, { venueId: await venueId("Broome Kitchen"), attribute: "business_status", value: { status: "operating" }, evidence: "called", verifiedAt: new Date("2026-09-20T18:00:00Z") });
    const undated = place({ id: "ovt-broome-undated", name: "Broome Kitchen", ...(await at("Broome Kitchen")), status: "permanently_closed", statusSignal: 1, statusUpdatedAt: null, updatedAt: null });
    for (const run of ["first", "replay"]) {
      const s = await ingestOverture(db, { areaSlug: "les", fromFile: run === "first" ? capture("undated", [undated]) : join(DIR, "undated.json") });
      expect(s.claims.closed, run).toBe(0);
      expect(await state("Broome Kitchen"), run).toBe("eligible");
      expect(await current("Broome Kitchen", "business_status"), run).toMatchObject({ value: { status: "operating" }, source_ids: ["founder"] });
    }
    // Nor one dated after the capture was taken: it would outrank every later check.
    const future = { ...undated, statusUpdatedAt: "2099-01-01T00:00:00.000Z" };
    await expect(ingestOverture(db, { areaSlug: "les", fromFile: capture("future", [future]) })).rejects.toThrow(/after the capture was taken/);
  });

  it("an area whose snapshot holds only places an overlapping area's ingest made them venues of has them for Overture", async () => {
    // White Plains's (synthetic) snapshot of a small circle around Grand Kitchen: the venue is LES's, its record now White Plains's too.
    const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as { elements: Array<{ tags?: Record<string, string>; lat?: number; lon?: number }> };
    const grand = fixture.elements.find((e) => e.tags?.["name"] === "Grand Kitchen")!;
    const path = join(DIR, "white-plains-osm.json");
    writeFileSync(path, JSON.stringify({ elements: [grand], outrn_extent: { lat: grand.lat, lon: grand.lon, radius_m: 30 } }));
    expect((await ingestOsmArea(db, { areaSlug: "white_plains", fromFile: path })).venues.created).toBe(0);
    const s = await ingestOverture(db, { areaSlug: "white_plains", fromFile: capture("white-plains", [GRAND]) });
    expect(s.venues.matched).toBe(1);
    expect(await current("Grand Kitchen", "business_status")).toMatchObject({ value: { status: "operating" }, source_ids: ["overture"] });
  });

});

describe.skipIf(!available)("places OSM lacks, as venues of their own", () => {
  // South of Delancey, 400 m and more from every synthetic venue.
  const GOTAN = place({ id: "ovt-new-gotan", name: "Gotan", category: "coffee_shop", lat: 40.716, lon: -73.987, websites: ["https://www.instagram.com/gotan", "https://gotannyc.example.com/"], phones: ["2125550199"], ...SIGNAL });
  const MOON = place({ id: "ovt-new-moon", name: "Sweet Moon Ice Cream", lat: 40.715, lon: -73.989, phones: ["2125550177"] });
  // Beside Norfolk Bar (40.726726, -73.99412): 5 m off, most likely its storefront under an old name; 15 m off, the bar next door.
  const SAME_SPOT = place({ id: "ovt-new-velvet", name: "Velvet Room", category: "bar", lat: 40.726771, lon: -73.99412, phones: ["2125550166"] });
  const NEXT_DOOR = place({ id: "ovt-new-owl", name: "Night Owl", category: "bar", lat: 40.726861, lon: -73.99412, phones: ["2125550155"] });
  const LEFT_OUT = [
    place({ id: "ovt-new-sbux", name: "Starbucks", category: "coffee_shop", lat: 40.7155, lon: -73.988 }),
    place({ id: "ovt-new-bq", name: "Lucky Orchid Noodles", datasets: ["BrightQuery"], lat: 40.7165, lon: -73.986 }),
    place({ id: "ovt-new-low", name: "Kinfolk Tavern", category: "bar", confidence: 0.7, lat: 40.7145, lon: -73.9875 }),
    place({ id: "ovt-new-cart", name: "Halal Cart Supreme", category: "fast_food_restaurant", lat: 40.7152, lon: -73.9865 }),
    // 66 m from Grand Kitchen, sharing its one distinctive word; and Essex Kitchen's name 300 m from it.
    place({ id: "ovt-new-grand", name: "The Grand Noodle House", lat: 40.7275, lon: -73.99268, phones: ["2125550144"] }),
    // (300 m south of Essex Kitchen: ESSEX_FAR's spot, north of every LES venue, is outside the area's box.)
    { ...ESSEX_FAR, id: "ovt-new-essex", lat: 40.728, phones: ["2125550133"] },
    SAME_SPOT,
    // Nothing to check it by.
    place({ id: "ovt-new-mute", name: "Quiet Lantern", lat: 40.7142, lon: -73.9895 }),
    // Last updated in 2013.
    place({ id: "ovt-new-old", name: "Formerly Crow's", category: "bar", lat: 40.7147, lon: -73.9899, phones: ["2125550122"], updatedAt: "2013-01-29T05:21:15.170Z" }),
  ];
  const venuesNamed = async (name: string) => (await db.query<{ id: string; publish_state: string; category: string }>(`select id, publish_state, category from venues where canonical_name = $1 and publish_state <> 'merged'`, [name])).rows;
  const links = async (name: string) =>
    (
      await db.query<{ source_id: string; external_id: string; decision: string }>(
        `select se.source_id, se.external_id, l.decision from entity_links l join source_entities se on se.id = l.source_entity_id where l.venue_id = $1 and l.superseded_by is null order by se.source_id`,
        [await venueId(name)],
      )
    ).rows;

  it("adds a confident, open, local place no venue could be: Overture its only source, Check first for want of hours", async () => {
    const s = await ingestOverture(db, { areaSlug: "les", fromFile: capture("new", [GRAND, GOTAN, MOON, NEXT_DOOR, ...LEFT_OUT]) });
    expect(s.newPlaces).toMatchObject({ added: 3, kept: 0, removed: 0, possibleDuplicates: 3, skipped: { status: 0, confidence: 1, register: 1, category: 1, name: 0, chain: 1, stale: 1, contact: 1 } });
    expect(s.newPlaces!.examples).toEqual(["Gotan (cafe)", "Sweet Moon Ice Cream (dessert)", "Night Owl (bar)"]);
    // Grand Kitchen's own place still only speaks for Grand Kitchen.
    expect(await venuesNamed("Grand Kitchen")).toHaveLength(1);

    expect(await venuesNamed("Gotan")).toMatchObject([{ publish_state: "eligible", category: "cafe" }]);
    expect(await links("Gotan")).toEqual([{ source_id: "overture", external_id: "ovt-new-gotan", decision: "auto" }]);
    expect(await current("Gotan", "name")).toMatchObject({ value: { value: "Gotan" }, source_ids: ["overture"] });
    expect(await current("Gotan", "business_status")).toMatchObject({ value: { status: "operating" }, confidence: "0.750" });
    expect(await current("Gotan", "website")).toMatchObject({ value: { value: "https://gotannyc.example.com/" } });
    expect(await current("Gotan", "phone")).toMatchObject({ value: { value: "+1 212-555-0199" } });
    expect(await current("Gotan", "admission")).toMatchObject({ value: { requirement: "walk_in" } });
    // No hours: the engine can only ever say Check first.
    expect(await current("Gotan", "opening_hours")).toBeUndefined();
    // Overture files the ice cream parlor as a restaurant; its name says what it is.
    expect(await venuesNamed("Sweet Moon Ice Cream")).toMatchObject([{ category: "dessert" }]);
    for (const p of LEFT_OUT.filter((x) => x.name !== "Essex Kitchen")) expect(await venuesNamed(p.name), p.name).toEqual([]);
    // The bar next door is its own place; the one on Norfolk Bar's spot is not.
    expect(await venuesNamed("Night Owl")).toMatchObject([{ publish_state: "eligible", category: "bar" }]);
    expect(await venuesNamed("Essex Kitchen")).toHaveLength(1);
    // A place left out keeps no record.
    expect((await db.query(`select 1 from source_entities where source_id = 'overture' and external_id = 'ovt-new-grand'`)).rowCount).toBe(0);
    const run = await db.query(`select counts->>'new_places_added' as added from ingestion_runs where id = $1`, [s.runId]);
    expect(run.rows).toEqual([{ added: "3" }]);
  });

  it("replaying the same read adds nothing and changes nothing", async () => {
    const s = await ingestOverture(db, { areaSlug: "les", fromFile: join(DIR, "new.json") });
    expect(s.newPlaces).toMatchObject({ added: 0, kept: 3, removed: 0 });
    expect(s.facts).toEqual({ inserted: 0, superseded: 0, rejected: 0 });
    expect(await venuesNamed("Gotan")).toHaveLength(1);
  });

  it("a read without it takes it down; a later read with it lists it again", async () => {
    const without = await ingestOverture(db, { areaSlug: "les", fromFile: capture("without-gotan", [GRAND, MOON, NEXT_DOOR]) });
    expect(without.newPlaces).toMatchObject({ added: 0, kept: 2, removed: 1 });
    expect(await venuesNamed("Gotan")).toMatchObject([{ publish_state: "candidate" }]);
    expect(await current("Gotan", "name")).toBeUndefined();
    expect((await db.query(`select deleted_at is not null as gone from source_entities where source_id = 'overture' and external_id = 'ovt-new-gotan'`)).rows).toEqual([{ gone: true }]);

    const back = await ingestOverture(db, { areaSlug: "les", fromFile: join(DIR, "new.json") });
    expect(back.newPlaces).toMatchObject({ added: 0, kept: 3, removed: 0 });
    expect(await venuesNamed("Gotan")).toMatchObject([{ publish_state: "eligible" }]);
    expect((await db.query(`select deleted_at is null as back from source_entities where source_id = 'overture' and external_id = 'ovt-new-gotan'`)).rows).toEqual([{ back: true }]);
  });

  it("when OSM maps the place, OSM's record joins the same venue and Overture only confirms it: no second card", async () => {
    const osm = JSON.parse(readFileSync(FIXTURE, "utf8")) as { elements: unknown[] };
    const node = { type: "node", id: 990001, tags: { name: "Gotan", amenity: "cafe", opening_hours: "Mo-Su 08:00-18:00" }, timestamp: "2026-09-20T00:00:00.000Z", version: 1, lat: GOTAN.lat, lon: GOTAN.lon };
    const withGotan = join(DIR, "les-with-gotan.json");
    writeFileSync(withGotan, JSON.stringify({ ...osm, elements: [...osm.elements, node] }));
    await ingestOsmArea(db, { areaSlug: "les", fromFile: withGotan });
    expect(await venuesNamed("Gotan")).toHaveLength(1);
    expect((await links("Gotan")).map((l) => l.source_id)).toEqual(["osm", "overture"]);
    expect(await current("Gotan", "opening_hours")).toMatchObject({ source_ids: ["osm"] });

    const s = await ingestOverture(db, { areaSlug: "les", fromFile: join(DIR, "new.json") });
    expect(s.newPlaces).toMatchObject({ added: 0, kept: 2, removed: 0 });
    expect(await venuesNamed("Gotan")).toMatchObject([{ publish_state: "eligible" }]);
    // Now a venue like any other: Overture's status and the contact details OSM lacks; OSM's name and kind.
    expect(await overtureFacts("Gotan")).toEqual(["business_status", "phone", "website"]);
    expect(await current("Gotan", "name")).toMatchObject({ source_ids: ["osm"] });
  });

  it("--no-new-places checks existing venues only", async () => {
    const s = await ingestOverture(db, { areaSlug: "les", newPlaces: false, fromFile: capture("no-new", [GRAND, place({ id: "ovt-new-kafana", name: "Kafana", lat: 40.7148, lon: -73.9902, phones: ["2125550111"] })]) });
    expect(s.newPlaces).toBeNull();
    expect(await venuesNamed("Kafana")).toEqual([]);
  });

  it("a place added at the edge of a live read never widens the next one", async () => {
    const box = await overtureReadBox(db, "les");
    // In the box's north-east corner, far from every venue: added.
    const edge = place({ id: "ovt-new-edge", name: "Edge Lantern Bar", category: "bar", lat: box.north - 1e-5, lon: box.east - 1e-5, phones: ["2125550188"] });
    const s = await ingestOverture(db, { areaSlug: "les", fromFile: capture("edge", [edge], box) });
    expect(s.newPlaces).toMatchObject({ added: 1 });
    expect(await venuesNamed("Edge Lantern Bar")).toMatchObject([{ publish_state: "eligible" }]);
    // The next live read covers the same box: Overture's own venues are not where it reads.
    expect(await overtureReadBox(db, "les")).toEqual(box);
  });

  it("a place beyond its read's box or the area's own is never made a venue of this area", async () => {
    const box = await overtureReadBox(db, "les");
    // Inside the capture's (wide) box but north-east of every LES venue; and one outside the capture's own box.
    const beyondArea = place({ id: "ovt-new-far1", name: "Far Hollow Cafe", category: "coffee_shop", lat: box.north + 0.01, lon: box.east + 0.002, phones: ["2125550191"] });
    const beyondCapture = place({ id: "ovt-new-far2", name: "Albany Lantern", category: "bar", lat: 42.6526, lon: -73.7562, phones: ["5185550191"] });
    const s = await ingestOverture(db, { areaSlug: "les", fromFile: capture("far", [beyondArea, beyondCapture]) });
    expect(s.newPlaces).toMatchObject({ added: 0, skipped: { outside: 2 } });
    expect(await venuesNamed("Far Hollow Cafe")).toEqual([]);
    expect(await venuesNamed("Albany Lantern")).toEqual([]);
  });

  it("the website and phone Overture lists are no evidence that another place is the venue made from it", async () => {
    // Lumen Tea, from Overture, lists an Instagram profile and the building's phone.
    const lumen = place({ id: "ovt-new-lumen", name: "Lumen Tea", category: "coffee_shop", lat: 40.712, lon: -73.984, websites: ["https://www.instagram.com/lumentea"], phones: ["2125550123"] });
    expect((await ingestOverture(db, { areaSlug: "les", fromFile: capture("lumen", [lumen]) })).newPlaces?.added).toBe(1);
    // OSM maps the bakery next door (10 m): another place, its own Instagram, the same building phone.
    const osm = JSON.parse(readFileSync(join(DIR, "les-with-gotan.json"), "utf8")) as { elements: unknown[] };
    const bakery = { type: "node", id: 990002, tags: { name: "Lumen Bakery", amenity: "cafe", website: "https://www.instagram.com/lumenbakery", phone: "+1 212 555 0123" }, timestamp: "2026-09-20T00:00:00.000Z", version: 1, lat: 40.71209, lon: -73.984 };
    const withBakery = join(DIR, "les-with-bakery.json");
    writeFileSync(withBakery, JSON.stringify({ ...osm, elements: [...osm.elements, bakery] }));
    await ingestOsmArea(db, { areaSlug: "les", fromFile: withBakery });
    // Two cards: the bakery is not filed under the tea room on the strength of what Overture lists.
    expect(await venuesNamed("Lumen Bakery")).toHaveLength(1);
    expect((await links("Lumen Bakery")).map((l) => l.source_id)).toEqual(["osm"]);
    expect(await venuesNamed("Lumen Tea")).toHaveLength(1);
    expect((await links("Lumen Tea")).map((l) => l.source_id)).toEqual(["overture"]);
  });
});

// Runs after the rest: a newer release's read holds what it spoke for against every older read after it.
describe.skipIf(!available)("an older Overture release never undoes a newer one", () => {
  /** A capture of the given release (capture() writes the default, 2026-09-23.1). */
  const ofRelease = (name: string, places: unknown[], release: string, bbox = LES) => {
    const path = capture(name, places, bbox);
    writeFileSync(path, readFileSync(path, "utf8").replace('"release":"2026-09-23.1"', `"release":"${release}"`));
    return path;
  };

  it("an older read for an overlapping area neither rewrites nor withdraws a newer read's claims", async () => {
    // LES's read of a later release sees Grand Kitchen closed; White Plains' snapshot holds the venue too.
    const closed = place({ id: "ovt-grand", name: "Grand Kitchen", lat: 40.72698, lon: -73.99268, status: "permanently_closed", statusSignal: 1, statusUpdatedAt: "2026-09-20T00:00:00.000Z", updatedAt: "2026-09-20T00:00:00.000Z" });
    const later = ofRelease("les-later", [closed], "2026-10-14.0");
    await ingestOverture(db, { areaSlug: "les", fromFile: later, newPlaces: false });
    expect((await current("Grand Kitchen", "business_status"))?.value).toEqual({ status: "closed_permanently" });
    // White Plains' capture of the earlier release still has it open, with a website.
    await ingestOverture(db, { areaSlug: "white_plains", fromFile: capture("white-plains-older", [GRAND]), newPlaces: false });
    expect((await current("Grand Kitchen", "business_status"))?.value).toEqual({ status: "closed_permanently" });
    // A read of the same or a later release still speaks for it.
    await ingestOverture(db, { areaSlug: "white_plains", fromFile: later, newPlaces: false });
    expect((await current("Grand Kitchen", "business_status"))?.value).toEqual({ status: "closed_permanently" });
  });

  it("nor brings back the claims of a place a newer read no longer has", async () => {
    // LES's read of a still later release has no Grand Kitchen at all: its Overture claims go.
    await ingestOverture(db, { areaSlug: "les", fromFile: ofRelease("les-gone", [BROOME], "2026-10-20.0"), newPlaces: false });
    expect(await overtureFacts("Grand Kitchen")).toEqual([]);
    // White Plains' capture of the earlier release still lists it, open with a website: not put back.
    await ingestOverture(db, { areaSlug: "white_plains", fromFile: capture("white-plains-older-2", [GRAND]), newPlaces: false });
    expect(await overtureFacts("Grand Kitchen")).toEqual([]);
    expect(await current("Grand Kitchen", "website")).toBeUndefined();
  });

  it("nor revives a venue made from a place a newer read took down", async () => {
    // A place only Overture has, south of Delancey: LES's read of the earlier release makes it a venue.
    const mochi = place({ id: "ovt-new-mochi", name: "Mochi Corner", category: "coffee_shop", lat: 40.713, lon: -73.991, websites: ["https://mochicorner.example.com/"], phones: ["2125550112"], ...SIGNAL });
    expect((await ingestOverture(db, { areaSlug: "les", fromFile: capture("les-mochi", [mochi]) })).newPlaces?.added).toBe(1);
    expect(await overtureFacts("Mochi Corner")).not.toEqual([]);
    // LES's read of a newer release sees it closed: the venue made from it is taken down.
    const s = await ingestOverture(db, { areaSlug: "les", fromFile: ofRelease("les-mochi-closed", [{ ...mochi, status: "permanently_closed" }, BROOME], "2026-10-25.0") });
    expect(s.newPlaces?.removed).toBe(1);
    expect(await overtureFacts("Mochi Corner")).toEqual([]);
    // White Plains reads the earlier release over the same streets, where it is open: it stays down.
    const older = await ingestOverture(db, { areaSlug: "white_plains", fromFile: capture("white-plains-mochi", [mochi]) });
    expect(older.newPlaces).toMatchObject({ added: 0, kept: 0, removed: 0 });
    expect(await overtureFacts("Mochi Corner")).toEqual([]);
  });

  it("a newer read keeps what it spoke for after its own area stops holding the venue", async () => {
    // Bronxville's (synthetic) snapshot holds two LES bars as well: Norfolk Bar and Broome Bar.
    const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as { elements: Array<{ id: number; tags?: Record<string, string>; lat?: number; lon?: number }> };
    const pair = fixture.elements.filter((e) => e.tags?.["name"] === "Norfolk Bar" || e.tags?.["name"] === "Broome Bar");
    const both = join(DIR, "bronxville-osm.json");
    writeFileSync(both, JSON.stringify({ elements: pair, outrn_extent: { lat: 40.72694, lon: -73.99354, radius_m: 80 } }));
    expect((await ingestOsmArea(db, { areaSlug: "bronxville", fromFile: both })).venues.created).toBe(0);
    const at = (name: string) => pair.find((e) => e.tags?.["name"] === name)!;
    const norfolk = place({ id: "ovt-norfolk", name: "Norfolk Bar", category: "bar", lat: at("Norfolk Bar").lat!, lon: at("Norfolk Bar").lon!, ...SIGNAL });
    const broome = place({ id: "ovt-broome-bar", name: "Broome Bar", category: "bar", lat: at("Broome Bar").lat!, lon: at("Broome Bar").lon!, ...SIGNAL });
    const closed = { ...norfolk, status: "permanently_closed", statusSignal: 1, statusUpdatedAt: "2026-09-20T00:00:00.000Z", updatedAt: "2026-09-20T00:00:00.000Z" };
    // LES reads newer releases: Norfolk Bar closed; then Broome Bar gone from Overture, its claims withdrawn.
    await ingestOverture(db, { areaSlug: "les", fromFile: ofRelease("les-norfolk", [closed, broome], "2026-11-05.0"), newPlaces: false });
    await ingestOverture(db, { areaSlug: "les", fromFile: ofRelease("les-norfolk-2", [closed], "2026-11-06.0"), newPlaces: false });
    expect((await current("Norfolk Bar", "business_status"))?.value).toEqual({ status: "closed_permanently" });
    expect(await overtureFacts("Broome Bar")).toEqual([]);
    // LES's next OSM snapshot no longer holds either bar; Bronxville's still does, so both stay venues.
    const les = JSON.parse(readFileSync(join(DIR, "les-with-bakery.json"), "utf8")) as { elements: Array<{ id: number }> };
    const without = join(DIR, "les-without-bars.json");
    writeFileSync(without, JSON.stringify({ ...les, elements: les.elements.filter((e) => !pair.some((x) => x.id === e.id)) }));
    await ingestOsmArea(db, { areaSlug: "les", fromFile: without });
    // Bronxville replays the earlier release, where both are open: neither the closure nor the withdrawal is undone.
    await ingestOverture(db, { areaSlug: "bronxville", fromFile: capture("bronxville-bars-older", [norfolk, broome]), newPlaces: false });
    expect((await current("Norfolk Bar", "business_status"))?.value).toEqual({ status: "closed_permanently" });
    expect(await overtureFacts("Broome Bar")).toEqual([]);
  });
});
