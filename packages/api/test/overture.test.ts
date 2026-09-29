import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { reset, testDatabaseAvailable } from "@outrn/db";
import { ingestOsmArea, ingestOverture } from "@outrn/ingest";
import type { OvertureCapture, OverturePlace } from "@outrn/sources";
import { toItem } from "../src/map/item.js";
import { placeDetails } from "../src/service/places.js";
import { runEngine } from "../src/service/recommendations.js";

/** A place OSM lacks, added from Overture, as a user sees it (synthetic LES, outrn_test, reset per file). */

const BASE = process.env["DATABASE_URL"] ?? "postgres://outrn@127.0.0.1:54329/outrn";
const TEST_URL = BASE.replace(/\/[^/]+$/, "/outrn_test");
const FIXTURE = resolve(__dirname, "../../../fixtures/osm/les-synthetic.json");
const OVERTURE_CREDIT = "Places: Overture Maps Foundation (CDLA-Permissive-2.0)";

let db: pg.Pool;
const available = await testDatabaseAvailable(BASE);

// A café 400 m and more from every synthetic venue, open by Overture's own signal.
const GOTAN: OverturePlace = {
  id: "ovt-gotan",
  name: "Gotan",
  lat: 40.716,
  lon: -73.987,
  category: "coffee_shop",
  status: "open",
  statusSignal: 1,
  statusUpdatedAt: "2026-09-20T12:00:00.000Z",
  confidence: 0.95,
  websites: ["https://gotannyc.example.com/"],
  phones: ["2125550199"],
  updatedAt: "2026-09-20T00:00:00.000Z",
  datasets: ["meta"],
  licenses: ["CDLA-Permissive-2.0"],
};

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
  const path = join(mkdtempSync(join(tmpdir(), "outrn-api-overture-")), "capture.json");
  const capture: OvertureCapture = { outrn_capture: "overture", release: "2026-09-23.1", bbox: { west: -74.02, south: 40.69, east: -73.96, north: 40.75 }, fetchedAt: "2026-09-29T00:00:00.000Z", places: [GOTAN] };
  writeFileSync(path, JSON.stringify(capture));
  await ingestOverture(db, { areaSlug: "les", fromFile: path });
});

afterAll(async () => {
  if (db) await db.end();
});

describe.skipIf(!available)("a place OSM lacks, added from Overture", () => {
  it("is an option to check first, with its website, and Overture credited", async () => {
    // Saturday 10am: a café's prime time, well within reach.
    const run = await runEngine(db, { areaId: "les", windowMinutes: 180 }, { clock: () => new Date("2026-10-03T14:00:00Z"), persist: false });
    const e = run.shortlist.ordered.find((x) => x.candidate.name === "Gotan");
    expect(e).toBeDefined();
    const item = toItem(e!, run.ctx);
    expect(item.status).toBe("check_first");
    expect(item.category.id).toBe("cafe");
    expect(item.caveats.map((c) => c.code)).toContain("HOURS_UNKNOWN");
    expect(item.actions).toMatchObject({ websiteUrl: "https://gotannyc.example.com/", phone: "+1 212-555-0199" });

    const details = await placeDetails(db, item.placeId, { clock: () => new Date("2026-10-03T14:00:00Z") });
    expect(details.contact).toEqual({ websiteUrl: "https://gotannyc.example.com/", phone: "+1 212-555-0199" });
    expect(details.facts.find((f) => f.attribute === "opening_hours")?.value).toBe("Not listed");
    expect(details.facts.find((f) => f.attribute === "business_status")?.provenance.sources.map((s) => s.label)).toEqual(["Overture Maps"]);
    expect(details.attributions).toContain(OVERTURE_CREDIT);
  });
});
