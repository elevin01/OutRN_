import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { reset } from "@outrn/db";
import { loadCandidates } from "../src/load.js";

/**
 * Loader behaviour against a real Postgres + PostGIS (shares the outrn_test database with the
 * pipeline test; each file resets it). Skips when no local cluster is reachable.
 */

const BASE = process.env["DATABASE_URL"] ?? "postgres://outrn@127.0.0.1:54329/outrn";
const TEST_URL = BASE.replace(/\/[^/]+$/, "/outrn_test");

let db: pg.Pool;
let available = true;

beforeAll(async () => {
  const admin = new pg.Pool({ connectionString: BASE });
  try {
    const exists = await admin.query("select 1 from pg_database where datname = 'outrn_test'");
    if (!exists.rowCount) await admin.query("create database outrn_test");
  } catch {
    available = false;
    return;
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
});
