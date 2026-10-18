import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { testDatabaseAvailable, reset } from "@outrn/db";
import { readCalendar, type CalendarEvent, type CalendarRead, type CalendarReadOptions } from "@outrn/sources";
import { calendarEventInput, ingestCalendars, type CalendarFeed } from "../src/calendars.js";
import { ingestOsmArea } from "../src/pipeline.js";

/** Library and town calendars, replayed from prepared reads, against a real Postgres + PostGIS (outrn_test, reset per file). */

const BASE = process.env["DATABASE_URL"] ?? "postgres://outrn@127.0.0.1:54329/outrn";
const TEST_URL = BASE.replace(/\/[^/]+$/, "/outrn_test");
const FIXTURE = resolve(__dirname, "../../../fixtures/osm/les-synthetic.json");
const NOW = new Date("2026-10-03T16:00:00Z"); // Saturday noon in New York

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

/** A library's calendar (all at the library) and a town's (each event names its place). */
const FEEDS: CalendarFeed[] = [
  { id: "suffolk-library", name: "Suffolk Library", format: "ical", url: "https://suffolk.libcal.example/ical", venue: { aliases: ["Suffolk Library"], at: { lat: 40.7097, lon: -73.995 } } },
  { id: "town", name: "Town of Example", format: "civicplus", url: "https://town.example.gov/RSSFeed.aspx?ModID=58&CID=All-calendar.xml", places: { at: { lat: 40.7185, lon: -73.988 }, radiusM: 2_000 } },
];

const event = (over: Partial<CalendarEvent> & { title: string; start: string }): CalendarEvent => ({ uid: over.title, end: null, allDay: false, location: [], categories: [], url: null, cancelled: false, recurring: false, cost: null, text: "", ...over });

const LIBRARY: CalendarEvent[] = [
  event({ uid: "lib-1", title: "Baby Lap Time", start: "2026-10-03T18:00:00.000Z", end: "2026-10-03T18:30:00.000Z", location: ["Children's Program Room"], categories: ["Storytime"], url: "https://suffolk.libcal.example/event/1", text: "Songs and rhymes. Registration is required." }),
  event({ uid: "lib-2", title: "Jazz Trio in the Reading Room", start: "2026-10-03T22:00:00.000Z", end: "2026-10-04T00:00:00.000Z", categories: ["Concerts & Music"], text: "Free and open to the public." }),
  event({ uid: "lib-3", title: "Library Closed", start: "2026-10-12T04:00:00.000Z", allDay: true, categories: ["Closings"] }),
  event({ uid: "lib-4", title: "Board of Trustees Meeting", start: "2026-10-05T23:00:00.000Z" }),
  event({ uid: "lib-5", title: "Author Talk", start: "2026-10-06T23:00:00.000Z", location: ["Online"], categories: ["Authors & Writing"] }),
  event({ uid: "lib-6", title: "Last week's film", start: "2026-09-26T22:00:00.000Z", end: "2026-09-27T00:00:00.000Z" }),
  event({ uid: "lib-7", title: "Halloween Crafts", start: "2026-10-31T18:00:00.000Z", end: "2026-10-31T19:00:00.000Z", categories: ["Crafts"] }),
  event({ uid: "lib-8", title: "Knitting Circle", start: "2026-12-05T18:00:00.000Z" }),
];
const TOWN: CalendarEvent[] = [
  event({ uid: "t-1", title: "Harvest Fair", start: "2026-10-04T15:00:00.000Z", end: "2026-10-04T19:00:00.000Z", location: ["Pitt Park", "Example, NY 10002"], url: "https://town.example.gov/Calendar.aspx?EID=1", cost: "$5", text: "Cider and pumpkins." }),
  event({ uid: "t-2", title: "Halloween Parade", start: "2026-10-04T19:00:00.000Z", location: ["255 Main Street", "Example, NY 10002"] }),
  event({ uid: "t-3", title: "CANCELLED: Movie Night", start: "2026-10-03T23:00:00.000Z", end: "2026-10-04T01:00:00.000Z", location: ["Common Council Chambers", "Pitt Park"], url: "http://town.example.gov/Calendar.aspx?EID=3" }),
  event({ uid: "t-4", title: "Jazz Trio in the Reading Room", start: "2026-10-03T22:00:00.000Z", location: ["Suffolk Library"] }),
];

