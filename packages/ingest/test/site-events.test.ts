import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { testDatabaseAvailable, reset } from "@outrn/db";
import { extractPage, FetchFailed, type CalendarEvent, type FirstPartyExtraction, type RobotsPolicy } from "@outrn/sources";
import { ingestEvents } from "../src/events.js";
import { registerSite, runFirstParty, type SiteFetcher } from "../src/firstparty-job.js";
import { ingestOsmArea } from "../src/pipeline.js";
import { writeSiteEvents } from "../src/site-events.js";

/** Venues' own event listings, read with their pages: against a real Postgres + PostGIS (outrn_test, reset per file). */

const BASE = process.env["DATABASE_URL"] ?? "postgres://outrn@127.0.0.1:54329/outrn";
const TEST_URL = BASE.replace(/\/[^/]+$/, "/outrn_test");
const FIXTURE = resolve(__dirname, "../../../fixtures/osm/les-synthetic.json");
const NOW = new Date("2026-10-03T16:00:00Z"); // Saturday noon in New York

let db: pg.Pool;
const available = await testDatabaseAvailable(BASE);
const venueId = async (name: string) => (await db.query<{ id: string }>(`select id from venues where canonical_name = $1`, [name])).rows[0]!.id;
const at = async (name: string) =>
  (await db.query<{ title: string; status: string; key: string | null }>(`select o.title, o.status, o.recurrence_key as key from occurrences o where o.venue_id = $1 order by o.start_at, o.title`, [await venueId(name)])).rows;
const factsOf = async (title: string) =>
  Object.fromEntries((await db.query<{ attribute: string; value: unknown }>(`select f.attribute, f.value from current_facts f join occurrences o on o.id = f.subject_id where f.subject_kind = 'occurrence' and o.title = $1`, [title])).rows.map((r) => [r.attribute, r.value]));

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
  await ingestOsmArea(db, { areaSlug: "les", fromFile: FIXTURE, clock: () => NOW });
});

afterAll(async () => {
  if (db) await db.end();
});

const event = (over: Partial<CalendarEvent> & { title: string; start: string }): CalendarEvent => ({ uid: over.title, end: null, allDay: false, location: [], categories: [], url: null, cancelled: false, recurring: false, cost: null, text: "", ...over });

