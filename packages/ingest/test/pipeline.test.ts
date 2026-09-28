import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { testDatabaseAvailable, reset } from "@outrn/db";
import { fromLocal } from "@outrn/core";
import { OSM_NORMALIZE_VERSION } from "../src/osm-normalize.js";
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
    expect(first.fetched).toBe(87);
    expect(first.raw.new).toBe(87);
    // 87 elements → 86 venues: the node+way café merged into one.
    expect(first.venues.created).toBe(86);
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
    expect(second.raw.unchanged).toBe(87);
    expect(second.raw.renormalized).toBe(0);
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
    expect(s.raw.unchanged).toBe(87);
    expect(s.raw.renormalized).toBe(87);
    // The same rules on the same tags: every claim already exists, nothing is added or taken away.
    expect(s.facts.inserted).toBe(0);
    expect(Number((await db.query<{ n: string }>(`select count(*) as n from facts where superseded_at is null`)).rows[0]!.n)).toBe(before);
    const stale = await db.query(`select 1 from source_entities where source_id = 'osm' and deleted_at is null and normalized_with is distinct from $1`, [OSM_NORMALIZE_VERSION]);
    expect(stale.rowCount).toBe(0);
    expect((await ingestOsmArea(db, { areaSlug: "les", fromFile: FIXTURE })).raw.renormalized).toBe(0);
  });

  it("a record that disappears from the source is tombstoned and its facts retracted; a changed record supersedes old facts", async () => {
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
});

