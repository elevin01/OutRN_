import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { reset, testDatabaseAvailable } from "@outrn/db";
import { ingestDestinations } from "../src/destinations.js";
import { addFounderVenue } from "../src/founder.js";
import { ingestOverture } from "../src/overture.js";
import { ingestOsmArea } from "../src/pipeline.js";

/** Destinations around Bronxville, replayed from the committed read, against a real Postgres + PostGIS (outrn_test). */

const BASE = process.env["DATABASE_URL"] ?? "postgres://outrn@127.0.0.1:54329/outrn";
const TEST_URL = BASE.replace(/\/[^/]+$/, "/outrn_test");
const OSM = resolve(__dirname, "../../../fixtures/live/bronxville.json");
const READ = resolve(__dirname, "../../../fixtures/live/bronxville-destinations.json");
const OVERTURE = resolve(__dirname, "../../../fixtures/live/bronxville-overture.json");
const NOW = new Date("2026-10-05T12:00:00Z");

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
  await ingestOsmArea(db, { areaSlug: "bronxville", fromFile: OSM, clock: () => new Date("2026-09-28T12:00:00Z") });
});

afterAll(async () => {
  if (db) await db.end();
});

const venueNamed = async (name: string) =>
  (await db.query<{ id: string; category: string; publish_state: string; destination: { kind: string; note?: string } | null }>(`select id, category, publish_state, facts_doc->'destination'->'value' as destination from venues where canonical_name = $1 and publish_state <> 'merged'`, [name])).rows;
const replay = (fromFile = READ) => ingestDestinations(db, { areaSlug: "bronxville", fromFile, clock: () => NOW });

