import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { testDatabaseAvailable, reset } from "@outrn/db";
import { materializeSubjects, writeFacts } from "@outrn/facts";
import { extractPage, FetchBlocked, FetchFailed, type FirstPartyExtraction, type RobotsPolicy } from "@outrn/sources";
import { discoverSites, factsFromExtraction, runFirstParty, type SiteFetcher } from "../src/firstparty-job.js";
import { ingestOsmArea } from "../src/pipeline.js";

/** Venues' own websites, found and read as robots.txt allows: against a real Postgres + PostGIS (outrn_test, reset per file). */

const BASE = process.env["DATABASE_URL"] ?? "postgres://outrn@127.0.0.1:54329/outrn";
const TEST_URL = BASE.replace(/\/[^/]+$/, "/outrn_test");
const FIXTURE = resolve(__dirname, "../../../fixtures/osm/les-synthetic.json");
const NOW = new Date("2026-10-18T16:00:00Z");

let db: pg.Pool;
const available = await testDatabaseAvailable(BASE);

const venueId = async (name: string) => (await db.query<{ id: string }>(`select id from venues where canonical_name = $1`, [name])).rows[0]!.id;
const setWebsite = async (name: string, url: string) => {
  const id = await venueId(name);
  await writeFacts(db, [{ subjectKind: "venue", subjectId: id, attribute: "website", value: { value: url }, evidenceClass: "published", sourceId: "osm", evidence: `website=${url}`, fetchedAt: NOW, confidence: 0.8 }]);
  await materializeSubjects(db, "venue", [id]);
};
const hoursOf = async (name: string) =>
  (await db.query<{ value: { weekly?: unknown[] }; source_ids: string[]; evidence_class: string }>(`select value, source_ids, evidence_class from current_facts where subject_kind = 'venue' and subject_id = $1 and attribute = 'opening_hours'`, [await venueId(name)])).rows[0];
const siteOf = async (name: string) => (await db.query<{ url: string; last_status: string | null; auto: boolean }>(`select url, last_status, auto from firstparty_sites where venue_id = $1`, [await venueId(name)])).rows[0];

const page = (body: string) => `<html><head><title>x</title></head><body>${body}</body></html>`;
const HOURS = `<h3>Hours</h3><p>Monday - Thursday: 11am - 10pm</p><p>Friday - Saturday: 11am - 11pm</p><p>Sunday: noon - 9pm</p>`;

/** A web of fake sites: robots.txt by host, pages (or failures) by URL; it counts what was asked. */
function fakeWeb(robots: Record<string, RobotsPolicy>, pages: Record<string, string | Error>): SiteFetcher & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    async robots(_origin, host) {
      asked.push(`robots:${host}`);
      return robots[host] ?? { status: "none", rules: [], crawlDelayS: null };
    },
    async page(url, o): Promise<FirstPartyExtraction> {
      asked.push(url);
      const p = pages[url];
      if (p === undefined) throw new FetchFailed(`404 from ${new URL(url).host}`, 404);
      if (p instanceof Error) throw p;
      return extractPage(p, url, NOW, { text: o.text });
    },
  };
}

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
  await setWebsite("Essex Kitchen", "https://www.essexkitchen-nyc.com/");
  await setWebsite("Attorney Coffee", "https://attorneycoffee.com/");
  await setWebsite("Essex Bar", "https://essexbar.com/");
  await setWebsite("Ludlow Kitchen", "https://ludlowkitchen-nyc.com/");
  await setWebsite("Broome Kitchen", "https://www.facebook.com/broomekitchen");
});

afterAll(async () => {
  if (db) await db.end();
});

