import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { insertArea, migrate, testDatabaseAvailable, reset } from "@outrn/db";
import { materializeSubjects, writeFacts } from "@outrn/facts";
import { fromLocal, VENUE_FACTS_DOC_SQL } from "@outrn/core";
import { OSM_NORMALIZE_VERSION } from "../src/osm-normalize.js";
import { overtureReadBox } from "../src/overture.js";
import { ingestOsmArea } from "../src/pipeline.js";

/**
 * End-to-end on the synthetic LES fixture against a real Postgres + PostGIS.
 * Uses a separate database (outrn_test) so it never touches development data.
 * Skips cleanly when no local cluster is reachable.
 */

const BASE = process.env["DATABASE_URL"] ?? "postgres://outrn@127.0.0.1:54329/outrn";
const TEST_URL = BASE.replace(/\/[^/]+$/, "/outrn_test");
const FIXTURE = resolve(__dirname, "../../../fixtures/osm/les-synthetic.json");

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

describe.skipIf(!available)("supply pipeline on the synthetic LES fixture", () => {
  it("ingests, resolves identities, writes facts, materializes, and is idempotent on replay", async () => {
    const first = await ingestOsmArea(db, { areaSlug: "les", fromFile: FIXTURE });
    // 87 named places and 2 parking lots (unnamed ones are kept too).
    expect(first.fetched).toBe(89);
    expect(first.raw.new).toBe(89);
    // 87 places → 86 venues: the node+way café merged into one. Parking never becomes a venue.
    expect(first.venues.created).toBe(86);
    // The garage is public; the private lot is left out.
    expect(first.parking).toEqual({ facilities: 1, removed: 0 });
    const lots = await db.query(`select name, kind, fee, capacity from parking_facilities`);
    expect(lots.rows).toEqual([{ name: "Rivington Garage", kind: "garage", fee: "paid", capacity: 240 }]);
    expect(first.venues.linked).toBe(1);
    expect(first.venues.children).toBe(1);
    expect(first.facts.rejected).toBe(0);

    const merged = await db.query<{ n: string }>(`select count(*) as n from entity_links where decision = 'auto' and evidence ? 'matched'`);
    expect(Number(merged.rows[0]!.n)).toBe(1);

    const bagels = await db.query<{ n: string }>(`select count(*) as n from venues where canonical_name = 'Bagel Depot' and publish_state <> 'merged'`);
    expect(Number(bagels.rows[0]!.n)).toBe(2);

    const child = await db.query<{ parent: string }>(`select p.canonical_name as parent from venues v join venues p on p.id = v.parent_venue_id where v.canonical_name = 'Tenement Story Museum Café'`);
    expect(child.rows[0]?.parent).toBe("Tenement Story Museum");

    const closed = await db.query<{ publish_state: string }>(`select publish_state from venues where canonical_name = 'Old Norfolk Lounge'`);
    expect(closed.rows[0]?.publish_state).toBe("excluded");

    const stale = await db.query<{ confidence: string }>(`select cf.confidence from current_facts cf join venues v on v.id = cf.subject_id where v.canonical_name = 'Hester Lane Kitchen' and cf.attribute = 'opening_hours'`);
    expect(Number(stale.rows[0]!.confidence)).toBeLessThan(0.4);

    const tasks = await db.query<{ n: string }>(`select count(*) as n from verification_tasks where resolved_at is null`);
    expect(Number(tasks.rows[0]!.n)).toBeGreaterThan(0);

    // Replay: nothing new, nothing changed, no duplicate facts.
    const second = await ingestOsmArea(db, { areaSlug: "les", fromFile: FIXTURE });
    expect(second.raw.new).toBe(0);
    expect(second.raw.changed).toBe(0);
    expect(second.raw.unchanged).toBe(89);
    expect(second.raw.renormalized).toBe(0);
    expect(second.parking).toEqual({ facilities: 1, removed: 0 });
    expect(second.venues.created).toBe(0);
    expect(second.facts.inserted).toBe(0);
    const factCount = await db.query<{ n: string }>(`select count(*) as n from facts where superseded_at is null`);
    const runs = await db.query<{ n: string }>(`select count(*) as n from ingestion_runs where status = 'succeeded'`);
    expect(Number(runs.rows[0]!.n)).toBe(2);
    expect(Number(factCount.rows[0]!.n)).toBeGreaterThan(500);
  });

  it("re-normalizes unchanged records when the normalizer's rules have changed since, and only then", async () => {
    await db.query(`update source_entities set normalized_with = '2026-01-01.0' where source_id = 'osm'`);
    const before = Number((await db.query<{ n: string }>(`select count(*) as n from facts where superseded_at is null`)).rows[0]!.n);
    const s = await ingestOsmArea(db, { areaSlug: "les", fromFile: FIXTURE });
    expect(s.raw.unchanged).toBe(89);
    // Parking is derived separately, not by the venue normalizer.
    expect(s.raw.renormalized).toBe(87);
    // The same rules on the same tags: every claim already exists, nothing is added or taken away.
    expect(s.facts.inserted).toBe(0);
    expect(Number((await db.query<{ n: string }>(`select count(*) as n from facts where superseded_at is null`)).rows[0]!.n)).toBe(before);
    const stale = await db.query(`select 1 from source_entities where source_id = 'osm' and kind = 'venue' and deleted_at is null and normalized_with is distinct from $1`, [OSM_NORMALIZE_VERSION]);
    expect(stale.rowCount).toBe(0);
    expect((await ingestOsmArea(db, { areaSlug: "les", fromFile: FIXTURE })).raw.renormalized).toBe(0);
  });

  it("a record that disappears from the source is tombstoned, its facts retracted and its venue no longer shown; a changed record supersedes old facts", async () => {
    const fixture = JSON.parse(await import("node:fs").then((fs) => fs.readFileSync(FIXTURE, "utf8"))) as { elements: { tags: Record<string, string> }[] };
    const idx = fixture.elements.findIndex((e) => e.tags["name"] === "Pitt Street Nightcap");
    const removedIdx = fixture.elements.findIndex((e) => e.tags["name"] === "East River Overlook");
    fixture.elements[idx]!.tags["opening_hours"] = "Mo-Su 18:00-02:00";
    fixture.elements.splice(removedIdx, 1);
    const dir = mkdtempSync(join(tmpdir(), "outrn-"));
    const path = join(dir, "les-changed.json");
    writeFileSync(path, JSON.stringify(fixture));

    const s = await ingestOsmArea(db, { areaSlug: "les", fromFile: path });
    expect(s.raw.changed).toBe(1);
    expect(s.raw.tombstoned).toBe(1);
    expect(s.facts.superseded).toBeGreaterThanOrEqual(1);

    const hours = await db.query<{ value: { osm: string } }>(`select cf.value from current_facts cf join venues v on v.id = cf.subject_id where v.canonical_name = 'Pitt Street Nightcap' and cf.attribute = 'opening_hours'`);
    expect(hours.rows[0]!.value.osm).toBe("Mo-Su 18:00-02:00");
    const history = await db.query<{ n: string }>(`select count(*) as n from facts f join venues v on v.id = f.subject_id where v.canonical_name = 'Pitt Street Nightcap' and f.attribute = 'opening_hours'`);
    expect(Number(history.rows[0]!.n)).toBe(2); // old row kept, superseded

    const overlook = await db.query<{ n: string }>(`select count(*) as n from current_facts cf join venues v on v.id = cf.subject_id where v.canonical_name = 'East River Overlook'`);
    expect(Number(overlook.rows[0]!.n)).toBe(0);
    // With no source speaking for it any more, it is no longer shown.
    const state = await db.query<{ publish_state: string }>(`select publish_state from venues where canonical_name = 'East River Overlook'`);
    expect(state.rows).toEqual([{ publish_state: "candidate" }]);
  });

  it("a replayed capture only tombstones inside the extent it was saved with", async () => {
    const fixture = JSON.parse(await import("node:fs").then((fs) => fs.readFileSync(FIXTURE, "utf8"))) as { elements: { type: string; lat?: number; lon?: number; center?: { lat: number; lon: number }; tags: Record<string, string> }[] };
    const center = { lat: 40.7185, lon: -73.988 };
    const metres = (p: { lat: number; lon: number }) => Math.hypot((p.lat - center.lat) * 111_195, (p.lon - center.lon) * 111_195 * Math.cos((center.lat * Math.PI) / 180));
    const pointOf = (e: (typeof fixture.elements)[number]) => (e.lat !== undefined ? { lat: e.lat, lon: e.lon! } : e.center!);
    const inner = fixture.elements.filter((e) => metres(pointOf(e)) < 400);
    expect(inner.length).toBeGreaterThan(1);
    expect(inner.length).toBeLessThan(fixture.elements.length);
    const dropped = inner.pop()!;
    const dir = mkdtempSync(join(tmpdir(), "outrn-"));
    const path = join(dir, "les-inner.json");
    writeFileSync(path, JSON.stringify({ ...fixture, elements: inner, outrn_extent: { ...center, radius_m: 400 } }));

    const s = await ingestOsmArea(db, { areaSlug: "les", fromFile: path });
    expect(s.extentM).toBe(400);
    // Only the one element removed inside the 400 m extent is tombstoned; everything outside it is untouched.
    expect(s.raw.tombstoned).toBe(1);
    const gone = await db.query<{ deleted: boolean }>(`select deleted_at is not null as deleted from source_entities where raw->'tags'->>'name' = $1`, [dropped.tags["name"]]);
    expect(gone.rows[0]!.deleted).toBe(true);
  });

  describe("records and the areas whose snapshots hold them", () => {
    const LES = { lat: 40.7185, lon: -73.988 };
    // About 2 km north: outside a 1,500 m circle, within the slack it may be kept in (1 km past it).
    const edge = { type: "way", id: 990003, center: { lat: 40.7365, lon: -73.988 }, tags: { name: "Edge Meadow Garden", leisure: "garden" } };
    // About 25 km away: no place of the area, however it meets the circle.
    const far = { type: "relation", id: 990001, center: { lat: 40.9, lon: -73.7 }, tags: { name: "Far Shore Refuge", leisure: "nature_reserve" } };
    const near = { type: "way", id: 990002, center: { lat: 40.7205, lon: -73.9875 }, tags: { name: "Near Edge Garden", leisure: "garden" } };
    const capture = async (elements: unknown[], extent: { lat: number; lon: number; radius_m: number } | null) => {
      const fixture = JSON.parse(await import("node:fs").then((fs) => fs.readFileSync(FIXTURE, "utf8"))) as { elements: unknown[] };
      const path = join(mkdtempSync(join(tmpdir(), "outrn-")), "les-extent.json");
      writeFileSync(path, JSON.stringify({ ...fixture, elements: [...fixture.elements, ...elements], ...(extent ? { outrn_extent: extent } : {}) }));
      return path;
    };
    const live = async (name: string) => (await db.query<{ live: boolean }>(`select deleted_at is null as live from source_entities where raw->'tags'->>'name' = $1`, [name])).rows[0]?.live ?? null;

    it("is not kept when it is far outside, and is kept just past the edge, in a capture that knows its extent", async () => {
      await ingestOsmArea(db, { areaSlug: "les", fromFile: await capture([far, near, edge], { ...LES, radius_m: 1500 }) });
      expect(await live("Far Shore Refuge")).toBeNull();
      expect(await live("Near Edge Garden")).toBe(true);
      expect(await live("Edge Meadow Garden")).toBe(true);
    });

    it("is withdrawn when the area's next snapshot no longer has it and no other area's does", async () => {
      const s = await ingestOsmArea(db, { areaSlug: "les", fromFile: await capture([near], { ...LES, radius_m: 1500 }) });
      expect(s.raw.tombstoned).toBe(1);
      expect(await live("Edge Meadow Garden")).toBe(false);
    });

    it("stays while an overlapping area's snapshot still has it, and goes when that one lets go too", async () => {
      await ingestOsmArea(db, { areaSlug: "les", fromFile: await capture([near, edge], { ...LES, radius_m: 1500 }) });
      // Bronxville's (synthetic) snapshot holds it inside its own small circle.
      const bronx = join(mkdtempSync(join(tmpdir(), "outrn-")), "bx.json");
      writeFileSync(bronx, JSON.stringify({ elements: [edge], outrn_extent: { lat: 40.7365, lon: -73.988, radius_m: 100 } }));
      await ingestOsmArea(db, { areaSlug: "bronxville", fromFile: bronx });
      await ingestOsmArea(db, { areaSlug: "les", fromFile: await capture([near], { ...LES, radius_m: 1500 }) });
      expect(await live("Edge Meadow Garden")).toBe(true);
      writeFileSync(bronx, JSON.stringify({ elements: [], outrn_extent: { lat: 40.7365, lon: -73.988, radius_m: 100 } }));
      await ingestOsmArea(db, { areaSlug: "bronxville", fromFile: bronx });
      expect(await live("Edge Meadow Garden")).toBe(false);
    });

    it("inside two areas' circles, stays while either snapshot has it (mirrors of different ages), and keeps the other's hold", async () => {
      const shared = { type: "way", id: 990004, center: { lat: 40.7255, lon: -73.988 }, tags: { name: "Shared Corner Garden", leisure: "garden" } };
      const bx = (elements: unknown[]) => {
        const path = join(mkdtempSync(join(tmpdir(), "outrn-")), "bx.json");
        writeFileSync(path, JSON.stringify({ elements, outrn_extent: { lat: 40.7255, lon: -73.988, radius_m: 20 } }));
        return path;
      };
      await ingestOsmArea(db, { areaSlug: "les", fromFile: await capture([near, shared], { ...LES, radius_m: 1500 }) });
      await ingestOsmArea(db, { areaSlug: "bronxville", fromFile: bx([shared]) });
      // LES's snapshot lacks it inside its own circle; Bronxville's still has it.
      await ingestOsmArea(db, { areaSlug: "les", fromFile: await capture([near], { ...LES, radius_m: 1500 }) });
      expect(await live("Shared Corner Garden")).toBe(true);
      const holders = await db.query<{ slug: string }>(`select a.slug from osm_area_records o join service_areas a on a.id = o.area_id join source_entities s on s.id = o.source_entity_id where s.raw->'tags'->>'name' = 'Shared Corner Garden'`);
      expect(holders.rows.map((r) => r.slug)).toEqual(["bronxville"]);
      await ingestOsmArea(db, { areaSlug: "bronxville", fromFile: bx([]) });
      expect(await live("Shared Corner Garden")).toBe(false);
    });

    it("stored before this change, kept alive by the area that legitimately holds it, no longer widens the first area's Overture read", async () => {
      const farAgain = { ...far, id: 990005, tags: { name: "Far Shore Refuge North", leisure: "nature_reserve" } };
      await ingestOsmArea(db, { areaSlug: "les", fromFile: await capture([near, farAgain], null) });
      // Bronxville's (synthetic) snapshot holds it inside its own circle.
      const bx = join(mkdtempSync(join(tmpdir(), "outrn-")), "bx-far.json");
      writeFileSync(bx, JSON.stringify({ elements: [farAgain], outrn_extent: { lat: 40.9, lon: -73.7, radius_m: 20 } }));
      await ingestOsmArea(db, { areaSlug: "bronxville", fromFile: bx });
      expect((await overtureReadBox(db, "les")).east).toBeGreaterThan(-73.71);
      await ingestOsmArea(db, { areaSlug: "les", fromFile: await capture([near], { ...LES, radius_m: 1500 }) });
      expect(await live("Far Shore Refuge North")).toBe(true);
      expect((await overtureReadBox(db, "les")).east).toBeLessThan(-73.9);
    });

    it("stored before this change (a relation 25 km out), is withdrawn by the area's next snapshot and no longer widens its Overture read", async () => {
      // An older capture, with no saved extent, keeps whatever it holds: as the area was ingested before.
      await ingestOsmArea(db, { areaSlug: "les", fromFile: await capture([near, far], null) });
      expect(await live("Far Shore Refuge")).toBe(true);
      expect((await overtureReadBox(db, "les")).east).toBeGreaterThan(-73.71);
      // The database as it was before 0022: nothing recorded who holds what; the migration backfills it.
      await db.query(`delete from osm_area_records`);
      await migrate(db, undefined, { reapply: ["0022_osm_area_records.sql"] });
      const s = await ingestOsmArea(db, { areaSlug: "les", fromFile: await capture([near], { ...LES, radius_m: 1500 }) });
      expect(s.raw.tombstoned).toBe(1);
      expect(await live("Far Shore Refuge")).toBe(false);
      expect((await overtureReadBox(db, "les")).east).toBeLessThan(-73.9);
    });

    // The database as it was before 0022, after a run of this radius: the migration backfills who holds what.
    const backfillAfter = async (runId: string, radiusM: number) => {
      await db.query(`update ingestion_runs set params = params || jsonb_build_object('radius_m', $2::int) where id = $1`, [runId, radiusM]);
      await db.query(`delete from osm_area_records`);
      await migrate(db, undefined, { reapply: ["0022_osm_area_records.sql"] });
    };

    it("a park a pre-0022 live read kept just past its circle is withdrawn once the area's next snapshot no longer has it", async () => {
      // A live read of 1,500 m kept a park whose point is 2 km out (it meets the circle).
      const band = { ...edge, id: 990021, tags: { name: "Probe Band Park", leisure: "park" } };
      const before = await ingestOsmArea(db, { areaSlug: "les", fromFile: await capture([near, band], null) });
      await backfillAfter(before.runId, 1500);
      expect(await live("Probe Band Park")).toBe(true);
      // Deleted upstream: the area's next snapshot (1,500 m, extent known) doesn't have it.
      await ingestOsmArea(db, { areaSlug: "les", fromFile: await capture([near], { ...LES, radius_m: 1500 }) });
      expect(await live("Probe Band Park")).toBe(false);
    });

    it("a park a pre-0022 wide replay kept inside its circle is not withdrawn by a smaller snapshot", async () => {
      const kept = { ...edge, id: 990023, tags: { name: "Probe Kept Park", leisure: "park" } };
      const before = await ingestOsmArea(db, { areaSlug: "les", fromFile: await capture([near, kept], { ...LES, radius_m: 2500 }) });
      await backfillAfter(before.runId, 2500);
      // A 1,500 m snapshot says nothing of it; the next 2,500 m one does.
      await ingestOsmArea(db, { areaSlug: "les", fromFile: await capture([near], { ...LES, radius_m: 1500 }) });
      expect(await live("Probe Kept Park")).toBe(true);
      await ingestOsmArea(db, { areaSlug: "les", fromFile: await capture([near], { ...LES, radius_m: 2500 }) });
      expect(await live("Probe Kept Park")).toBe(false);
    });
  });

  describe("snapshots of different ages (mirrors lag one another)", () => {
    const LES = { lat: 40.7185, lon: -73.988, radius_m: 1500 };
    // The LES fixture's data is from 2026-09-26T14:39:11Z (its osm3s base).
    const les = (elements: unknown[]) => {
      const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as { elements: unknown[] };
      const path = join(mkdtempSync(join(tmpdir(), "outrn-")), "les-aged.json");
      writeFileSync(path, JSON.stringify({ ...fixture, elements: [...fixture.elements, ...elements], outrn_extent: LES }));
      return path;
    };
    // Bronxville's (synthetic) snapshot of a small circle around a point, its data from `base`.
    const bx = (elements: unknown[], at: { lat: number; lon: number }, base: string | null) => {
      const path = join(mkdtempSync(join(tmpdir(), "outrn-")), "bx-aged.json");
      writeFileSync(path, JSON.stringify({ ...(base ? { osm3s: { timestamp_osm_base: base } } : {}), elements, outrn_extent: { ...at, radius_m: 20 } }));
      return path;
    };
    const record = async (name: string) =>
      (await db.query<{ live: boolean; name: string; version: number }>(`select deleted_at is null as live, raw->'tags'->>'name' as name, (raw->>'version')::int as version from source_entities where external_id = $1`, [name])).rows[0];

    it("an element's older version, from a lagging mirror, leaves the newer one standing", async () => {
      const at = { lat: 40.7195, lon: -73.9895 };
      const cafe = { type: "node", id: 990041, ...at, version: 3, tags: { name: "Probe Corner Cafe", amenity: "cafe" } };
      await ingestOsmArea(db, { areaSlug: "les", fromFile: les([cafe]) });
      const s = await ingestOsmArea(db, { areaSlug: "bronxville", fromFile: bx([{ ...cafe, version: 2, tags: { name: "Probe Corner Diner", amenity: "restaurant" } }], at, null) });
      expect(s.raw).toMatchObject({ older: 1, changed: 0, tombstoned: 0 });
      expect(await record("node/990041")).toEqual({ live: true, name: "Probe Corner Cafe", version: 3 });
      // Still held by the snapshot that has it: LES letting go doesn't withdraw it.
      await ingestOsmArea(db, { areaSlug: "les", fromFile: les([]) });
      expect((await record("node/990041"))?.live).toBe(true);
      await ingestOsmArea(db, { areaSlug: "bronxville", fromFile: bx([], at, null) });
      expect((await record("node/990041"))?.live).toBe(false);
    });

    it("a record withdrawn by newer data comes back only in newer data, or as an edit made since", async () => {
      const at = { lat: 40.7175, lon: -73.9865 };
      const bar = { type: "node", id: 990042, ...at, version: 5, tags: { name: "Probe Lantern Bar", amenity: "bar" } };
      await ingestOsmArea(db, { areaSlug: "les", fromFile: les([bar]) });
      await ingestOsmArea(db, { areaSlug: "les", fromFile: les([]) });
      expect((await record("node/990042"))?.live).toBe(false);
      // A mirror a week behind still lists it.
      const s = await ingestOsmArea(db, { areaSlug: "bronxville", fromFile: bx([bar], at, "2026-09-19T00:00:00Z") });
      expect(s.raw).toMatchObject({ older: 1, changed: 0 });
      expect((await record("node/990042"))?.live).toBe(false);
      const holders = await db.query(`select 1 from osm_area_records o join source_entities s on s.id = o.source_entity_id where s.external_id = 'node/990042'`);
      expect(holders.rowCount).toBe(0);
      // A higher version in that same lagging data was edited before the record went: still withdrawn.
      await ingestOsmArea(db, { areaSlug: "bronxville", fromFile: bx([{ ...bar, version: 6, timestamp: "2026-09-12T00:00:00Z" }], at, "2026-09-19T00:00:00Z") });
      expect((await record("node/990042"))?.live).toBe(false);
      // Undeleted upstream (a new version, edited after it went), it is back.
      await ingestOsmArea(db, { areaSlug: "bronxville", fromFile: bx([{ ...bar, version: 6, timestamp: "2026-09-27T00:00:00Z" }], at, "2026-09-28T00:00:00Z") });
      expect(await record("node/990042")).toEqual({ live: true, name: "Probe Lantern Bar", version: 6 });
    });

    // Three areas whose circles meet at one point (synthetic snapshots of a small circle there).
    const atPoint = (area: string, elements: unknown[], at: { lat: number; lon: number }, base: string) => ingestOsmArea(db, { areaSlug: area, fromFile: bx(elements, at, base) });

    it("the newest sign a record is gone holds, whichever area lets go of it last, against an older mirror's listing", async () => {
      const at = { lat: 40.98, lon: -73.76 };
      const deli = { type: "node", id: 990044, ...at, version: 5, tags: { name: "Probe Station Deli", amenity: "cafe" } };
      await atPoint("yonkers", [deli], at, "2026-10-09T00:00:00Z");
      await atPoint("white_plains", [deli], at, "2026-10-05T00:00:00Z");
      // Yonkers's newer snapshot finds it gone; White Plains still holds it, so it stays for now.
      await atPoint("yonkers", [], at, "2026-10-10T00:00:00Z");
      expect((await record("node/990044"))?.live).toBe(true);
      // White Plains's older one lets go of it last.
      await atPoint("white_plains", [], at, "2026-10-06T00:00:00Z");
      expect((await record("node/990044"))?.live).toBe(false);
      // Scarsdale's first snapshot, from a mirror at the 8th, still lists the same version: it stays gone.
      const s = await atPoint("scarsdale", [deli], at, "2026-10-08T00:00:00Z");
      expect(s.raw).toMatchObject({ older: 1, changed: 0 });
      expect((await record("node/990044"))?.live).toBe(false);
      // A snapshot newer than the 10th that has it brings it back.
      await atPoint("scarsdale", [deli], at, "2026-10-11T00:00:00Z");
      expect((await record("node/990044"))?.live).toBe(true);
    });

    it("an older mirror's listing doesn't hold a record a newer snapshot found gone while another area held it", async () => {
      const at = { lat: 40.985, lon: -73.765 };
      const shop = { type: "node", id: 990045, ...at, version: 2, tags: { name: "Probe Corner Books", amenity: "cafe" } };
      await atPoint("yonkers", [shop], at, "2026-10-09T00:00:00Z");
      await atPoint("white_plains", [shop], at, "2026-10-05T00:00:00Z");
      await atPoint("yonkers", [], at, "2026-10-10T00:00:00Z");
      // Scarsdale, at the 8th, lists it while White Plains still holds it: Scarsdale takes no hold.
      const s = await atPoint("scarsdale", [shop], at, "2026-10-08T00:00:00Z");
      expect(s.raw.older).toBe(1);
      const holders = async () => (await db.query<{ slug: string }>(`select a.slug from osm_area_records o join service_areas a on a.id = o.area_id join source_entities s on s.id = o.source_entity_id where s.external_id = 'node/990045' order by 1`)).rows.map((r) => r.slug);
      expect(await holders()).toEqual(["white_plains"]);
      await atPoint("white_plains", [], at, "2026-10-06T00:00:00Z");
      expect((await record("node/990045"))?.live).toBe(false);
    });

    it("a snapshot older than the area's last withdraws and lets go of nothing; the next newer one does", async () => {
      const at = { lat: 40.95, lon: -73.83 };
      const kiosk = { type: "node", id: 990043, ...at, version: 1, tags: { name: "Probe Ferry Kiosk", amenity: "cafe" } };
      await ingestOsmArea(db, { areaSlug: "bronxville", fromFile: bx([kiosk], at, "2026-10-01T00:00:00Z") });
      // From a server three months behind: the kiosk opened since.
      const s = await ingestOsmArea(db, { areaSlug: "bronxville", fromFile: bx([], at, "2026-07-01T00:00:00Z") });
      expect(s.behindOsmBase).toBe("2026-10-01T00:00:00.000Z");
      expect(s.raw.tombstoned).toBe(0);
      expect((await record("node/990043"))?.live).toBe(true);
      const held = await db.query(`select 1 from osm_area_records o join source_entities s on s.id = o.source_entity_id where s.external_id = 'node/990043'`);
      expect(held.rowCount).toBe(1);
      const next = await ingestOsmArea(db, { areaSlug: "bronxville", fromFile: bx([], at, "2026-10-02T00:00:00Z") });
      expect(next.behindOsmBase).toBeNull();
      expect((await record("node/990043"))?.live).toBe(false);
    });
  });

  it("a mapper's survey supersedes the stored claims: status becomes published, hours carry the survey date, the ledger keeps both", async () => {
    const fixture = JSON.parse(await import("node:fs").then((fs) => fs.readFileSync(FIXTURE, "utf8"))) as { elements: { lat: number; lon: number; timestamp: string; tags: Record<string, string> }[] };
    const el = fixture.elements.find((e) => e.tags["name"] === "Grand Kitchen")!;
    const facts = async () =>
      (await db.query<{ attribute: string; evidence_class: string; observed_at: Date | null; evidence: string | null }>(
        `select f.attribute, f.evidence_class, f.observed_at, f.evidence from facts f join venues v on v.id = f.subject_id
          where v.canonical_name = 'Grand Kitchen' and f.source_id = 'osm' and f.superseded_at is null and f.attribute in ('business_status', 'opening_hours', 'kitchen_hours') order by f.attribute`,
      )).rows;
    const before = await facts();
    expect(before.find((f) => f.attribute === "business_status")).toMatchObject({ evidence_class: "estimate", observed_at: null });

    // Same values, new evidence: surveyed before the element's last edit (2026-04-19), plus kitchen hours.
    const surveyed = { ...el, tags: { ...el.tags, "check_date:opening_hours": "2026-04-01", "opening_hours:kitchen": "Mo-Su 11:00-22:00" } };
    const dir = mkdtempSync(join(tmpdir(), "outrn-"));
    const path = join(dir, "les-surveyed.json");
    // A capture of just this element, scoped to it, so nothing else is tombstoned.
    writeFileSync(path, JSON.stringify({ ...fixture, elements: [surveyed], outrn_extent: { lat: el.lat, lon: el.lon, radius_m: 5 } }));
    const s = await ingestOsmArea(db, { areaSlug: "les", fromFile: path });
    expect(s.raw.tombstoned).toBe(0);

    const after = await facts();
    // One active row per attribute: the survey changed the evidence on the same claim, it did not add a second one.
    expect(after.map((f) => f.attribute)).toEqual(["business_status", "kitchen_hours", "opening_hours"]);
    expect(after[0]).toMatchObject({ evidence_class: "published", evidence: "check_date:opening_hours=2026-04-01", observed_at: new Date("2026-04-01T12:00:00Z") });
    expect(after[2]).toMatchObject({ evidence_class: "published", evidence: "opening_hours=Mo-Su 11:00-23:00; check_date:opening_hours=2026-04-01", observed_at: new Date("2026-04-01T12:00:00Z") });

    // Append-only: the estimate was superseded by a new published row, not rewritten in place.
    const history = await db.query<{ evidence_class: string; superseded: boolean }>(
      `select f.evidence_class, f.superseded_at is not null as superseded from facts f join venues v on v.id = f.subject_id
        where v.canonical_name = 'Grand Kitchen' and f.source_id = 'osm' and f.attribute = 'business_status' order by f.superseded_at nulls last`,
    );
    expect(history.rows).toEqual([{ evidence_class: "estimate", superseded: true }, { evidence_class: "published", superseded: false }]);

    const current = await db.query<{ attribute: string; evidence_class: string }>(
      `select cf.attribute, cf.evidence_class from current_facts cf join venues v on v.id = cf.subject_id where v.canonical_name = 'Grand Kitchen' and cf.attribute in ('business_status', 'kitchen_hours') order by cf.attribute`,
    );
    expect(current.rows).toEqual([
      { attribute: "business_status", evidence_class: "published" },
      { attribute: "kitchen_hours", evidence_class: "published" },
    ]);
  });

  it("a tag removed upstream takes its derived fact along: a bar that starts serving food loses 'usually 21+'", async () => {
    const fixture = JSON.parse(await import("node:fs").then((fs) => fs.readFileSync(FIXTURE, "utf8"))) as { elements: { lat: number; lon: number; tags: Record<string, string> }[] };
    const el = fixture.elements.find((e) => e.tags["name"] === "Broome Bar")!;
    const ageLimit = async () =>
      (await db.query<{ value: { minAge: number } }>(`select cf.value from current_facts cf join venues v on v.id = cf.subject_id where v.canonical_name = 'Broome Bar' and cf.attribute = 'age_limit'`)).rows[0]?.value;
    expect(await ageLimit()).toEqual({ minAge: 21 });

    const dir = mkdtempSync(join(tmpdir(), "outrn-"));
    const path = join(dir, "les-broome-food.json");
    writeFileSync(path, JSON.stringify({ ...fixture, elements: [{ ...el, tags: { ...el.tags, cuisine: "burger" } }], outrn_extent: { lat: el.lat, lon: el.lon, radius_m: 5 } }));
    const s = await ingestOsmArea(db, { areaSlug: "les", fromFile: path });
    expect(s.raw.changed).toBe(1);
    expect(await ageLimit()).toBeUndefined();
    const history = await db.query<{ superseded: boolean }>(`select f.superseded_at is not null as superseded from facts f join venues v on v.id = f.subject_id where v.canonical_name = 'Broome Bar' and f.attribute = 'age_limit'`);
    expect(history.rows).toEqual([{ superseded: true }]); // kept as history, no longer asserted
  });

  it("a place that opens later stays published but closed until its opening day, then lapses on its own", async () => {
    const fixture = JSON.parse(await import("node:fs").then((fs) => fs.readFileSync(FIXTURE, "utf8"))) as { elements: { lat: number; lon: number; tags: Record<string, string> }[] };
    const el = fixture.elements.find((e) => e.tags["name"] === "Ludlow Kitchen")!;
    const opening = new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10);
    const dir = mkdtempSync(join(tmpdir(), "outrn-"));
    const path = join(dir, "les-opening.json");
    writeFileSync(path, JSON.stringify({ ...fixture, elements: [{ ...el, tags: { ...el.tags, opening_date: opening } }], outrn_extent: { lat: el.lat, lon: el.lon, radius_m: 5 } }));
    await ingestOsmArea(db, { areaSlug: "les", fromFile: path });
    const row = await db.query<{ publish_state: string; value: { status: string }; valid_until: Date }>(
      `select v.publish_state, cf.value, cf.valid_until from venues v join current_facts cf on cf.subject_id = v.id and cf.attribute = 'business_status' where v.canonical_name = 'Ludlow Kitchen'`,
    );
    // Excluding it here would outlive the opening day: nothing re-materializes an unchanged record.
    expect(row.rows[0]).toMatchObject({ publish_state: "eligible", value: { status: "closed_temporarily" }, valid_until: fromLocal(opening, 0, "America/New_York") });
  });

  it("a withdrawn or corrected survey date is cleared when the same hours come back without it", async () => {
    const fixture = JSON.parse(await import("node:fs").then((fs) => fs.readFileSync(FIXTURE, "utf8"))) as { elements: { lat: number; lon: number; tags: Record<string, string> }[] };
    const el = fixture.elements.find((e) => e.tags["name"] === "Norfolk Kitchen")!;
    const hours = async () =>
      (await db.query<{ observed_at: Date | null; evidence: string; surveyed: Date | null }>(
        `select f.observed_at, f.evidence,
                (select max(x.observed_at) from facts x where x.id = any(cf.input_fact_ids) and x.evidence_class <> 'observation') as surveyed
           from facts f join venues v on v.id = f.subject_id
           join current_facts cf on cf.subject_id = v.id and cf.attribute = 'opening_hours'
          where v.canonical_name = 'Norfolk Kitchen' and f.source_id = 'osm' and f.attribute = 'opening_hours' and f.superseded_at is null`,
      )).rows[0]!;
    const replay = async (tags: Record<string, string>, name: string) => {
      const dir = mkdtempSync(join(tmpdir(), "outrn-"));
      const path = join(dir, `${name}.json`);
      writeFileSync(path, JSON.stringify({ ...fixture, elements: [{ ...el, tags }], outrn_extent: { lat: el.lat, lon: el.lon, radius_m: 5 } }));
      await ingestOsmArea(db, { areaSlug: "les", fromFile: path });
    };
    await replay({ ...el.tags, "check_date:opening_hours": "2026-01-20" }, "surveyed");
    expect((await hours()).observed_at).toEqual(new Date("2026-01-20T12:00:00Z"));
    // The mapper's tag is removed upstream: same hours, no survey.
    await replay(el.tags, "withdrawn");
    expect(await hours()).toMatchObject({ observed_at: null, surveyed: null, evidence: `opening_hours=${el.tags["opening_hours"]}` });
    // Surveyed again, then corrected to a date the normalizer refuses (in the future).
    await replay({ ...el.tags, "check_date:opening_hours": "2026-01-20" }, "resurveyed");
    await replay({ ...el.tags, "check_date:opening_hours": "2099-01-01" }, "corrected");
    expect(await hours()).toMatchObject({ observed_at: null, surveyed: null });
  });

  it("a closing date takes effect once it passes, on a replay of the same data under the same rules", async () => {
    const fixture = JSON.parse(await import("node:fs").then((fs) => fs.readFileSync(FIXTURE, "utf8"))) as { elements: { lat: number; lon: number; tags: Record<string, string> }[] };
    const el = fixture.elements.find((e) => e.tags["name"] === "Allen Kitchen")!;
    const dir = mkdtempSync(join(tmpdir(), "outrn-"));
    const path = join(dir, "les-closing.json");
    writeFileSync(path, JSON.stringify({ ...fixture, elements: [{ ...el, tags: { ...el.tags, end_date: "2026-11-10" } }], outrn_extent: { lat: el.lat, lon: el.lon, radius_m: 5 } }));
    const state = async () =>
      (await db.query<{ publish_state: string; value: { status: string }; valid_until: Date | null }>(
        `select v.publish_state, cf.value, cf.valid_until from venues v join current_facts cf on cf.subject_id = v.id and cf.attribute = 'business_status' where v.canonical_name = 'Allen Kitchen'`,
      )).rows[0]!;

    const before = await ingestOsmArea(db, { areaSlug: "les", fromFile: path, clock: () => new Date("2026-11-01T15:00:00Z") });
    expect(before.raw.changed).toBe(1);
    // Still operating, but only until the closing date: the claim does not outlive what the tag says.
    expect(await state()).toMatchObject({ publish_state: "eligible", value: { status: "operating" }, valid_until: new Date("2026-11-10T05:00:00Z") }); // midnight in New York

    // Nothing upstream changes, the rules stay the same; only time passes.
    const after = await ingestOsmArea(db, { areaSlug: "les", fromFile: path, clock: () => new Date("2026-11-10T06:00:00Z") }); // 1am on the day
    expect([after.raw.changed, after.raw.renormalized]).toEqual([0, 1]);
    expect(await state()).toMatchObject({ publish_state: "excluded", value: { status: "closed_permanently" } });
    // An open edit just delisted a published venue: someone is asked to confirm it.
    const task = await db.query<{ attribute: string; question: string }>(
      `select t.attribute, t.question from verification_tasks t join venues v on v.id = t.subject_id where v.canonical_name = 'Allen Kitchen' and t.dedupe_key like '%:osm_closure'`,
    );
    expect(task.rows).toEqual([{ attribute: "business_status", question: "OpenStreetMap now says this place has closed. Has it?" }]);
  });

  it("the ledger is append-only: returning to an earlier claim adds a row instead of reviving the old one", async () => {
    const subjectId = crypto.randomUUID();
    const claim = (evidenceClass: "estimate" | "published", survey: string | null, fetchedAt: string) => ({
      subjectKind: "venue" as const, subjectId, attribute: "business_status" as const, value: { status: "operating" }, sourceId: "osm", lineageGroup: "osm",
      evidenceClass, evidence: survey ? `check_date=${survey}` : null, observedAt: survey ? new Date(`${survey}T12:00:00Z`) : null, fetchedAt: new Date(fetchedAt), confidence: 0.5,
    });
    await writeFacts(db, [claim("estimate", null, "2026-09-01T00:00:00Z")]); // A
    await writeFacts(db, [claim("published", "2026-01-10", "2026-09-10T00:00:00Z")]); // B: a mapper's survey
    const again = await writeFacts(db, [claim("estimate", null, "2026-09-20T00:00:00Z")]); // A again: the survey withdrawn
    expect(again.inserted).toBe(1);
    // Re-asserting the identical active claim stays idempotent.
    expect((await writeFacts(db, [claim("estimate", null, "2026-09-21T00:00:00Z")])).inserted).toBe(0);
    const rows = await db.query<{ evidence_class: string; active: boolean; fetched_at: Date }>(
      `select evidence_class, superseded_at is null as active, fetched_at from facts where subject_id = $1 order by created_at, fetched_at`,
      [subjectId],
    );
    expect(rows.rows.map((r) => [r.evidence_class, r.active])).toEqual([["estimate", false], ["published", false], ["estimate", true]]);
    expect(rows.rows[0]!.fetched_at).toEqual(new Date("2026-09-01T00:00:00Z")); // the first estimate is left as it was
  });

  it("claims belong to their record: a node and its building keep their own, and tombstoning one retracts only its claims", async () => {
    const active = async () =>
      (await db.query<{ attribute: string; source_record: string }>(
        `select f.attribute, f.source_record from facts f join venues v on v.id = f.subject_id
          where v.canonical_name in ('Orchard St. Coffee', 'Orchard Street Coffee') and v.publish_state <> 'merged'
            and f.source_id = 'osm' and f.superseded_at is null and f.attribute in ('name', 'opening_hours', 'website') order by 1, 2`,
      )).rows.map((r) => `${r.attribute}@${r.source_record}`);
    // The two records disagree on the name: both claims stand (a conflict to review), neither overwrites the other.
    expect(await active()).toEqual(["name@node/100084", "name@way/100085", "opening_hours@node/100084", "website@node/100084", "website@way/100085"]);
    const name = await db.query<{ conflict: boolean }>(`select cf.conflict from current_facts cf join venues v on v.id = cf.subject_id where v.canonical_name in ('Orchard St. Coffee', 'Orchard Street Coffee') and cf.attribute = 'name'`);
    expect(name.rows[0]!.conflict).toBe(true);

    // The node is deleted upstream; the building stays.
    const fixture = JSON.parse(await import("node:fs").then((fs) => fs.readFileSync(FIXTURE, "utf8"))) as { elements: { type: string; id: number; lat?: number; lon?: number; tags: Record<string, string> }[] };
    const node = fixture.elements.find((e) => e.type === "node" && e.id === 100084)!;
    const way = fixture.elements.find((e) => e.type === "way" && e.id === 100085)!;
    const dir = mkdtempSync(join(tmpdir(), "outrn-"));
    const path = join(dir, "les-node-deleted.json");
    writeFileSync(path, JSON.stringify({ ...fixture, elements: [way], outrn_extent: { lat: node.lat, lon: node.lon, radius_m: 5 } }));
    const s = await ingestOsmArea(db, { areaSlug: "les", fromFile: path });
    expect(s.raw.tombstoned).toBe(1);
    // Only the node's claims go: the building's name and website remain, and the hours (the node's alone) are gone.
    expect(await active()).toEqual(["name@way/100085", "website@way/100085"]);
  });

  it("parking follows the source: public only, dropped when made private or removed, and a venue retagged as parking loses its claims", async () => {
    type El = { type: string; id: number; lat: number; lon: number; tags: Record<string, string> };
    const fixture = JSON.parse(await import("node:fs").then((fs) => fs.readFileSync(FIXTURE, "utf8"))) as { elements: El[] };
    const replay = (name: string, elements: El[]) => {
      const path = join(mkdtempSync(join(tmpdir(), "outrn-")), name);
      writeFileSync(path, JSON.stringify({ ...fixture, elements }));
      return ingestOsmArea(db, { areaSlug: "les", fromFile: path });
    };
    const lots = async () => (await db.query<{ name: string | null; fee: string }>(`select p.name, p.fee from parking_facilities p join source_entities s on s.id = p.source_entity_id order by s.external_id`)).rows;
    // Each venue's nearest public parking within about 400 m, worked out at ingest.
    const nearest = async () =>
      (await db.query<{ name: string | null }>(`select p.name from venue_parking vp join venues v on v.id = vp.venue_id join parking_facilities p on p.source_entity_id = vp.source_entity_id where v.canonical_name = 'Forsyth Clinton Kitchen' order by vp.rank`)).rows.map((r) => r.name);
    await ingestOsmArea(db, { areaSlug: "les", fromFile: FIXTURE });
    expect(await lots()).toEqual([{ name: "Rivington Garage", fee: "paid" }]);
    expect(await nearest()).toEqual(["Rivington Garage"]);

    // The private lot opens to everyone, free; the garage turns private. The newly public lot is too far from the kitchen.
    const retagged = fixture.elements.map((e) => (e.id === 100102 ? { ...e, tags: { ...e.tags, access: "yes", fee: "no" } } : e.id === 100101 ? { ...e, tags: { ...e.tags, access: "private" } } : e));
    expect((await replay("les-parking.json", retagged)).parking).toEqual({ facilities: 1, removed: 1 });
    expect(await lots()).toEqual([{ name: null, fee: "free" }]);
    expect(await nearest()).toEqual([]);

    // Removed upstream: tombstoned, and gone from parking.
    const removed = await replay("les-no-lot.json", retagged.filter((e) => e.id !== 100102));
    expect(removed.raw.tombstoned).toBe(1);
    expect(await lots()).toEqual([]);

    // A bookshop's record retagged as a parking lot: its claims on the venue go, and it becomes parking.
    const books = async () => Number((await db.query<{ n: string }>(`select count(*) as n from current_facts cf join venues v on v.id = cf.subject_id where v.canonical_name = 'Delancey Books'`)).rows[0]!.n);
    expect(await books()).toBeGreaterThan(0);
    const paved = fixture.elements.map((e) => (e.id === 100083 ? { ...e, tags: { name: "Delancey Books Lot", amenity: "parking", fee: "yes" } } : e));
    const s = await replay("les-paved.json", paved);
    // The bookshop, and the garage and the lot as they were in the fixture.
    expect(s.raw.changed).toBe(3);
    expect(await books()).toBe(0);
    expect(await lots()).toEqual([{ name: "Delancey Books Lot", fee: "paid" }, { name: "Rivington Garage", fee: "paid" }]);

    // And back: the bookshop's claims return, and the lot is gone.
    await ingestOsmArea(db, { areaSlug: "les", fromFile: FIXTURE });
    expect(await books()).toBeGreaterThan(0);
    expect(await lots()).toEqual([{ name: "Rivington Garage", fee: "paid" }]);
    expect(await nearest()).toEqual(["Rivington Garage"]);
  });

  it("one vandal parking tag can't fail the area's ingest: parking=constructor is skipped, everything else lands", async () => {
    const fixture = JSON.parse(await import("node:fs").then((fs) => fs.readFileSync(FIXTURE, "utf8"))) as { elements: unknown[] };
    const vandal = { type: "node", id: 100199, lat: 40.7205, lon: -73.988, tags: { amenity: "parking", parking: "constructor", name: "Vandal Lot" } };
    const path = join(mkdtempSync(join(tmpdir(), "outrn-")), "les-vandal.json");
    writeFileSync(path, JSON.stringify({ ...fixture, elements: [...fixture.elements, vandal] }));
    const s = await ingestOsmArea(db, { areaSlug: "les", fromFile: path });
    expect(s.parking).toEqual({ facilities: 1, removed: 0 });
    const lots = await db.query<{ name: string | null }>(`select name from parking_facilities`);
    expect(lots.rows.map((r) => r.name)).toEqual(["Rivington Garage"]);
    await ingestOsmArea(db, { areaSlug: "les", fromFile: FIXTURE });
  });

  it("every venue's fact document (what a search reads) is its current facts, after any change; re-applying 0018 rebuilds it", async () => {
    const stale = async () => Number((await db.query<{ n: string }>(`select count(*) as n from venues v where v.publish_state <> 'merged' and v.facts_doc is distinct from ${VENUE_FACTS_DOC_SQL}`)).rows[0]!.n);
    const withFacts = async () => Number((await db.query<{ n: string }>(`select count(*) as n from venues where publish_state = 'eligible' and facts_doc <> '{}'::jsonb`)).rows[0]!.n);
    expect(await withFacts()).toBeGreaterThan(20);
    expect(await stale()).toBe(0);
    // A founder check, then a re-materialization: the document carries it, with its verification time.
    const [v] = (await db.query<{ id: string }>(`select id from venues where canonical_name = 'Pitt Street Nightcap'`)).rows;
    const at = new Date("2026-09-27T20:00:00Z");
    await writeFacts(db, [{ subjectKind: "venue", subjectId: v!.id, attribute: "opening_hours", value: { osm: "Mo-Su 17:00-02:00" }, evidenceClass: "published", sourceId: "founder", evidence: "called", sourceUpdatedAt: at, fetchedAt: at, confidence: 0.9, lineageGroup: "founder" }]);
    await materializeSubjects(db, "venue", [v!.id], at);
    const doc = (await db.query<{ facts_doc: Record<string, { value: unknown; sources: string[]; verified_at: string | null }> }>(`select facts_doc from venues where id = $1`, [v!.id])).rows[0]!.facts_doc;
    expect(doc["opening_hours"]).toMatchObject({ value: { osm: "Mo-Su 17:00-02:00" }, sources: ["founder"] });
    expect(new Date(doc["opening_hours"]!.verified_at!).toISOString()).toBe(at.toISOString());
    expect(await stale()).toBe(0);
    // A database migrated before the column: re-applying the migration backfills every document exactly.
    await db.query(`update venues set facts_doc = '{}'::jsonb`);
    expect(await stale()).toBeGreaterThan(20);
    await migrate(db, undefined, { reapply: ["0018_venue_facts_doc.sql"] });
    expect(await stale()).toBe(0);
  });
  describe("data times and versions a mirror can get wrong", () => {
    const at = { lat: 41.2, lon: -73.6 };
    let areas = 0;
    const area = async () => {
      const slug = `aged-${++areas}`;
      await insertArea(db, { slug, name: slug, lat: at.lat, lon: at.lon, radiusM: 1500, travelMode: "walk" });
      return slug;
    };
    const snap = (elements: unknown[], base: string | null) => {
      const path = join(mkdtempSync(join(tmpdir(), "outrn-")), "p53.json");
      writeFileSync(path, JSON.stringify({ ...(base ? { osm3s: { timestamp_osm_base: base } } : {}), elements, outrn_extent: { ...at, radius_m: 20 } }));
      return path;
    };
    const live = async (ext: string) => (await db.query<{ live: boolean }>(`select deleted_at is null as live from source_entities where external_id = $1`, [ext])).rows[0]?.live ?? null;

    it("a lagging mirror's intermediate version (edited before the absence) does not bring a withdrawn record back", async () => {
      const [a, c] = [await area(), await area()];
      const el = { type: "node", id: 990532, ...at, version: 5, timestamp: "2026-09-01T00:00:00Z", tags: { name: "Probe53 Kiosk Two", amenity: "cafe" } };
      await ingestOsmArea(db, { areaSlug: a, fromFile: snap([el], "2026-09-10T00:00:00Z") });
      await ingestOsmArea(db, { areaSlug: a, fromFile: snap([], "2026-09-26T00:00:00Z") });
      expect(await live("node/990532")).toBe(false);
      await ingestOsmArea(db, { areaSlug: c, fromFile: snap([{ ...el, version: 6, timestamp: "2026-09-15T00:00:00Z" }], "2026-09-20T00:00:00Z") });
      expect(await live("node/990532")).toBe(false);
      await ingestOsmArea(db, { areaSlug: c, fromFile: snap([{ ...el, version: 7, timestamp: "2026-09-27T00:00:00Z" }], "2026-09-28T00:00:00Z") });
      expect(await live("node/990532")).toBe(true);
    });

    it("a snapshot dated in the future does not stop the area's later snapshots from withdrawing", async () => {
      const d = await area();
      const el = { type: "node", id: 990533, ...at, version: 1, tags: { name: "Probe53 Kiosk Three", amenity: "cafe" } };
      await ingestOsmArea(db, { areaSlug: d, fromFile: snap([el], "2099-01-01T00:00:00Z") });
      const s = await ingestOsmArea(db, { areaSlug: d, fromFile: snap([], "2026-09-30T00:00:00Z") });
      expect(s.behindOsmBase).toBeNull();
      expect(await live("node/990533")).toBe(false);
    });

    it("a record withdrawn before 0023 takes the time of the next snapshot that sees it gone, and older data then can't bring it back", async () => {
      const [a, c] = [await area(), await area()];
      const el = { type: "node", id: 990535, ...at, version: 5, tags: { name: "Probe53 Kiosk Five", amenity: "cafe" } };
      await ingestOsmArea(db, { areaSlug: a, fromFile: snap([el], "2026-09-10T00:00:00Z") });
      // As 0023 leaves it: withdrawn, no time it was found gone, held by no one.
      await db.query(`update source_entities set deleted_at = now(), absent_as_of = null where external_id = 'node/990535'`);
      await db.query(`delete from osm_area_records o using source_entities s where s.id = o.source_entity_id and s.external_id = 'node/990535'`);
      await ingestOsmArea(db, { areaSlug: a, fromFile: snap([], "2026-09-26T00:00:00Z") });
      expect((await db.query<{ absent_as_of: Date | null }>(`select absent_as_of from source_entities where external_id = 'node/990535'`)).rows[0]!.absent_as_of?.toISOString()).toBe("2026-09-26T00:00:00.000Z");
      await ingestOsmArea(db, { areaSlug: c, fromFile: snap([el], "2026-09-20T00:00:00Z") });
      expect(await live("node/990535")).toBe(false);
      await ingestOsmArea(db, { areaSlug: c, fromFile: snap([el], "2026-09-27T00:00:00Z") });
      expect(await live("node/990535")).toBe(true);
    });

    it("an element version that is not a small whole number does not fail the next run", async () => {
      const d = await area();
      for (const version of [3_000_000_000, 1.5]) {
        const el = { type: "node", id: 990534, ...at, version, tags: { name: "Probe53 Kiosk Four", amenity: "cafe" } };
        await ingestOsmArea(db, { areaSlug: d, fromFile: snap([el], "2026-09-30T00:00:00Z") });
        await expect(ingestOsmArea(db, { areaSlug: d, fromFile: snap([el], "2026-09-30T00:00:00Z") })).resolves.toBeTruthy();
      }
    });
  });
});

