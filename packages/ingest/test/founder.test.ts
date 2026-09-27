import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { reset } from "@outrn/db";
import { materializeSubjects, writeFacts } from "@outrn/facts";
import { addFounderVenue, resolveVenueRef, setFounderFact } from "../src/founder.js";
import { ingestOsmArea } from "../src/pipeline.js";

/** Founder-entered facts and venues against a real Postgres + PostGIS (outrn_test, reset per file). */

const BASE = process.env["DATABASE_URL"] ?? "postgres://outrn@127.0.0.1:54329/outrn";
const TEST_URL = BASE.replace(/\/[^/]+$/, "/outrn_test");
const FIXTURE = resolve(__dirname, "../../../fixtures/osm/les-synthetic.json");

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
  await ingestOsmArea(db, { areaSlug: "les", fromFile: FIXTURE });
});

afterAll(async () => {
  if (db) await db.end();
});

const current = async (venueId: string, attribute: string) =>
  (await db.query<{ value: Record<string, unknown>; source_ids: string[]; confidence: string; evidence_class: string }>(`select value, source_ids, confidence, evidence_class from current_facts where subject_kind = 'venue' and subject_id = $1 and attribute = $2`, [venueId, attribute])).rows[0];

describe.skipIf(!available)("founder-entered supply", () => {
  it("a founder-checked hours fact outranks stale OSM hours, and a new check supersedes the old one", async () => {
    const v = await resolveVenueRef(db, "Hester Lane Kitchen");
    expect(Number((await current(v.id, "opening_hours"))!.confidence)).toBeLessThan(0.4); // six-year-old OSM edit
    const r = await setFounderFact(db, { venueId: v.id, attribute: "opening_hours", value: { osm: "Mo-Su 12:00-23:00" }, evidence: "called 9/26", verifiedAt: new Date("2026-09-26T20:00:00Z") });
    expect(r.winnerSources).toEqual(["founder"]);
    const hours = (await current(v.id, "opening_hours"))!;
    expect(hours.value).toEqual({ osm: "Mo-Su 12:00-23:00" });
    expect(hours.evidence_class).toBe("published");
    expect(Number(hours.confidence)).toBeGreaterThanOrEqual(0.85);
    const again = await setFounderFact(db, { venueId: v.id, attribute: "opening_hours", value: { osm: "Mo-Su 12:00-22:00" }, evidence: "called 9/27" });
    expect(again.superseded).toBe(1);
    expect((await current(v.id, "opening_hours"))!.value).toEqual({ osm: "Mo-Su 12:00-22:00" });
    const log = await db.query(`select 1 from audit_log where action = 'fact.set.opening_hours' and target_id = $1`, [v.id]);
    expect(log.rowCount).toBe(2);
  });

  it("an OSM edit made after the founder's check that disagrees with it is a conflict for review", async () => {
    const v = await resolveVenueRef(db, "Hester Lane Kitchen");
    await writeFacts(db, [{ subjectKind: "venue", subjectId: v.id, attribute: "opening_hours", value: { osm: "Mo-Su 17:00-23:00" }, evidenceClass: "published", sourceId: "osm", evidence: "opening_hours=Mo-Su 17:00-23:00", sourceUpdatedAt: new Date("2026-09-28T12:00:00Z"), fetchedAt: new Date("2026-09-28T13:00:00Z"), confidence: 0.62, lineageGroup: "osm" }]);
    await materializeSubjects(db, "venue", [v.id]);
    const cf = await db.query<{ conflict: boolean; source_ids: string[] }>(`select conflict, source_ids from current_facts where subject_id = $1 and attribute = 'opening_hours'`, [v.id]);
    expect(cf.rows[0]).toMatchObject({ conflict: true, source_ids: ["founder"] });
  });

  it("venues add links to the venue OSM already has instead of duplicating it", async () => {
    const existing = await db.query<{ id: string; lat: number; lon: number }>(`select id, ST_Y(geom::geometry) as lat, ST_X(geom::geometry) as lon from venues where canonical_name = 'Pitt Street Nightcap'`);
    const e = existing.rows[0]!;
    const r = await addFounderVenue(db, { name: "Pitt Street Nightcap", category: "bar", point: { lat: e.lat + 0.00005, lon: e.lon }, evidence: "visited 9/26", areaSlug: "les" });
    expect(r.created).toBe(false);
    expect(r.venueId).toBe(e.id);
    const n = await db.query(`select 1 from venues where canonical_name = 'Pitt Street Nightcap' and publish_state <> 'merged'`);
    expect(n.rowCount).toBe(1);
  });

  it("venues add creates an eligible venue with founder facts for a place OSM lacks", async () => {
    const r = await addFounderVenue(db, { name: "Delancey Lanes", category: "bowling", point: { lat: 40.7182, lon: -73.9861 }, evidence: "visited 9/26", hours: "Mo-Su 12:00-01:00", website: "https://delanceylanes.example/" });
    expect(r.created).toBe(true);
    expect(r.area).toBe("les");
    const v = await db.query<{ publish_state: string; category: string }>(`select publish_state, category from venues where id = $1`, [r.venueId]);
    expect(v.rows[0]).toMatchObject({ publish_state: "eligible", category: "bowling" });
    expect((await current(r.venueId, "opening_hours"))!.source_ids).toEqual(["founder"]);
    expect((await current(r.venueId, "business_status"))!.value).toEqual({ status: "operating" });
  });

  it("a name that matches several venues is refused with the candidates listed", async () => {
    await expect(resolveVenueRef(db, "Bagel Depot")).rejects.toThrow(/matches 2 venues/);
  });
});
