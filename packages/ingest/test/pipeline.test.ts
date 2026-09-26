import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { reset } from "@outrn/db";
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
    expect(second.venues.created).toBe(0);
    expect(second.facts.inserted).toBe(0);
    const factCount = await db.query<{ n: string }>(`select count(*) as n from facts where superseded_at is null`);
    const runs = await db.query<{ n: string }>(`select count(*) as n from ingestion_runs where status = 'succeeded'`);
    expect(Number(runs.rows[0]!.n)).toBe(2);
    expect(Number(factCount.rows[0]!.n)).toBeGreaterThan(500);
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
});
