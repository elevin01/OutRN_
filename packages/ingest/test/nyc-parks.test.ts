import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { testDatabaseAvailable, reset } from "@outrn/db";
import { ingestNycParksEvents } from "../src/nyc-parks.js";

/** NYC Parks events replayed from a saved read, against a real Postgres + PostGIS (outrn_test, reset per file). */

const BASE = process.env["DATABASE_URL"] ?? "postgres://outrn@127.0.0.1:54329/outrn";
const TEST_URL = BASE.replace(/\/[^/]+$/, "/outrn_test");
const NOW = new Date("2026-10-24T12:00:00Z"); // Saturday 8am in New York

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
});

afterAll(async () => {
  if (db) await db.end();
});

const SEWARD = "40.71445, -73.98935";
const rows = [
  { guid: "2300001", title: "Harvest Festival", link: { url: "http://www.nycgovparks.org/events/2026/10/24/harvest-festival" }, description: "A free afternoon of music and cider.", starttime: "2026-10-24T14:00:00.000", endtime: "2026-10-24T18:00:00.000", location: "Seward Park", coordinates: SEWARD, categories: "Festivals | Food", registration_description: "Registration not required." },
  { guid: "2300002", title: "Kids in Motion: Seward Park", starttime: "2026-10-24T15:00:00.000", endtime: "2026-10-24T17:30:00.000", location: "Seward Park", coordinates: SEWARD, categories: "Best for Kids | Fitness", registration_description: "Registration not required." },
  { guid: "2300003", title: "CANCELED: Zumba", starttime: "2026-10-24T11:30:00.000", endtime: "2026-10-24T12:30:00.000", location: "Seward Park", coordinates: SEWARD, categories: "Fitness" },
  { guid: "2300004", title: "Candlelight Ghost Tour", description: "Tickets $30.", starttime: "2026-10-24T18:30:00.000", endtime: "2026-10-24T20:00:00.000", location: "Merchant's House Museum", coordinates: "40.72764, -73.99238", categories: "History | Tours | Halloween", registration_url: { url: "https://www.eventbrite.com/e/1" } },
  { guid: "2300005", title: "Forest Fitness", starttime: "2026-10-24T08:30:00.000", endtime: "2026-10-24T09:30:00.000", location: "Fort Tryon Park", coordinates: "40.85941, -73.93413", categories: "Fitness" },
];
function capture(): string {
  const path = join(mkdtempSync(join(tmpdir(), "outrn-parks-")), "les-nycparks.json");
  writeFileSync(path, JSON.stringify({ outrn_capture: "nyc-parks-events", dataset: "w3wp-dpdi", fetchedAt: "2026-10-24T11:00:00.000Z", rows }));
  return path;
}

describe.skipIf(!available)("NYC Parks events for an area", () => {
  it("writes the area's events at sites of their own, as each listing says, and leaves the rest of the city out", async () => {
    const s = await ingestNycParksEvents(db, { areaSlug: "les", fromFile: capture(), now: NOW });
    expect(s).toMatchObject({ rows: 5, events: 4, written: 4, sitesCreated: 2, rejected: [] });
    expect(s.skipped.far).toBe(1);
    const occ = await db.query<{ title: string; status: string; site: string }>(
      `select o.title, o.status, v.canonical_name as site from occurrences o join venues v on v.id = o.venue_id where o.recurrence_key like 'nyc_parks:%' order by o.start_at`,
    );
    expect(occ.rows).toEqual([
      { title: "CANCELED: Zumba", status: "cancelled", site: "Seward Park" },
      { title: "Harvest Festival", status: "scheduled", site: "Seward Park" },
      { title: "Kids in Motion: Seward Park", status: "scheduled", site: "Seward Park" },
      { title: "Candlelight Ghost Tour", status: "scheduled", site: "Merchant's House Museum" },
    ]);
    const facts = async (title: string) =>
      Object.fromEntries(
        (await db.query<{ attribute: string; value: unknown }>(`select f.attribute, f.value from current_facts f join occurrences o on o.id = f.subject_id where f.subject_kind = 'occurrence' and o.title = $1`, [title])).rows.map((r) => [r.attribute, r.value]),
      );
    expect(await facts("Harvest Festival")).toMatchObject({ admission: { requirement: "walk_in" }, price: { free: true }, event_kind: { interests: ["festivals", "food"] }, website: { value: "https://www.nycgovparks.org/events/2026/10/24/harvest-festival" } });
    const tour = await facts("Candlelight Ghost Tour");
    expect(tour).toMatchObject({ admission: { requirement: "reservation" }, event_kind: { interests: ["museums", "outdoors", "festivals"] } });
    expect(tour).not.toHaveProperty("price");
  });

  it("is idempotent: the same read again adds no event, site or fact", async () => {
    const before = await db.query<{ n: number }>(`select (select count(*) from occurrences)::int + (select count(*) from venues)::int + (select count(*) from facts)::int as n`);
    const s = await ingestNycParksEvents(db, { areaSlug: "les", fromFile: capture(), now: NOW });
    expect(s).toMatchObject({ written: 4, sitesCreated: 0 });
    const after = await db.query<{ n: number }>(`select (select count(*) from occurrences)::int + (select count(*) from venues)::int + (select count(*) from facts)::int as n`);
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
  });

  it("refuses a file that is not a saved read", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "outrn-parks-")), "x.json");
    writeFileSync(path, JSON.stringify({ source: "nyc_parks", events: [] }));
    await expect(ingestNycParksEvents(db, { areaSlug: "les", fromFile: path, now: NOW })).rejects.toThrow(/not an NYC Parks events capture/);
  });
});