describe.skipIf(!available)("a venue's own events", () => {
  it("are at the venue, or at another place one names nearby; not for children when about drink; once; never withdrawn for missing", async () => {
    const playhouse = await venueId("Delancey Playhouse");
    // The way the job once wrote a site's events: straight into occurrences, keyed by host. One this
    // listing has again gives way to it; one it does not have stays (a listing is never the whole).
    await db.query(`insert into occurrences (venue_id, title, start_at, end_at, status, recurrence_key) values ($1, 'Old Show', '2026-10-10T23:00:00Z', null, 'scheduled', 'delanceyplayhouse.example:Old Show:2026-10-10T23:00:00.000Z')`, [playhouse]);
    await db.query(`insert into occurrences (venue_id, title, start_at, end_at, status, recurrence_key) values ($1, 'Hamlet', '2026-10-03T23:00:00Z', null, 'scheduled', 'delanceyplayhouse.example:Hamlet:2026-10-03T23:00:00.000Z')`, [playhouse]);
    // Another source already lists the open rehearsal there.
    await ingestEvents(db, { source: "calendars", events: [{ id: "town/rehearsal", title: "Open Rehearsal", start: "2026-10-04T18:00:00.000Z", place: { venue: playhouse } }] }, { areaSlug: "les", now: NOW });
    const s = await writeSiteEvents(
      db,
      { venueId: playhouse, host: "delanceyplayhouse.example" },
      [
        event({ uid: "1", title: "Hamlet", start: "2026-10-03T23:00:00.000Z", end: "2026-10-04T01:30:00.000Z", categories: ["Theater"], url: "https://delanceyplayhouse.example/hamlet", cost: "$25 - $40" }),
        event({ uid: "https://delanceyplayhouse.example/hamlet", title: "Hamlet", start: "2026-10-03T23:00:00.000Z" }),
        event({ uid: "2", title: "Jazz Night", start: "2026-10-04T00:00:00.000Z", location: ["Attorney Arts Center", "100 Attorney St"], categories: ["Concerts"] }),
        event({ uid: "3", title: "Family Beer Garden", start: "2026-10-04T17:00:00.000Z", categories: ["Kids"] }),
        event({ uid: "4", title: "Puppet Show", start: "2026-10-04T15:00:00.000Z", categories: ["Theater", "Kids"], cost: "Free" }),
        event({ uid: "5", title: "Open Rehearsal", start: "2026-10-04T18:00:00.000Z" }),
        event({ uid: "6", title: "Last Week's Show", start: "2026-09-26T23:00:00.000Z" }),
      ],
      NOW,
    );
    expect(s.skipped).toMatchObject({ duplicate: 2, over: 1 });
    expect((await at("Delancey Playhouse")).map((o) => `${o.title} (${o.status}${o.key?.startsWith("delanceyplayhouse") ? ", old" : ""})`)).toEqual([
      "Hamlet (scheduled)",
      "Hamlet (withdrawn, old)",
      "Puppet Show (scheduled)",
      "Family Beer Garden (scheduled)",
      "Open Rehearsal (scheduled)",
      "Old Show (scheduled, old)",
    ]);
    expect((await at("Attorney Arts Center")).map((o) => o.title)).toEqual(["Jazz Night"]);
    expect(await factsOf("Hamlet")).toMatchObject({ event_kind: { interests: ["theatre"] }, price: { min: 25, max: 40, currency: "USD" }, website: { value: "https://delanceyplayhouse.example/hamlet" } });
    expect(await factsOf("Puppet Show")).toMatchObject({ audience: { kids: true }, price: { free: true } });
    expect(await factsOf("Family Beer Garden")).not.toHaveProperty("audience");
    expect((await at("Delancey Playhouse")).find((o) => o.title === "Hamlet")!.key).toMatch(/^venue_events:site-delanceyplayhouse\.example\//);
    // A later read with only some of them: nothing is withdrawn for missing.
    await writeSiteEvents(db, { venueId: playhouse, host: "delanceyplayhouse.example" }, [event({ uid: "4", title: "Puppet Show", start: "2026-10-04T15:00:00.000Z" })], NOW);
    expect((await at("Delancey Playhouse")).filter((o) => o.status === "scheduled").map((o) => o.title)).toEqual(["Hamlet", "Puppet Show", "Family Beer Garden", "Open Rehearsal", "Old Show"]);
  });

  it("leave an old row as it was when the write that would replace it fails (PR #61 review)", async () => {
    const playhouse = await venueId("Delancey Playhouse");
    await db.query(`insert into occurrences (venue_id, title, start_at, end_at, status, recurrence_key) values ($1, 'Macbeth', '2026-10-05T23:00:00Z', null, 'scheduled', 'delanceyplayhouse.example:Macbeth:2026-10-05T23:00:00.000Z')`, [playhouse]);
    await db.query(`update source_policies set enabled = false where id = 'venue_events'`);
    try {
      await expect(writeSiteEvents(db, { venueId: playhouse, host: "delanceyplayhouse.example" }, [event({ uid: "m", title: "Macbeth", start: "2026-10-05T23:00:00.000Z" })], NOW)).rejects.toThrow();
    } finally {
      await db.query(`update source_policies set enabled = true where id = 'venue_events'`);
    }
    expect((await at("Delancey Playhouse")).filter((o) => o.title === "Macbeth").map((o) => o.status)).toEqual(["scheduled"]);
  });

  it("are read where the home page says the site lists them, through the job's gate, and replay from a capture", async () => {
    const broome = await venueId("Broome Playhouse");
    const home = "https://broomeplayhouse.example/";
    await registerSite(db, broome, home, "auto: its own website lists its events", true);
    const tec = {
      events: [
        { id: 7001, title: "The Seagull", utc_start_date: "2026-10-04 00:00:00", utc_end_date: "2026-10-04 02:00:00", categories: [{ name: "Theater" }], url: "https://broomeplayhouse.example/event/the-seagull/", cost: "$30" },
        { id: 7002, title: "Wine &amp; Verse", utc_start_date: "2026-10-05 23:00:00", categories: [{ name: "Readings" }] },
      ],
      next_rest_url: null,
    };
    const asked: string[] = [];
    const fetcher: SiteFetcher = {
      async robots(origin, gate) {
        await gate(new URL(`${origin}/robots.txt`));
        asked.push(`robots:${new URL(origin).host}`);
        return { status: "none", rules: [], crawlDelayS: null } satisfies RobotsPolicy;
      },
      async page(url, o): Promise<FirstPartyExtraction> {
        await o.gate(new URL(url));
        asked.push(url);
        if (url !== home) throw new FetchFailed(`404 from ${new URL(url).host}`, 404);
        return extractPage(`<html><body class="tribe-events"><h1>Broome Playhouse</h1></body></html>`, url, NOW);
      },
      async text(url, o) {
        await o.gate(new URL(url));
        asked.push(url);
        if (new URL(url).pathname !== "/wp-json/tribe/events/v1/events") throw new FetchFailed(`404`, 404);
        return JSON.stringify(tec);
      },
    };
    const dir = mkdtempSync(join(tmpdir(), "outrn-site-events-"));
    const s = await runFirstParty(db, { areaSlug: "les", fetcher, now: () => NOW, saveTo: join(dir, "sites.json") });
    expect(s.occurrences).toBe(2);
    expect(asked).toContain("https://broomeplayhouse.example/wp-json/tribe/events/v1/events?per_page=50&start_date=2026-10-03&end_date=2026-11-02");
    expect((await at("Broome Playhouse")).map((o) => o.title)).toEqual(["The Seagull", "Wine & Verse"]);
    expect(await factsOf("The Seagull")).toMatchObject({ event_kind: { interests: ["theatre"] }, price: { min: 30, currency: "USD" } });
    // A replay writes the same, from what was read.
    await db.query(`delete from occurrences where venue_id = $1`, [broome]);
    const r = await runFirstParty(db, { fromFile: join(dir, "sites.json"), now: () => NOW });
    expect(r.occurrences).toBe(2);
    expect((await at("Broome Playhouse")).map((o) => o.title)).toEqual(["The Seagull", "Wine & Verse"]);
    // The next day its feed, read whole, has moved the reading a week on: the old time is gone, not listed twice.
    tec.events = [{ id: 7002, title: "Wine &amp; Verse", utc_start_date: "2026-10-12 23:00:00", categories: [{ name: "Readings" }] }];
    const later = new Date(NOW.getTime() + 86_400_000);
    await runFirstParty(db, { areaSlug: "les", fetcher, now: () => later, force: true });
    const rows = await db.query<{ start_at: Date; status: string }>(`select start_at, status from occurrences where venue_id = $1 and title = 'Wine & Verse' order by start_at`, [broome]);
    expect(rows.rows.map((o) => `${o.start_at.toISOString()} ${o.status}`)).toEqual(["2026-10-05T23:00:00.000Z withdrawn", "2026-10-12T23:00:00.000Z scheduled"]);
  });

  it("a feed read whole withdraws what the site no longer lists, wherever it was placed; a page never does", async () => {
    const playhouse = await venueId("Delancey Playhouse");
    const site = { venueId: playhouse, host: "feeds.delanceyplayhouse.example" };
    const scheduled = async () => (await db.query<{ title: string }>(`select title from occurrences where recurrence_key like 'venue_events:site-feeds.delanceyplayhouse.example/%' and status = 'scheduled' order by start_at`)).rows.map((o) => o.title);
    const all = [
      event({ uid: "a", title: "Uncle Vanya", start: "2026-10-05T23:00:00.000Z" }),
      event({ uid: "b", title: "Late Set", start: "2026-10-06T01:00:00.000Z", location: ["Attorney Arts Center"] }),
      event({ uid: "c", title: "Matinee", start: "2026-10-07T18:00:00.000Z" }),
    ];
    await writeSiteEvents(db, site, all, NOW);
    expect(await scheduled()).toEqual(["Uncle Vanya", "Late Set", "Matinee"]);
    // A page lists some: nothing goes.
    await writeSiteEvents(db, site, [all[0]!], NOW);
    expect(await scheduled()).toEqual(["Uncle Vanya", "Late Set", "Matinee"]);
    // Its feed read whole lists one: the others go, the one placed at another venue too.
    const s = await writeSiteEvents(db, site, [all[2]!], NOW, { complete: true });
    expect(s.withdrawn).toBe(2);
    expect(await scheduled()).toEqual(["Matinee"]);
    // And a feed read whole that lists nothing says they are all gone.
    await writeSiteEvents(db, site, [], NOW, { complete: true });
    expect(await scheduled()).toEqual([]);
  });

  it("back its host off when the events feed asks us to wait (429, 503): the host's next site waits too (PR #61 review)", async () => {
    for (const status of [429, 503]) {
      await db.query(`delete from firstparty_sites`);
      await db.query(`delete from firstparty_hosts`);
      await registerSite(db, await venueId("Delancey Playhouse"), "https://stages.example.org/delancey", "test", true);
      await registerSite(db, await venueId("Broome Playhouse"), "https://stages.example.org/broome", "test", true);
      const asked: string[] = [];
      const fetcher: SiteFetcher = {
        async robots(origin, gate) {
          await gate(new URL(`${origin}/robots.txt`));
          return { status: "none", rules: [], crawlDelayS: null };
        },
        async page(url, o) {
          await o.gate(new URL(url));
          asked.push(new URL(url).pathname);
          return extractPage(`<html><head><link rel="alternate" type="text/calendar" href="${new URL(url).pathname}/events.ics"></head></html>`, url, NOW);
        },
        async text(url, o) {
          await o.gate(new URL(url));
          asked.push(new URL(url).pathname);
          throw Object.assign(new FetchFailed(`${status} from stages.example.org`, status, 7200), { host: "stages.example.org" });
        },
      };
      const s = await runFirstParty(db, { areaSlug: "les", fetcher, now: () => NOW });
      expect(asked, String(status)).toEqual([asked[0], `${asked[0]}/events.ics`]);
      expect(s.deferred, String(status)).toBe(1);
      const until = (await db.query<{ retry_after: Date }>(`select retry_after from firstparty_hosts where host = 'stages.example.org'`)).rows[0]!.retry_after;
      expect(until.getTime(), String(status)).toBeGreaterThanOrEqual(NOW.getTime() + 6 * 3_600_000);
    }
  });

  it("on a host several venues share, read only a feed under the venue's own path, and never withdraw for missing from it", async () => {
    await db.query(`delete from firstparty_sites`);
    await db.query(`delete from firstparty_hosts`);
    const delancey = await venueId("Delancey Playhouse");
    const broome = await venueId("Broome Playhouse");
    await db.query(`delete from occurrences where venue_id = any($1::uuid[])`, [[delancey, broome]]);
    await registerSite(db, delancey, "https://stages.example.org/delancey", "test", true);
    await registerSite(db, broome, "https://stages.example.org/broome", "test", true);
    const ics = (titles: string[]) =>
      ["BEGIN:VCALENDAR", "VERSION:2.0", ...titles.flatMap((t) => ["BEGIN:VEVENT", `DTSTART:2026100${t === "Ivanov" ? 4 : 5}T233000Z`, `SUMMARY:${t}`, `UID:${t}@stages.example.org`, "END:VEVENT"]), "END:VCALENDAR", ""].join("\r\n");
    let listing = ["Ivanov", "The Bear"];
    const asked: string[] = [];
    const fetcher: SiteFetcher = {
      async robots(origin, gate) {
        await gate(new URL(`${origin}/robots.txt`));
        return { status: "none", rules: [], crawlDelayS: null };
      },
      async page(url, o) {
        await o.gate(new URL(url));
        const path = new URL(url).pathname;
        asked.push(path);
        // Delancey's page names the host's whole listing (The Events Calendar); Broome's, its own feed.
        return extractPage(path === "/delancey" ? `<html><body class="tribe-events"></body></html>` : `<html><head><link rel="alternate" type="text/calendar" href="${path}/events.ics"></head></html>`, url, NOW);
      },
      async text(url, o) {
        await o.gate(new URL(url));
        asked.push(new URL(url).pathname);
        return ics(listing);
      },
    };
    await runFirstParty(db, { areaSlug: "les", fetcher, now: () => NOW });
    expect(asked.filter((p) => p !== "/robots.txt").sort()).toEqual(["/broome", "/broome/events.ics", "/delancey"]);
    expect(await at("Delancey Playhouse")).toEqual([]);
    expect((await at("Broome Playhouse")).map((o) => o.title)).toEqual(["Ivanov", "The Bear"]);
    // Read whole the next day, it lists one: the other stays (its key is the host's, which Delancey's would share).
    listing = ["The Bear"];
    await runFirstParty(db, { areaSlug: "les", fetcher, now: () => new Date(NOW.getTime() + 86_400_000), force: true });
    expect((await at("Broome Playhouse")).map((o) => `${o.title} ${o.status}`)).toEqual(["Ivanov scheduled", "The Bear scheduled"]);
  });

  it("replay from a capture saved before feeds were read: its page events, with only the fields it kept (PR #61 review)", async () => {
    const delancey = await venueId("Delancey Playhouse");
    await db.query(`delete from occurrences where venue_id = $1`, [delancey]);
    const key = (await db.query<{ key: string }>(`select se.source_id || ':' || se.external_id as key from entity_links l join source_entities se on se.id = l.source_entity_id where l.venue_id = $1 and se.source_id = 'osm' limit 1`, [delancey])).rows[0]!.key;
    const dir = mkdtempSync(join(tmpdir(), "outrn-old-capture-"));
    const old = {
      outrn_capture: "firstparty-sites",
      area: "les",
      fetchedAt: NOW.toISOString(),
      sites: [
        {
          venue: key,
          url: "https://delanceyplayhouse.example/",
          status: "ok",
          read: { url: "https://delanceyplayhouse.example/", fetchedAt: NOW.toISOString(), facts: [], blocks: 1, types: ["TheaterEvent"], events: [{ title: "Uncle Vanya", kinds: ["theatre"], start: "2026-10-04T23:00:00.000Z", end: null, status: "scheduled", price: null, url: null, evidence: "Uncle Vanya" }, { title: 42, start: "soon" }] },
        },
      ],
    };
    writeFileSync(join(dir, "old.json"), JSON.stringify(old));
    const r = await runFirstParty(db, { fromFile: join(dir, "old.json"), now: () => NOW });
    expect(r.occurrences).toBe(1);
    expect((await at("Delancey Playhouse")).map((o) => o.title)).toEqual(["Uncle Vanya"]);
    expect(await factsOf("Uncle Vanya")).toMatchObject({ event_kind: { interests: ["theatre"] } });
  });

  it("read a theatre's events page before its hours page: a host's few requests a day go to what it is for", async () => {
    const orchard = await venueId("Delancey Playhouse");
    const home = "https://delanceyplayhouse.example/";
    await db.query(`delete from firstparty_sites`);
    await db.query(`delete from firstparty_hosts`);
    await registerSite(db, orchard, home, "auto: its own website lists its events", true);
    const asked: string[] = [];
    const show = { "@context": "https://schema.org", "@type": "TheaterEvent", name: "Our Town", startDate: "2026-10-04T19:30" };
    const pages: Record<string, string> = {
      [home]: `<html><body><a href="/visit">Plan your visit</a><a href="/shows/">Shows</a></body></html>`,
      "https://delanceyplayhouse.example/shows/": `<html><head><script type="application/ld+json">${JSON.stringify(show)}</script></head><body></body></html>`,
      "https://delanceyplayhouse.example/visit": `<html><body><p>Box office: daily 10am - 6pm</p></body></html>`,
    };
    const fetcher: SiteFetcher = {
      async robots(origin, gate) {
        await gate(new URL(`${origin}/robots.txt`));
        asked.push("robots");
        return { status: "none", rules: [], crawlDelayS: null };
      },
      async page(url, o) {
        await o.gate(new URL(url));
        asked.push(new URL(url).pathname);
        if (!pages[url]) throw new FetchFailed("404", 404);
        return extractPage(pages[url]!, url, NOW, { text: o.text });
      },
      async text() {
        throw new FetchFailed("404", 404);
      },
    };
    await runFirstParty(db, { areaSlug: "les", fetcher, now: () => NOW });
    expect(asked.slice(0, 3)).toEqual(["robots", "/", "/shows/"]);
    expect((await at("Delancey Playhouse")).map((o) => o.title)).toContain("Our Town");
  });
});
