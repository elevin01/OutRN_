import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { testDatabaseAvailable, reset } from "@outrn/db";
import { ingestEvents } from "../src/events.js";
import { addFounderVenue, resolveVenueRef } from "../src/founder.js";
import { ingestOsmArea } from "../src/pipeline.js";

/** Events from a file, against a real Postgres + PostGIS (outrn_test, reset per file). */

const BASE = process.env["DATABASE_URL"] ?? "postgres://outrn@127.0.0.1:54329/outrn";
const TEST_URL = BASE.replace(/\/[^/]+$/, "/outrn_test");
const FIXTURE = resolve(__dirname, "../../../fixtures/osm/les-synthetic.json");
const NOW = new Date("2026-10-03T16:00:00Z"); // Saturday noon in New York
const PIER = { name: "East River Esplanade at Grand St", lat: 40.7135, lon: -73.9775 };

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

const fireworks = (over: Record<string, unknown> = {}) => ({
  id: "fireworks-2026-10-03",
  title: "Fireworks over the East River",
  start: "2026-10-03T21:00:00-04:00",
  end: "2026-10-03T21:30:00-04:00",
  kinds: ["festivals"],
  admission: "walk_in",
  price: { free: true },
  place: PIER,
  evidence: "city press release, 10/1",
  ...over,
});

const occurrence = async (key: string) =>
  (await db.query<{ id: string; venue_id: string; title: string; status: string }>(`select id, venue_id, title, status from occurrences where recurrence_key = $1`, [key])).rows;
const fact = async (kind: "venue" | "occurrence", id: string, attribute: string) =>
  (await db.query<{ value: Record<string, unknown>; evidence_class: string; source_ids: string[] }>(`select value, evidence_class, source_ids from current_facts where subject_kind = $1 and subject_id = $2 and attribute = $3`, [kind, id, attribute])).rows[0];