describe.skipIf(!available)("destinations around an area", () => {
  it("makes venues of the curated places and the records that say what they are, under the list's names", async () => {
    // A venue another source already has is the destination, not a second one.
    const founder = await addFounderVenue(db, { name: "Twin Lakes County Park", category: "park", point: { lat: 40.9476, lon: -73.8024 }, evidence: "walked it", areaSlug: "bronxville" });
    const s = await replay();
    expect(s.destinations.curated).toBeGreaterThanOrEqual(30);
    expect(s.destinations.gated).toBeGreaterThan(10);
    expect(s.venues.existing).toBe(1);
    expect(s.venues.added).toBeGreaterThan(60);

    const twinLakes = await venueNamed("Twin Lakes County Park");
    expect(twinLakes).toHaveLength(1);
    expect(twinLakes[0]).toMatchObject({ id: founder.venueId, destination: { kind: "nature", note: "lakes and woodland trails" } });
    // Overture files it "Untermyer Gardens Conservancy" (twice, one misplaced): the list's name, at the right one.
    const untermyer = await venueNamed("Untermyer Gardens");
    expect(untermyer).toHaveLength(1);
    expect(untermyer[0]).toMatchObject({ category: "garden", publish_state: "eligible", destination: { kind: "garden" } });
    expect((await venueNamed("Untermyer Gardens Conservancy")).length).toBe(0);
    const point = (await db.query<{ lat: number }>(`select ST_Y(geom::geometry) as lat from venues where id = $1`, [untermyer[0]!.id])).rows[0]!;
    expect(point.lat).toBeCloseTo(40.966, 2);
    // A record that says what it is, with its kind and no note.
    expect((await venueNamed("Lenoir Preserve"))[0]).toMatchObject({ category: "park", destination: { kind: "nature" } });
    // Walk-in and free for the list's places, whose access was checked; a record alone says nothing of it.
    const access = async (name: string) =>
      (await db.query<{ attribute: string }>(`select attribute from current_facts where subject_kind = 'venue' and subject_id = $1 and attribute in ('admission', 'price') order by attribute`, [(await venueNamed(name))[0]!.id])).rows.map((r) => r.attribute);
    expect(await access("Saxon Woods Park")).toEqual(["admission", "price"]);
    expect((await venueNamed("Rye Nature Center"))[0]).toMatchObject({ category: "park", destination: { kind: "nature" } });
    expect(await access("Rye Nature Center")).toEqual([]);
  });

  it("is idempotent: the same read again adds, removes and rewrites nothing", async () => {
    const s = await replay();
    expect(s.venues).toMatchObject({ added: 0, removed: 0 });
    expect(s.facts.inserted).toBe(0);
  });

  it("is left alone by the area's Overture read, which neither refreshes nor withdraws a venue made for a destination", async () => {
    const [untermyer] = await venueNamed("Untermyer Gardens");
    const overtureFacts = async () =>
      (await db.query<{ attribute: string }>(`select attribute from facts where subject_kind = 'venue' and subject_id = $1 and source_id = 'overture' and superseded_at is null order by attribute`, [untermyer!.id])).rows.map((r) => r.attribute);
    const before = await overtureFacts();
    expect(before).toContain("name");
    // The area's read reaches as far as its venues do: with OSM's full reach, out past Untermyer.
    const read = JSON.parse(readFileSync(OVERTURE, "utf8")) as { bbox: object };
    read.bbox = { west: -73.92, south: 40.9, east: -73.76, north: 41.0 };
    const path = join(mkdtempSync(join(tmpdir(), "outrn-dest-")), "overture.json");
    writeFileSync(path, JSON.stringify(read));
    await ingestOverture(db, { areaSlug: "bronxville", fromFile: path, clock: () => NOW });
    expect(await overtureFacts()).toEqual(before);
    const deleted = await db.query(`select 1 from source_entities se join entity_links l on l.source_entity_id = se.id where l.venue_id = $1 and se.deleted_at is not null`, [untermyer!.id]);
    expect(deleted.rowCount).toBe(0);
  });

  it("withdraws a destination the next read no longer names, and the venue made only for it", async () => {
    const before = await venueNamed("Kensico Dam Plaza");
    expect(before).toHaveLength(1);
    const read = JSON.parse(readFileSync(READ, "utf8")) as { tiles: { places: { name: string }[] }[] };
    for (const t of read.tiles) t.places = t.places.filter((p) => p.name !== "Kensico Dam");
    const path = join(mkdtempSync(join(tmpdir(), "outrn-dest-")), "read.json");
    writeFileSync(path, JSON.stringify(read));
    const s = await replay(path);
    expect(s.venues.removed).toBe(1);
    const after = await db.query<{ n: number }>(`select count(*)::int as n from current_facts where subject_kind = 'venue' and subject_id = $1`, [before[0]!.id]);
    expect(after.rows[0]!.n).toBe(0);
    // The founder's Twin Lakes keeps its own facts and stays a destination.
    expect((await venueNamed("Twin Lakes County Park"))[0]!.destination).toMatchObject({ kind: "nature" });
  });

  it("keeps each area's claim its own: an overlapping area that does not name a place leaves the other's claim, and the place's facts", async () => {
    // Untermyer is in Yonkers, inside Bronxville's circle too.
    const [untermyer] = await venueNamed("Untermyer Gardens");
    const overtureFacts = async () => (await db.query(`select 1 from facts where subject_kind = 'venue' and subject_id = $1 and source_id = 'overture' and superseded_at is null`, [untermyer!.id])).rowCount;
    const destination = async () => (await venueNamed("Untermyer Gardens"))[0]!.destination;
    const before = await overtureFacts();
    expect(before).toBeGreaterThan(0);
    const read = JSON.parse(readFileSync(READ, "utf8")) as { tiles: { places: { name: string }[] }[] };
    for (const t of read.tiles) t.places = t.places.filter((p) => p.name !== "Untermyer Gardens Conservancy");
    const missing = join(mkdtempSync(join(tmpdir(), "outrn-dest-")), "read.json");
    writeFileSync(missing, JSON.stringify(read));
    const yonkers = (fromFile: string) => ingestDestinations(db, { areaSlug: "yonkers", fromFile, clock: () => NOW });

    // Yonkers' read misses it: Bronxville's claim, and the facts of its record, stand.
    await yonkers(missing);
    expect(await destination()).toMatchObject({ kind: "garden" });
    expect(await overtureFacts()).toBe(before);
    // Both name it, then Bronxville no longer does: Yonkers' claim keeps it.
    await yonkers(READ);
    expect((await replay(missing)).venues.removed).toBe(1);
    expect(await destination()).toMatchObject({ kind: "garden" });
    expect(await overtureFacts()).toBe(before);
    // Once no area names it, it goes, and the venue made only for it with it.
    await yonkers(missing);
    expect(await destination()).toBeNull();
    expect(await overtureFacts()).toBe(0);
  });
});