describe.skipIf(!available)("venues' own websites", () => {
  it("registers the own website of each venue no source publishes hours for, never a social or ordering page, once", async () => {
    const s = await discoverSites(db, { areaSlug: "les" });
    expect(s.registered).toBeGreaterThanOrEqual(3);
    expect(s.notOwn).toBe(1);
    expect(await siteOf("Essex Kitchen")).toMatchObject({ url: "https://www.essexkitchen-nyc.com/", auto: true });
    expect(await siteOf("Attorney Coffee")).toMatchObject({ url: "https://attorneycoffee.com/" });
    // Ludlow Kitchen's hours are published (OSM): its site is not needed. A Facebook page is no own site.
    expect(await siteOf("Ludlow Kitchen")).toBeUndefined();
    expect(await siteOf("Broome Kitchen")).toBeUndefined();
    expect((await discoverSites(db, { areaSlug: "les" })).registered).toBe(0);
    // The fixture's other sites (its made-up domains) aren't read in these tests.
    await db.query(`delete from firstparty_sites where url like '%.example%'`);
  });

  it("reads hours from a page's words, or the page it links to for them; reads nothing robots.txt disallows", async () => {
    const web = fakeWeb(
      { "essexbar.com": { status: "ok", rules: [{ allow: false, path: "/" }], crawlDelayS: null } },
      {
        "https://www.essexkitchen-nyc.com/": page(`<p>Welcome</p>${HOURS}`),
        "https://attorneycoffee.com/": page(`<p>Coffee</p><a href="/visit">Plan your visit</a>`),
        "https://attorneycoffee.com/visit": page(`<p>Daily 7am - 6pm</p>`),
        "https://essexbar.com/": page(HOURS),
      },
    );
    const s = await runFirstParty(db, { areaSlug: "les", fetcher: web, now: () => NOW });
    expect(s).toMatchObject({ sites: 3, hours: 2, robots: 1, failed: 0 });
    const kitchen = await hoursOf("Essex Kitchen");
    expect(kitchen?.source_ids).toContain("firstparty");
    expect(kitchen?.evidence_class).toBe("published");
    expect(kitchen?.value.weekly).toHaveLength(7);
    expect((await hoursOf("Attorney Coffee"))?.value.weekly).toHaveLength(7);
    // Robots.txt said no: its page was never asked for.
    expect(web.asked).not.toContain("https://essexbar.com/");
    expect((await siteOf("Essex Bar"))?.last_status).toBe("robots: disallowed");
    expect(await hoursOf("Essex Bar")).toBeUndefined();
  });

  it("leaves a host alone when it asks for a pause, and follows a site that moved when its new host's robots.txt allows", async () => {
    await db.query(`update firstparty_sites set last_fetched_at = null`);
    await db.query(`delete from firstparty_hosts`);
    const moved = new FetchBlocked("cross-host redirect www.essexkitchen-nyc.com -> essexkitchen.nyc");
    moved.redirectTo = "https://essexkitchen.nyc/";
    const web = fakeWeb(
      {},
      {
        "https://www.essexkitchen-nyc.com/": moved,
        "https://essexkitchen.nyc/": page(HOURS),
        "https://attorneycoffee.com/": new FetchFailed("429 from attorneycoffee.com", 429, 7200),
      },
    );
    await runFirstParty(db, { areaSlug: "les", fetcher: web, now: () => NOW });
    expect((await siteOf("Essex Kitchen"))?.last_status).toBe("ok (moved to essexkitchen.nyc)");
    expect(web.asked).toContain("robots:essexkitchen.nyc");
    expect((await siteOf("Attorney Coffee"))?.last_status).toBe("later: 429 (waiting 6 h)");
    const host = await db.query<{ retry_after: Date }>(`select retry_after from firstparty_hosts where host = 'attorneycoffee.com'`);
    expect(host.rows[0]!.retry_after.getTime()).toBe(NOW.getTime() + 6 * 3_600_000);
    // An hour later it is still waiting: nothing is asked of it.
    await db.query(`update firstparty_sites set last_fetched_at = null`);
    const again = fakeWeb({}, { "https://www.essexkitchen-nyc.com/": page(HOURS) });
    const s = await runFirstParty(db, { areaSlug: "les", fetcher: again, now: () => new Date(NOW.getTime() + 3_600_000) });
    expect(again.asked.some((u) => u.includes("attorneycoffee"))).toBe(false);
    expect(s.deferred).toBe(1);
  });

  it("stops counting hours a site no longer states, and reads no words for hours on a host many venues share", async () => {
    await db.query(`update firstparty_sites set last_fetched_at = null`);
    await db.query(`delete from firstparty_hosts`);
    await runFirstParty(db, { areaSlug: "les", fetcher: fakeWeb({}, { "https://www.essexkitchen-nyc.com/": page(`<p>New site, coming soon</p>`) }), now: () => NOW });
    expect((await hoursOf("Essex Kitchen"))?.source_ids ?? []).not.toContain("firstparty");
    // Two venues on one town site: its pages' words are the town's, not theirs.
    await db.query(`update firstparty_sites set url = 'https://www.lesparks-nyc.org/' || substr(md5(venue_id::text), 1, 6), last_fetched_at = null`);
    await db.query(`delete from firstparty_hosts`);
    const pages = Object.fromEntries((await db.query<{ url: string }>(`select url from firstparty_sites`)).rows.map((r) => [r.url, page(HOURS)]));
    const s = await runFirstParty(db, { areaSlug: "les", fetcher: fakeWeb({}, pages), now: () => NOW });
    expect(s.hours).toBe(0);
  });

  it("saves what each site stated (never its HTML), and a replay writes the same hours into another database", async () => {
    await db.query(`update firstparty_sites set url = 'https://www.essexkitchen-nyc.com/', last_fetched_at = null where venue_id = $1`, [await venueId("Essex Kitchen")]);
    await db.query(`delete from firstparty_sites where venue_id <> $1`, [await venueId("Essex Kitchen")]);
    await db.query(`delete from firstparty_hosts`);
    const path = join(mkdtempSync(join(tmpdir(), "outrn-")), "les-sites.json");
    await runFirstParty(db, { areaSlug: "les", saveTo: path, fetcher: fakeWeb({}, { "https://www.essexkitchen-nyc.com/": page(`<script>var x = 1</script>${HOURS}`) }), now: () => NOW });
    const saved = readFileSync(path, "utf8");
    expect(saved).not.toContain("<p>");
    expect(saved).not.toContain("var x");
    expect(JSON.parse(saved).sites[0]).toMatchObject({ venue: expect.stringMatching(/^osm:/), url: "https://www.essexkitchen-nyc.com/", status: "ok" });
    // As in a fresh database: no site, no hours from it.
    await db.query(`update facts set superseded_at = now() where source_id = 'firstparty'`);
    await db.query(`delete from firstparty_sites`);
    await materializeSubjects(db, "venue", [await venueId("Essex Kitchen")]);
    expect((await hoursOf("Essex Kitchen"))?.source_ids ?? []).not.toContain("firstparty");
    const s = await runFirstParty(db, { fromFile: path });
    expect(s.hours).toBe(1);
    expect((await hoursOf("Essex Kitchen"))?.source_ids).toContain("firstparty");
    expect((await siteOf("Essex Kitchen"))?.last_status).toBe("replay: ok");
  });
});

describe("facts from a venue's own page", () => {
  it("leaves out hours in OSM's syntax that don't read, and weighs a page's words below its structured data", () => {
    const x = (facts: FirstPartyExtraction["facts"]): FirstPartyExtraction => ({ url: "https://venue.example.com/", fetchedAt: NOW, facts, events: [], blocks: 1, types: ["Restaurant"] });
    expect(factsFromExtraction(x([{ attribute: "opening_hours", value: { osm: "whenever we like" }, evidence: "x", status: "stated", method: "jsonld" }]), "v")).toEqual([]);
    expect(factsFromExtraction(x([{ attribute: "opening_hours", value: { osm: "Mo-Su 11:00-22:00" }, evidence: "x", status: "stated", method: "jsonld" }]), "v")[0]).toMatchObject({ confidence: 0.85, sourceId: "firstparty" });
    expect(factsFromExtraction(x([{ attribute: "opening_hours", value: { weekly: [{ weekday: 1, startMin: 660, endMin: 1320 }] }, evidence: "x", status: "stated", method: "text" }]), "v")[0]).toMatchObject({ confidence: 0.75 });
  });
});
