import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { testDatabaseAvailable, reset } from "@outrn/db";
import { materializeSubjects, writeFacts } from "@outrn/facts";
import { loadCandidates } from "../src/load.js";

/**
 * Loader behaviour against a real Postgres + PostGIS (shares the outrn_test database with the
 * pipeline test; each file resets it). Skips when no local cluster is reachable.
 */

const BASE = process.env["DATABASE_URL"] ?? "postgres://outrn@127.0.0.1:54329/outrn";
const TEST_URL = BASE.replace(/\/[^/]+$/, "/outrn_test");

let db: pg.Pool;
// Decided when the file loads: describe.skipIf reads it before any beforeAll runs.
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
});

afterAll(async () => {
  if (db) await db.end();
});

async function venue(name: string, category: string, lat: number, lon: number): Promise<string> {
  const r = await db.query<{ id: string }>(
    `insert into venues (canonical_name, name_key, geom, category, publish_state)
     values ($1, lower($1), ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography, $4, 'eligible') returning id`,
    [name, lon, lat, category],
  );
  return r.rows[0]!.id;
}

describe.skipIf(!available)("loadCandidates", () => {
  it("represents a programme venue by its occurrences in the window, and keeps the bare venue row only when nothing is on", async () => {
    const origin = { lat: 40.941, lon: -73.835 };
    const cinemaWithShow = await venue("Show Cinema", "cinema", 40.9412, -73.8352);
    const cinemaDark = await venue("Dark Cinema", "cinema", 40.9415, -73.8355);
    const bar = await venue("Corner Bar", "bar", 40.9411, -73.8351);
    const now = new Date("2026-09-27T01:37:00Z");
    const end = new Date(now.getTime() + 120 * 60_000);
    await db.query(
      `insert into occurrences (venue_id, title, start_at, end_at, status) values ($1, '10:15 show', '2026-09-27T02:15:00Z', '2026-09-27T03:45:00Z', 'scheduled')`,
      [cinemaWithShow],
    );
    const cands = await loadCandidates(db, origin, "drive", now, end);
    const rows = cands.map((c) => `${c.kind}:${c.venueId}`);
    expect(rows).toContain(`occurrence:${cinemaWithShow}`);
    expect(rows).not.toContain(`venue:${cinemaWithShow}`);
    expect(rows).toContain(`venue:${cinemaDark}`);
    expect(rows).toContain(`venue:${bar}`);
  });

  it("keeps a community centre's own row when one of its events is loaded: it is also a place to drop in", async () => {
    const origin = { lat: 40.941, lon: -73.835 };
    const centre = await venue("Mixed-use Centre", "community", 40.9416, -73.8356);
    const now = new Date("2026-09-27T16:00:00Z");
    await db.query(
      `insert into occurrences (venue_id, title, start_at, end_at, status) values ($1, 'Pottery class', '2026-09-27T17:00:00Z', '2026-09-27T18:30:00Z', 'scheduled')`,
      [centre],
    );
    const rows = (await loadCandidates(db, origin, "drive", now, new Date(now.getTime() + 180 * 60_000))).map((c) => `${c.kind}:${c.venueId}`);
    expect(rows).toContain(`occurrence:${centre}`);
    expect(rows).toContain(`venue:${centre}`);
  });

  it("carries the verification time of the winning value (a founder check), never a fetch time", async () => {
    const origin = { lat: 40.941, lon: -73.835 };
    const checked = await venue("Checked Tavern", "bar", 40.9413, -73.8353);
    const site = await venue("Site Tavern", "bar", 40.9414, -73.8354);
    const checkedOn = new Date("2026-09-26T12:00:00Z");
    const now = new Date("2026-09-27T01:37:00Z");
    await writeFacts(db, [
      { subjectKind: "venue", subjectId: checked, attribute: "opening_hours", value: { osm: "Mo-Su 16:00-04:00" }, evidenceClass: "published", sourceId: "founder", evidence: "founder: called 9/26", sourceUpdatedAt: checkedOn, fetchedAt: now, confidence: 0.9, lineageGroup: "founder" },
      { subjectKind: "venue", subjectId: site, attribute: "opening_hours", value: { osm: "Mo-Su 16:00-02:00" }, evidenceClass: "published", sourceId: "firstparty", evidence: "https://site.example :: JSON-LD", sourceUpdatedAt: null, fetchedAt: now, confidence: 0.85, lineageGroup: "firstparty:site.example" },
    ]);
    await materializeSubjects(db, "venue", [checked, site]);
    const cands = await loadCandidates(db, origin, "drive", now, new Date(now.getTime() + 7_200_000));
    const hours = (id: string) => cands.find((c) => c.id === id)!.facts.opening_hours!;
    expect(hours(checked).verifiedAt?.toISOString()).toBe(checkedOn.toISOString());
    expect(hours(checked).conflict).toBe(false);
    expect(hours(site).verifiedAt).toBeNull();
  });
});
