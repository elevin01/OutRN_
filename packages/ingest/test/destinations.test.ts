import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { reset, testDatabaseAvailable } from "@outrn/db";
import { ingestDestinations } from "../src/destinations.js";
import { addFounderVenue } from "../src/founder.js";
import { ingestOsmArea } from "../src/pipeline.js";

/** Destinations around Bronxville, replayed from the committed read, against a real Postgres + PostGIS (outrn_test). */

const BASE = process.env["DATABASE_URL"] ?? "postgres://outrn@127.0.0.1:54329/outrn";
const TEST_URL = BASE.replace(/\/[^/]+$/, "/outrn_test");
const OSM = resolve(__dirname, "../../../fixtures/live/bronxville.json");
const READ = resolve(__dirname, "../../../fixtures/live/bronxville-destinations.json");
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
  });

  it("is idempotent: the same read again adds, removes and rewrites nothing", async () => {
    const s = await replay();
    expect(s.venues).toMatchObject({ added: 0, removed: 0 });
    expect(s.facts.inserted).toBe(0);
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
});
