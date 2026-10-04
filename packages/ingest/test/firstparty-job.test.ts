import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import pg from "pg";
import { testDatabaseAvailable, reset } from "@outrn/db";
import type { ExtractedEvent, FirstPartyExtraction } from "@outrn/sources";
import { registerSite, runFirstParty } from "../src/firstparty-job.js";
import { resolveVenueRef } from "../src/founder.js";
import { ingestOsmArea } from "../src/pipeline.js";

/** The first-party job's events, against a real Postgres + PostGIS (outrn_test, reset per file); the page is stubbed. */

const page = vi.hoisted(() => ({ current: null as FirstPartyExtraction | null }));
vi.mock("@outrn/sources", async (original) => ({ ...(await original<typeof import("@outrn/sources")>()), fetchAndExtract: async () => page.current! }));

const BASE = process.env["DATABASE_URL"] ?? "postgres://outrn@127.0.0.1:54329/outrn";
const TEST_URL = BASE.replace(/\/[^/]+$/, "/outrn_test");
const FIXTURE = resolve(__dirname, "../../../fixtures/osm/les-synthetic.json");
const URL_ = "https://www.hesterlanekitchen.com/events";

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
  await ingestOsmArea(db, { areaSlug: "les", fromFile: FIXTURE });
});

afterAll(async () => {
  if (db) await db.end();
});

const jazz = (kinds: ExtractedEvent["kinds"]): ExtractedEvent => ({ title: "Thursday Jazz", kinds, start: new Date("2026-10-08T23:00:00Z"), end: null, status: "scheduled", price: null, url: null, evidence: "Thursday Jazz" });
const kindsOf = async (occurrenceId: string) =>
  (await db.query<{ value: unknown }>(`select value from current_facts where subject_kind = 'occurrence' and subject_id = $1 and attribute = 'event_kind'`, [occurrenceId])).rows[0]?.value;

describe.skipIf(!available)("events on a venue's own page", () => {
  it("withdraws an event's kinds when the page no longer says what it is", async () => {
    const venue = await resolveVenueRef(db, "Hester Lane Kitchen", { areaSlug: "les" });
    await registerSite(db, venue.id, URL_, "test");
    page.current = { url: URL_, fetchedAt: new Date(), facts: [], events: [jazz(["live_music"])], blocks: 1, types: ["MusicEvent"] };
    expect((await runFirstParty(db, { force: true })).ok).toBe(1);
    const occ = (await db.query<{ id: string }>(`select id from occurrences where venue_id = $1 and title = 'Thursday Jazz'`, [venue.id])).rows[0]!;
    expect(await kindsOf(occ.id)).toEqual({ interests: ["live_music"] });
    // A MusicEvent now a plain Event: the kinds it gave go.
    page.current = { ...page.current, fetchedAt: new Date(), events: [jazz([])], types: ["Event"] };
    expect((await runFirstParty(db, { force: true })).ok).toBe(1);
    expect(await kindsOf(occ.id)).toBeUndefined();
  });
});
