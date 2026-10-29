import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { testDatabaseAvailable, reset } from "@outrn/db";
import type { TicketedEvent, TicketingCapture } from "@outrn/sources";
import { ingestOsmArea } from "../src/pipeline.js";
import { ingestTicketedEvents, ticketedEventInput, ticketedKinds } from "../src/ticketing.js";

/** Ticketed events replayed from saved reads, against a real Postgres + PostGIS (outrn_test, reset per file). */

const BASE = process.env["DATABASE_URL"] ?? "postgres://outrn@127.0.0.1:54329/outrn";
const TEST_URL = BASE.replace(/\/[^/]+$/, "/outrn_test");
const FIXTURE = resolve(__dirname, "../../../fixtures/osm/les-synthetic.json");
const NOW = new Date("2026-10-03T16:00:00Z");

describe("what a ticketed event is", () => {
  it("its kinds as interests: the specific genre over the broad segment, a comedy show not also theatre", () => {
    expect(ticketedKinds(["music", "rock", "indie rock"])).toEqual({ kinds: ["live_music"], forKids: false });
    expect(ticketedKinds(["arts & theatre", "comedy", "comedy"])).toEqual({ kinds: ["comedy"], forKids: false });
    expect(ticketedKinds(["arts & theatre", "theatre", "musical"])).toEqual({ kinds: ["theatre"], forKids: false });
    expect(ticketedKinds(["sports", "basketball", "nba"])).toEqual({ kinds: ["sports"], forKids: false });
    expect(ticketedKinds(["arts & theatre", "children's theatre"])).toEqual({ kinds: ["theatre"], forKids: true });
    expect(ticketedKinds(["miscellaneous", "undefined"])).toEqual({ kinds: [], forKids: false });
    expect(ticketedKinds(["comedy"])).toEqual({ kinds: ["comedy"], forKids: false });
    expect(ticketedKinds(["broadway tickets national", "theater"])).toEqual({ kinds: ["theatre"], forKids: false });
  });

  it("in the events file's shape: a ticket to get in, the range it costs, 21+ only when the API says adults only", () => {
    const e: TicketedEvent = { id: "a1", title: "Mitski", url: "https://www.ticketmaster.com/e/1", start: "2026-10-03T23:00:00.000Z", status: "scheduled", venue: { name: "X", address: null, lat: 0, lon: 0 }, kinds: ["music"], price: { min: 45, max: 89.5 }, adultsOnly: true, popularity: null };
    expect(ticketedEventInput(e)).toEqual({ id: "a1", title: "Mitski", start: "2026-10-03T23:00:00.000Z", end: null, url: "https://www.ticketmaster.com/e/1", kinds: ["live_music"], minAge: 21, admission: "ticket", price: { min: 45, max: 89.5, currency: "USD" } });
    // Only an https page is linked.
    expect(ticketedEventInput({ ...e, url: "http://example.com/x", adultsOnly: false, price: null })).toEqual({ id: "a1", title: "Mitski", start: "2026-10-03T23:00:00.000Z", end: null, kinds: ["live_music"], admission: "ticket" });
  });
});

let db: pg.Pool;
const available = await testDatabaseAvailable(BASE);
const dir = mkdtempSync(join(tmpdir(), "outrn-ticketing-"));

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
  // Registered disabled until their terms are reviewed (0028); these tests stand in for that review.
  await db.query(`update source_policies set enabled = true where id in ('ticketmaster', 'seatgeek')`);
});

afterAll(async () => {
  if (db) await db.end();
});

const PLAYHOUSE = { name: "Delancey Playhouse", address: null, lat: 40.71405, lon: -73.97738 };
const event = (over: Partial<TicketedEvent> = {}): TicketedEvent => ({
  id: "tm-1",
  title: "Hamlet",
  url: "https://www.ticketmaster.com/hamlet/event/1",
  start: "2026-10-03T23:00:00.000Z",
  status: "scheduled",
  venue: PLAYHOUSE,
  kinds: ["arts & theatre", "theatre"],
  price: { min: 30, max: 75 },
  adultsOnly: false,
  popularity: null,
  ...over,
});
let n = 0;
const capture = (source: TicketingCapture["source"], events: TicketedEvent[], over: Partial<TicketingCapture> = {}) => {
  const path = join(dir, `${source}-${n++}.json`);
  writeFileSync(path, JSON.stringify({ outrn_capture: "ticketed-events", source, fetchedAt: NOW.toISOString(), area: "les", complete: true, events, ...over } satisfies TicketingCapture));
  return path;
};
const occurrence = async (key: string) =>
  (await db.query<{ id: string; venue_id: string; status: string; venue: string; category: string }>(`select o.id, o.venue_id, o.status, v.canonical_name as venue, v.category from occurrences o join venues v on v.id = o.venue_id where o.recurrence_key = $1`, [key])).rows[0];