const reads = (over: Partial<Record<string, Partial<CalendarRead>>> = {}): Map<string, CalendarRead> =>
  new Map([
    ["suffolk-library", { feed: "suffolk-library", url: FEEDS[0]!.url, status: "ok", pages: 1, events: LIBRARY, complete: true, ...over["suffolk-library"] }],
    ["town", { feed: "town", url: FEEDS[1]!.url, status: "ok", pages: 1, events: TOWN, complete: true, ...over["town"] }],
  ]);
const fake = (r: Map<string, CalendarRead>) => async (feed: { id: string }) => r.get(feed.id)!;
/** The feeds in `bodies` read by readCalendar itself, answering with that body; the rest as `r` has them. */
const answering = (bodies: Record<string, string>, r: Map<string, CalendarRead>) => async (feed: CalendarFeed, o: Omit<CalendarReadOptions, "get" | "robotsFor">) =>
  feed.id in bodies ? readCalendar(feed, { ...o, robotsFor: async () => ({ status: "none", rules: [], crawlDelayS: null }), get: async () => bodies[feed.id]! }) : r.get(feed.id)!;

const occurrences = async () =>
  (await db.query<{ title: string; status: string; venue: string; key: string }>(`select o.title, o.status, v.canonical_name as venue, o.recurrence_key as key from occurrences o join venues v on v.id = o.venue_id where o.recurrence_key like 'calendars:%' order by o.start_at, o.title`)).rows;
const factsOf = async (title: string) =>
  Object.fromEntries((await db.query<{ attribute: string; value: unknown }>(`select f.attribute, f.value from current_facts f join occurrences o on o.id = f.subject_id where f.subject_kind = 'occurrence' and o.title = $1`, [title])).rows.map((r) => [r.attribute, r.value]));

describe("calendar events, one at a time", () => {
  const until = new Date(NOW.getTime() + 30 * 86_400_000);
  it("leave out what is not an outing, online, over, too far ahead or all day; read who it is for, kinds, registration and price", () => {
    const lib = FEEDS[0]!;
    const skips = LIBRARY.map((e) => {
      const r = calendarEventInput(lib, e, NOW, until);
      return "skip" in r ? r.skip : "ok";
    });
    expect(skips).toEqual(["ok", "ok", "all_day", "not_an_outing", "online", "over", "ok", "later"]);
    const baby = calendarEventInput(lib, LIBRARY[0]!, NOW, until);
    expect(baby).toMatchObject({ title: "Baby Lap Time", forKids: true, admission: "reservation", url: "https://suffolk.libcal.example/event/1" });
    expect(calendarEventInput(lib, LIBRARY[1]!, NOW, until)).toMatchObject({ kinds: ["live_music"], price: { free: true } });
    expect(calendarEventInput(lib, LIBRARY[6]!, NOW, until)).toMatchObject({ kinds: ["art"] });
    // A stated cost; a price in passing ("members $5") is not one. An http link is left off, not the event.
    expect(calendarEventInput(FEEDS[1]!, TOWN[0]!, NOW, until)).toMatchObject({ price: { min: 5, currency: "USD" } });
    // "Free" with a condition is free for some: unknown, whatever the description says. Every amount named is the range.
    const costing = (cost: string, text = "") => calendarEventInput(lib, event({ title: "Gallery Talk", start: "2026-10-04T18:00:00.000Z", cost, text }), NOW, until) as { price?: unknown };
    for (const cost of ["Free", "Free admission", "FREE!", "Free and open to the public"]) expect(costing(cost).price).toEqual({ free: true });
    for (const cost of ["Free for members", "Members only, free", "Free for children", "Free with paid admission", "Free for members; $15 general admission", "Free (children under 12)", "See website"])
      expect(costing(cost, "A free evening of art.").price).toBeUndefined();
    expect(costing("$10 members / $15 non-members").price).toEqual({ min: 10, max: 15, currency: "USD" });
    expect(costing("$12").price).toEqual({ min: 12, currency: "USD" });
    const movie = calendarEventInput(FEEDS[1]!, TOWN[2]!, NOW, until);
    expect(movie).toMatchObject({ status: "cancelled" });
    expect(movie).not.toHaveProperty("url");
    // The same event (same uid and start) has the same id run after run.
    expect((calendarEventInput(lib, LIBRARY[0]!, NOW, until) as { id: string }).id).toBe((baby as { id: string }).id);
  });

  it("never marks a drink event for children, whatever its calendar files it under", () => {
    const beer = event({ uid: "t-9", title: "Family Beer Garden", start: "2026-10-04T17:00:00.000Z", end: "2026-10-04T20:00:00.000Z", location: ["Pitt Park"], categories: ["Family Events"] });
    expect(calendarEventInput(FEEDS[1]!, beer, NOW, until)).not.toHaveProperty("forKids");
    const wine = event({ uid: "t-10", title: "Kids' Craft & Wine Night", start: "2026-10-04T22:00:00.000Z", location: ["Pitt Park"] });
    expect(calendarEventInput(FEEDS[1]!, wine, NOW, until)).not.toHaveProperty("forKids");
    expect(calendarEventInput(FEEDS[1]!, event({ uid: "t-11", title: "Family Fun Day", start: "2026-10-04T17:00:00.000Z", location: ["Pitt Park"] }), NOW, until)).toMatchObject({ forKids: true });
  });
});