describe.skipIf(!available)("events from a file", () => {
  it("adds a pop-up at a place of its own, an event site, and updates it in place on the next file", async () => {
    const s = await ingestEvents(db, { source: "founder", events: [fireworks()] }, { areaSlug: "les", now: NOW });
    expect([s.written, s.sitesCreated, s.rejected]).toEqual([1, 1, []]);
    const [occ] = await occurrence("founder:fireworks-2026-10-03");
    const site = (await db.query<{ category: string; publish_state: string; parent_venue_id: string | null; canonical_name: string }>(`select category, publish_state, parent_venue_id, canonical_name from venues where id = $1`, [occ!.venue_id])).rows[0]!;
    expect(site).toEqual({ category: "event_site", publish_state: "eligible", parent_venue_id: null, canonical_name: PIER.name });
    expect((await fact("occurrence", occ!.id, "event_kind"))?.value).toEqual({ interests: ["festivals"] });
    expect((await fact("occurrence", occ!.id, "admission"))?.value).toEqual({ requirement: "walk_in" });
    expect((await fact("occurrence", occ!.id, "price"))?.value).toEqual({ currency: "USD", free: true });
    // The same file again, with the time moved: one event, one site.
    const again = await ingestEvents(db, { source: "founder", events: [fireworks({ start: "2026-10-03T21:15:00-04:00", end: "2026-10-03T21:45:00-04:00" })] }, { areaSlug: "les", now: NOW });
    expect([again.written, again.sitesCreated]).toEqual([1, 0]);
    const rows = await occurrence("founder:fireworks-2026-10-03");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.venue_id).toBe(occ!.venue_id);
    // Called off: the same id, cancelled.
    await ingestEvents(db, { source: "founder", events: [fireworks({ status: "cancelled" })] }, { areaSlug: "les", now: NOW });
    expect((await occurrence("founder:fireworks-2026-10-03"))[0]!.status).toBe("cancelled");
  });

  it("holds a market's events at one site, and never inside the place next door", async () => {
    const market = (id: string, start: string) => ({ id, title: "Grand Street Flea", start, end: start.replace("T10", "T16"), place: { name: "Grand St Flea", lat: 40.7166, lon: -73.9875 }, evidence: "flyer" });
    const s = await ingestEvents(db, { source: "founder", events: [market("flea-1", "2026-10-04T10:00:00-04:00"), market("flea-2", "2026-10-11T10:00:00-04:00")] }, { areaSlug: "les", now: NOW });
    expect([s.written, s.sitesCreated]).toEqual([2, 1]);
    const [a] = await occurrence("founder:flea-1");
    const [b] = await occurrence("founder:flea-2");
    expect(a!.venue_id).toBe(b!.venue_id);
    // A few metres off is still the same site.
    const moved = await ingestEvents(db, { source: "founder", events: [{ ...market("flea-3", "2026-10-18T10:00:00-04:00"), place: { name: "Grand St Flea", lat: 40.7167, lon: -73.9876 } }] }, { areaSlug: "les", now: NOW });
    expect(moved.sitesCreated).toBe(0);
    expect((await occurrence("founder:flea-3"))[0]!.venue_id).toBe(a!.venue_id);
  });

  it("holds an event at a venue we know, and reads an age limit the title states", async () => {
    const venue = await resolveVenueRef(db, "Hester Lane Kitchen", { areaSlug: "les" });
    const s = await ingestEvents(db, { source: "founder", events: [{ id: "jazz-1", title: "Jazz Night (21+)", start: "2026-10-03T20:00:00-04:00", kinds: ["live_music"], place: { venue: "Hester Lane Kitchen" }, evidence: "their instagram" }] }, { areaSlug: "les", now: NOW });
    expect([s.written, s.sitesCreated]).toEqual([1, 0]);
    const [occ] = await occurrence("founder:jazz-1");
    expect(occ!.venue_id).toBe(venue.id);
    expect(await fact("occurrence", occ!.id, "age_limit")).toMatchObject({ value: { minAge: 21 }, evidence_class: "published" });
  });

  it("takes a drink event at a site of its own as probably 21+, an estimate", async () => {
    await ingestEvents(db, { source: "founder", events: [{ id: "beer-1", title: "Beer Garden on the Pier", start: "2026-10-03T15:00:00-04:00", end: "2026-10-03T20:00:00-04:00", place: PIER, evidence: "flyer" }] }, { areaSlug: "les", now: NOW });
    const [occ] = await occurrence("founder:beer-1");
    expect(await fact("occurrence", occ!.id, "age_limit")).toMatchObject({ value: { minAge: 21 }, evidence_class: "estimate", source_ids: ["category_policy"] });
  });

  it("leaves out what fails a check, says why, and writes the rest", async () => {
    const ok = fireworks({ id: "ok-1", title: "Salsa on the Pier" });
    const s = await ingestEvents(
      db,
      {
        source: "founder",
        events: [
          ok,
          fireworks({ id: "far", place: { name: "Times Square", lat: 40.758, lon: -73.9855 } }),
          fireworks({ id: "http", url: "http://example.org/event" }),
          fireworks({ id: "local", url: "https://localhost/event" }),
          fireworks({ id: "kind", kinds: ["teleportation"] }),
          fireworks({ id: "proto", kinds: ["__proto__"] }),
          fireworks({ id: "backwards", end: "2026-10-03T20:00:00-04:00" }),
          fireworks({ id: "over", start: "2026-10-01T21:00:00-04:00", end: "2026-10-01T22:00:00-04:00" }),
          fireworks({ id: "control", title: "Fire\u0000works" }),
          fireworks({ id: "noevidence", evidence: undefined }),
          fireworks({ id: "elsewhere", place: { venue: "Bronxville Public Library" } }),
          fireworks({ id: "ok-1", title: "Twice" }),
          { id: "extra", title: "x", start: "2026-10-03T21:00:00-04:00", place: PIER, evidence: "e", colour: "blue" },
          "not an event",
          fireworks({ id: "c1", title: "Fire\u0085works" }),
          fireworks({ id: "bidi", title: "Fireworks \u202eeerf" }),
          fireworks({ id: "isolate", title: "Fire\u2066works\u2069" }),
          fireworks({ id: "mark", evidence: "press\u200f release" }),
        ],
      },
      { areaSlug: "les", now: NOW },
    );
    expect(s.written).toBe(1);
    const why = Object.fromEntries(s.rejected.map((r) => [r.id ?? `#${r.index}`, r.reason]));
    expect(why).toMatchObject({
      far: "place: outside les",
      http: expect.stringContaining("https"),
      local: expect.stringContaining("https"),
      kind: "kinds: not interests: teleportation",
      proto: "kinds: not interests: __proto__",
      backwards: "end: before the start",
      over: "already over",
      control: expect.stringContaining("control characters"),
      noevidence: expect.stringContaining("evidence"),
      elsewhere: expect.stringContaining("place:"),
      "ok-1": "id: listed twice in this file",
      extra: expect.stringContaining("colour"),
      "#13": expect.any(String),
      c1: expect.stringContaining("control characters"),
      bidi: expect.stringContaining("control characters"),
      isolate: expect.stringContaining("control characters"),
      mark: expect.stringContaining("control characters"),
    });
    expect((await occurrence("founder:ok-1"))[0]!.title).toBe("Salsa on the Pier");
  });

  it("never offers a pop-up's site as the match for a real place next to it", async () => {
    const lawn = { name: "Seward Park Lawn", lat: 40.7142, lon: -73.989 };
    await ingestEvents(db, { source: "founder", events: [{ id: "lawn-1", title: "Concert on the Lawn", start: "2026-10-04T15:00:00-04:00", end: "2026-10-04T17:00:00-04:00", place: lawn, evidence: "flyer" }] }, { areaSlug: "les", now: NOW });
    const site = (await occurrence("founder:lawn-1"))[0]!.venue_id;
    // Not its match, and not its parent: a café by the lawn would otherwise sit inside the pop-up, held back while it is on.
    const park = await addFounderVenue(db, { name: "Seward Park Lawn", category: "park", point: { lat: 40.71423, lon: -73.98903 }, evidence: "walked past it", areaSlug: "les" });
    const cafe = await addFounderVenue(db, { name: "Seward Park Lawn Cafe", category: "cafe", point: { lat: 40.71418, lon: -73.98897 }, evidence: "walked past it", areaSlug: "les" });
    for (const out of [park, cafe]) expect([out.venueId, out.matchedVenueId, out.parentVenueId], out.venueId).not.toContain(site);
  });

  it("refuses a file from a source not allowed to keep what it gives, or that is not an events file", async () => {
    await expect(ingestEvents(db, { source: "nosuchsource", events: [] }, { areaSlug: "les", now: NOW })).rejects.toThrow();
    await expect(ingestEvents(db, { events: [] }, { areaSlug: "les", now: NOW })).rejects.toThrow(/source/);
    await expect(ingestEvents(db, { source: "founder", events: Array.from({ length: 2001 }, () => ({})) }, { areaSlug: "les", now: NOW })).rejects.toThrow(/events/);
  });
});