describe.skipIf(!available)("ticketed events", () => {
  it("holds an event at the venue we know by its name; one at a place we don't know at an event site", async () => {
    const s = await ingestTicketedEvents(db, {
      source: "ticketmaster",
      areaSlug: "les",
      now: NOW,
      fromFile: capture("ticketmaster", [event(), event({ id: "tm-2", title: "Fireworks Cruise", kinds: ["miscellaneous"], venue: { name: "Pier 36", address: "299 South St", lat: 40.7101, lon: -73.9826 } })]),
    });
    expect([s.written, s.sitesCreated, s.rejected]).toEqual([2, 1, []]);
    expect(await occurrence("ticketmaster:tm-1")).toMatchObject({ venue: "Delancey Playhouse", category: "theatre", status: "scheduled" });
    expect(await occurrence("ticketmaster:tm-2")).toMatchObject({ venue: "Pier 36", category: "event_site" });
    const price = (await db.query(`select value from current_facts where subject_kind = 'occurrence' and subject_id = $1 and attribute = 'price'`, [(await occurrence("ticketmaster:tm-1"))!.id])).rows[0];
    expect(price?.value).toEqual({ currency: "USD", min: 30, max: 75 });
  });

  it("leaves out what Ticketmaster already lists at the venue around the same time; keeps another show there", async () => {
    const s = await ingestTicketedEvents(db, {
      source: "seatgeek",
      areaSlug: "les",
      now: NOW,
      fromFile: capture("seatgeek", [event({ id: "sg-1", title: "Hamlet (Shakespeare)", start: "2026-10-03T23:15:00.000Z" }), event({ id: "sg-2", title: "Late Night Improv", start: "2026-10-04T02:30:00.000Z", kinds: ["comedy"] })]),
    });
    expect(s.skipped).toEqual({ listed_by_other: 1 });
    expect(await occurrence("seatgeek:sg-1")).toBeUndefined();
    expect(await occurrence("seatgeek:sg-2")).toMatchObject({ venue: "Delancey Playhouse" });
  });

  it("a full read that no longer lists an event withdraws it; a partial one withdraws nothing", async () => {
    await ingestTicketedEvents(db, { source: "ticketmaster", areaSlug: "les", now: NOW, fromFile: capture("ticketmaster", [event({ id: "tm-2", title: "Fireworks Cruise", kinds: [], venue: { name: "Pier 36", address: "299 South St", lat: 40.7101, lon: -73.9826 } })], { complete: false }) });
    expect((await occurrence("ticketmaster:tm-1"))!.status).toBe("scheduled");
    await ingestTicketedEvents(db, { source: "ticketmaster", areaSlug: "les", now: NOW, fromFile: capture("ticketmaster", [event({ id: "tm-2", title: "Fireworks Cruise", kinds: [], venue: { name: "Pier 36", address: "299 South St", lat: 40.7101, lon: -73.9826 } })]) });
    expect((await occurrence("ticketmaster:tm-1"))!.status).toBe("withdrawn");
  });

  it("refuses to run while the source is switched off, or live without its key", async () => {
    await db.query(`update source_policies set enabled = false where id = 'seatgeek'`);
    try {
      await expect(ingestTicketedEvents(db, { source: "seatgeek", areaSlug: "les", now: NOW, fromFile: capture("seatgeek", [event()]) })).rejects.toThrow(/seatgeek: disabled/);
    } finally {
      await db.query(`update source_policies set enabled = true where id = 'seatgeek'`);
    }
    await expect(ingestTicketedEvents(db, { source: "seatgeek", areaSlug: "les", now: NOW, env: {} })).rejects.toThrow(/set SEATGEEK_CLIENT_ID/);
  });
});