describe.skipIf(!available)("calendars into an area", () => {
  it("puts a library's events at the library, a town's at the place each names, and leaves the rest out", async () => {
    const dir = mkdtempSync(join(tmpdir(), "outrn-cal-"));
    const s = await ingestCalendars(db, { areaSlug: "les", feeds: FEEDS, read: fake(reads()) as never, now: NOW, saveTo: join(dir, "calendars.json") });
    expect(s.reads.map((r) => `${r.feed}:${r.status}:${r.events}`)).toEqual(["suffolk-library:ok:8", "town:ok:4"]);
    expect(s.skipped).toMatchObject({ all_day: 1, not_an_outing: 1, online: 1, over: 1, later: 1, no_place: 1, duplicate: 1 });
    expect(s.areas).toHaveLength(1);
    expect(s.areas[0]).toMatchObject({ area: "les", written: 5, withdrawn: 0, rejected: [] });
    expect((await occurrences()).map((o) => `${o.title} @ ${o.venue} (${o.status})`)).toEqual([
      "Baby Lap Time @ Suffolk Library (scheduled)",
      "Jazz Trio in the Reading Room @ Suffolk Library (scheduled)",
      "CANCELLED: Movie Night @ Pitt Park (cancelled)",
      "Harvest Fair @ Pitt Park (scheduled)",
      "Halloween Crafts @ Suffolk Library (scheduled)",
    ]);
    expect(await factsOf("Baby Lap Time")).toMatchObject({ audience: { kids: true }, admission: { requirement: "reservation" }, website: { value: "https://suffolk.libcal.example/event/1" } });
    expect(await factsOf("Jazz Trio in the Reading Room")).toMatchObject({ event_kind: { interests: ["live_music"] }, price: { free: true } });
    // The save holds what each feed gave, not pages: a replay writes the same.
    const saved = JSON.parse(readFileSync(join(dir, "calendars.json"), "utf8")) as { outrn_capture: string; reads: CalendarRead[] };
    expect(saved.outrn_capture).toBe("calendars");
    expect(saved.reads.map((r) => r.feed)).toEqual(["suffolk-library", "town"]);
    const replay = await ingestCalendars(db, { areaSlug: "les", feeds: FEEDS, fromFile: join(dir, "calendars.json"), now: NOW });
    expect(replay.areas[0]).toMatchObject({ written: 5, withdrawn: 0 });
    expect(await occurrences()).toHaveLength(5);
  });

  it("withdraws an event a complete read no longer lists, and nothing when a feed that reaches the area failed, was read in part, or answered with something not a feed", async () => {
    const statusOf = async (title: string) => (await occurrences()).find((o) => o.title === title)!.status;
    // Harvest Fair is gone from the town's read below; each time but the last, that says nothing.
    const dropped = reads({ town: { events: TOWN.filter((e) => e.uid !== "t-1") } });
    const keeps = async (read: unknown, why: string) => {
      const s = await ingestCalendars(db, { areaSlug: "les", feeds: FEEDS, read: read as never, now: NOW, log: () => {} });
      expect(s.areas[0], why).toMatchObject({ withdrawn: 0 });
      expect(await statusOf("Harvest Fair"), why).toBe("scheduled");
    };
    await keeps(fake(new Map([...dropped, ["suffolk-library", { feed: "suffolk-library", url: FEEDS[0]!.url, status: "failed", error: "503", pages: 0, events: [], complete: false }]])), "the library's read failed");
    // Harvest Fair on a page not read: the page limit, a page robots.txt keeps us from, one on another site.
    await keeps(fake(reads({ town: { events: TOWN.filter((e) => e.uid !== "t-1"), pages: 12, complete: false, incomplete: "more than 12 pages" } })), "the town's read stopped at the page limit");
    // A read saved before reads said whether they were whole is not known to be whole.
    await keeps(fake(reads({ town: { events: TOWN.filter((e) => e.uid !== "t-1"), complete: undefined as never } })), "the town's read does not say it is whole");
    // A maintenance page or an error document is not an empty calendar.
    await keeps(answering({ town: "<error>Maintenance</error>" }, dropped), "the town's feed answered with an error document");
    await keeps(answering({ "suffolk-library": "Temporarily unavailable" }, dropped), "the library's feed answered with text");
    const complete = await ingestCalendars(db, { areaSlug: "les", feeds: FEEDS, read: fake(dropped) as never, now: NOW });
    expect(complete.areas[0]).toMatchObject({ withdrawn: 1 });
    expect(await statusOf("Harvest Fair")).toBe("withdrawn");
    // A calendar that is read whole and has nothing on it does withdraw what it had.
    const empty = await ingestCalendars(db, { areaSlug: "les", feeds: FEEDS, read: answering({ "suffolk-library": "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n" }, dropped) as never, now: NOW });
    expect(empty.reads.find((r) => r.feed === "suffolk-library")).toMatchObject({ status: "ok", events: 0 });
    expect(empty.areas[0]).toMatchObject({ withdrawn: 3 });
    expect(await statusOf("Baby Lap Time")).toBe("withdrawn");
  });

  it("places by a name's own words, by the address an event gives, and a library's event held at another place it names", async () => {
    const r = new Map<string, CalendarRead>([
      ["suffolk-library", { feed: "suffolk-library", url: FEEDS[0]!.url, status: "ok", pages: 1, complete: true, events: [
        event({ uid: "off-1", title: "Comedy Open Mic", start: "2026-10-03T23:00:00.000Z", end: "2026-10-04T01:00:00.000Z", location: ["Attorney Arts Center"] }),
        event({ uid: "off-2", title: "Board Game Club for Kids", start: "2026-10-03T20:00:00.000Z", end: "2026-10-03T21:00:00.000Z", location: ["Community Room"], categories: ["Games & Hobbies"] }),
      ] }],
      ["town", { feed: "town", url: FEEDS[1]!.url, status: "ok", pages: 1, complete: true, events: [
        event({ uid: "t-10", title: "Open Studio", start: "2026-10-04T15:00:00.000Z", end: "2026-10-04T17:00:00.000Z", location: ["Hester St. Community House", "New York, NY 10002"] }),
        event({ uid: "t-11", title: "Pumpkin Painting", start: "2026-10-04T16:00:00.000Z", end: "2026-10-04T17:00:00.000Z", location: ["88 Rivington St.", "New York, NY 10002"] }),
        event({ uid: "t-12", title: "Bake Sale", start: "2026-10-04T16:00:00.000Z", end: "2026-10-04T17:00:00.000Z", location: ["Town Hall"] }),
      ] }],
    ]);
    const s = await ingestCalendars(db, { areaSlug: "les", feeds: FEEDS, read: fake(r) as never, now: NOW });
    expect(s.skipped.no_place).toBe(1);
    const at = Object.fromEntries((await occurrences()).map((o) => [o.title, o.venue]));
    expect(at).toMatchObject({ "Comedy Open Mic": "Attorney Arts Center", "Board Game Club for Kids": "Suffolk Library", "Open Studio": "Hester Community House", "Pumpkin Painting": "Bagel Depot" });
    // "Town Hall" says what kind of place, not which: left out.
    expect(at["Bake Sale"]).toBeUndefined();
    expect(await factsOf("Board Game Club for Kids")).toMatchObject({ audience: { kids: true }, event_kind: { interests: ["games"] } });
  });

  it("leaves out a library's events when it has no venue of that name near where the list puts it", async () => {
    const elsewhere: CalendarFeed = { ...FEEDS[0]!, id: "elsewhere", venue: { aliases: ["Suffolk Library"], at: { lat: 40.74, lon: -73.99 } } };
    const r = new Map([["elsewhere", { feed: "elsewhere", url: elsewhere.url, status: "ok" as const, pages: 1, events: [LIBRARY[0]!], complete: true }]]);
    const lines: string[] = [];
    const s = await ingestCalendars(db, { areaSlug: "les", feeds: [elsewhere], read: fake(r) as never, now: NOW, log: (l) => lines.push(l) });
    expect(s.skipped.no_place).toBe(1);
    expect(lines.some((l) => /no venue named Suffolk Library/.test(l))).toBe(true);
  });
});
