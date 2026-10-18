import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { testDatabaseAvailable, reset } from "@outrn/db";
import { materializeSubjects, writeFacts } from "@outrn/facts";
import { extractPage, FetchBlocked, FetchFailed, sameSite, type FirstPartyExtraction, type RobotsPolicy } from "@outrn/sources";
import { discoverSites, factsFromExtraction, registerSite, runFirstParty, type SiteFetcher } from "../src/firstparty-job.js";
import { setFounderFact } from "../src/founder.js";
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

/** What a fake site serves at a URL: a page, a failure, or a redirect. */
type Served = string | Error | { redirect: string };

/**
 * A web of fake sites: robots.txt by host, pages, failures or redirects by URL. Like the live
 * fetcher, it passes the gate each request before "sending" it, redirect hops included (www and
 * bare name followed, another host handed back as a move), and counts what was asked.
 */
function fakeWeb(robots: Record<string, RobotsPolicy>, pages: Record<string, Served>): SiteFetcher & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    async robots(origin, gate) {
      const u = new URL(`${origin}/robots.txt`);
      await gate(u);
      asked.push(`robots:${u.host}`);
      return robots[u.host] ?? { status: "none", rules: [], crawlDelayS: null };
    },
    async page(url, o): Promise<FirstPartyExtraction> {
      let at = new URL(url);
      for (let hop = 0; hop <= 5; hop++) {
        await o.gate(at);
        asked.push(at.toString());
        const p = pages[at.toString()];
        if (p === undefined) throw new FetchFailed(`404 from ${at.host}`, 404);
        if (p instanceof Error) throw p;
        if (typeof p !== "string") {
          const next = new URL(p.redirect, at);
          if (next.host !== at.host && !sameSite(next.host, at.host)) {
            const moved = new FetchBlocked(`cross-host redirect ${at.host} -> ${next.host}`);
            moved.redirectTo = next.toString();
            throw moved;
          }
          at = next;
          continue;
        }
        return extractPage(p, at.toString(), NOW, { text: o.text });
      }
      throw new FetchBlocked("too many redirects");
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
    // A theatre's or museum's own site is read for its events, whatever source publishes its hours.
    const reason = async (name: string) => (await db.query<{ reason: string }>(`select reason from firstparty_sites where venue_id = $1`, [await venueId(name)])).rows[0]?.reason;
    expect(await reason("Delancey Playhouse")).toBe("auto: its own website lists its events");
    expect(await reason("Orchard Museum")).toBe("auto: its own website lists its events");
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
    // Found, not registered by hand: its own source, trusted below the founder.
    expect(kitchen?.source_ids).toContain("firstparty_found");
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
    const web = fakeWeb(
      {},
      {
        "https://www.essexkitchen-nyc.com/": { redirect: "https://essexkitchen.nyc/" },
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
    expect((await hoursOf("Essex Kitchen"))?.source_ids ?? []).not.toContain("firstparty_found");
    // Two venues on one town site: its pages' words are the town's, not theirs.
    await db.query(`update firstparty_sites set url = 'https://www.lesparks-nyc.org/' || substr(md5(venue_id::text), 1, 6), last_fetched_at = null`);
    await db.query(`delete from firstparty_hosts`);
    const pages = Object.fromEntries((await db.query<{ url: string }>(`select url from firstparty_sites`)).rows.map((r) => [r.url, page(HOURS)]));
    const s = await runFirstParty(db, { areaSlug: "les", fetcher: fakeWeb({}, pages), now: () => NOW });
    expect(s.hours).toBe(0);
  });

  it("asks robots.txt before every hop: a redirect to a disallowed path, or to a www. host whose robots.txt refuses, is never requested (PR #57 review)", async () => {
    await db.query(`update firstparty_sites set last_fetched_at = null, fetch_interval_h = 168`);
    await db.query(`delete from firstparty_hosts`);
    await db.query(`update firstparty_sites set url = 'https://essexbar.com/start' where venue_id = $1`, [await venueId("Essex Bar")]);
    await db.query(`update firstparty_sites set url = 'https://attorneycoffee.com/' where venue_id = $1`, [await venueId("Attorney Coffee")]);
    await db.query(`update firstparty_sites set url = 'https://www.essexkitchen-nyc.com/' where venue_id = $1`, [await venueId("Essex Kitchen")]);
    await db.query(`delete from firstparty_sites where url like '%lesparks-nyc%'`);
    const web = fakeWeb(
      {
        "essexbar.com": { status: "ok", rules: [{ allow: false, path: "/private" }], crawlDelayS: null },
        "www.attorneycoffee.com": { status: "ok", rules: [{ allow: false, path: "/" }], crawlDelayS: null },
      },
      {
        "https://essexbar.com/start": { redirect: "/private/hours" },
        "https://essexbar.com/private/hours": page(HOURS),
        "https://attorneycoffee.com/": { redirect: "https://www.attorneycoffee.com/" },
        "https://www.attorneycoffee.com/": page(HOURS),
        "https://www.essexkitchen-nyc.com/": page(HOURS),
      },
    );
    const s = await runFirstParty(db, { areaSlug: "les", fetcher: web, now: () => NOW });
    expect(web.asked).toContain("https://essexbar.com/start");
    expect(web.asked).not.toContain("https://essexbar.com/private/hours");
    expect(web.asked).toContain("robots:www.attorneycoffee.com");
    expect(web.asked).not.toContain("https://www.attorneycoffee.com/");
    expect(s.robots).toBe(2);
    expect((await siteOf("Essex Bar"))?.last_status).toBe("robots: disallowed");
    expect((await siteOf("Attorney Coffee"))?.last_status).toBe("robots: disallowed");
  });

  it("charges each host's daily allowance per request it gets, redirects included, and a moved site's new host its own (PR #57 review)", async () => {
    await db.query(`delete from firstparty_hosts`);
    // Three venues on one host, each page a redirect: robots.txt, then two requests a page.
    const ids = [await venueId("Essex Kitchen"), await venueId("Attorney Coffee"), await venueId("Essex Bar")];
    for (const [i, id] of ids.entries()) await db.query(`update firstparty_sites set url = $2, last_fetched_at = null where venue_id = $1`, [id, `https://onehost.example.com/start${i}`]);
    const pages: Record<string, Served> = {};
    for (const i of [0, 1, 2]) {
      pages[`https://onehost.example.com/start${i}`] = { redirect: `/end${i}` };
      pages[`https://onehost.example.com/end${i}`] = page(HOURS);
    }
    const web = fakeWeb({}, pages);
    const s = await runFirstParty(db, { areaSlug: "les", fetcher: web, now: () => NOW });
    // Four requests and no more: robots.txt, one site's start and end, the next site's start. Its end and
    // the third site wait for tomorrow.
    expect(web.asked).toHaveLength(4);
    expect(web.asked[0]).toBe("robots:onehost.example.com");
    expect(web.asked[1]!.replace("start", "end")).toBe(web.asked[2]);
    expect(web.asked[3]).toMatch(/\/start\d$/);
    expect(s.deferred).toBe(2);
    expect((await db.query<{ requests: number }>(`select requests from firstparty_hosts where host = 'onehost.example.com'`)).rows[0]!.requests).toBe(4);
    // Two sites that moved to one host: that host's own allowance (three of four already spent today) holds.
    await db.query(`delete from firstparty_hosts`);
    await db.query(`insert into firstparty_hosts (host, robots_status, robots_fetched_at, requests_on, requests) values ('target.example.com', 'none', $1, $2::date, 3)`, [NOW, NOW.toISOString().slice(0, 10)]);
    await db.query(`update firstparty_sites set url = 'https://a.example.com/', last_fetched_at = null where venue_id = $1`, [ids[0]]);
    await db.query(`update firstparty_sites set url = 'https://b.example.com/', last_fetched_at = null where venue_id = $1`, [ids[1]]);
    await db.query(`update firstparty_sites set enabled = false where venue_id = $1`, [ids[2]]);
    const movers = fakeWeb({}, { "https://a.example.com/": { redirect: "https://target.example.com/a" }, "https://b.example.com/": { redirect: "https://target.example.com/b" }, "https://target.example.com/a": page(HOURS), "https://target.example.com/b": page(HOURS) });
    const m = await runFirstParty(db, { areaSlug: "les", fetcher: movers, now: () => NOW });
    expect(movers.asked.filter((u) => u.startsWith("https://target.example.com/"))).toHaveLength(1);
    expect(m.deferred).toBe(1);
    await db.query(`update firstparty_sites set enabled = true`);
  });

  it("saves nothing over a good capture when no site could be read, and keeps an earlier read for a site that failed this time (PR #57 review)", async () => {
    await db.query(`delete from firstparty_hosts`);
    await db.query(`delete from firstparty_sites where venue_id not in ($1, $2)`, [await venueId("Essex Kitchen"), await venueId("Attorney Coffee")]);
    await db.query(`update firstparty_sites set url = 'https://www.essexkitchen-nyc.com/', last_fetched_at = null where venue_id = $1`, [await venueId("Essex Kitchen")]);
    await db.query(`update firstparty_sites set url = 'https://attorneycoffee.com/', last_fetched_at = null where venue_id = $1`, [await venueId("Attorney Coffee")]);
    const dir = mkdtempSync(join(tmpdir(), "outrn-"));
    const good = join(dir, "les-sites.json");
    // A good capture: both sites read.
    await runFirstParty(db, { areaSlug: "les", saveTo: good, fetcher: fakeWeb({}, { "https://www.essexkitchen-nyc.com/": page(HOURS), "https://attorneycoffee.com/": page(HOURS) }), now: () => NOW });
    const before = readFileSync(good, "utf8");
    expect(JSON.parse(before).sites.filter((x: { read?: unknown }) => x.read)).toHaveLength(2);
    // Every site fails: a failed run, and the good capture is untouched.
    await db.query(`update firstparty_sites set last_fetched_at = null`);
    await db.query(`delete from firstparty_hosts`);
    const down = new FetchFailed("service unavailable", 500);
    const failed = await runFirstParty(db, { areaSlug: "les", saveTo: good, keep: good, fetcher: fakeWeb({}, { "https://www.essexkitchen-nyc.com/": down, "https://attorneycoffee.com/": down }), now: () => NOW });
    expect(failed.outcome).toBe("failed");
    expect(readFileSync(good, "utf8")).toBe(before);
    // One reads and one fails: saved, with the earlier read kept for the one that failed.
    await db.query(`update firstparty_sites set last_fetched_at = null`);
    await db.query(`delete from firstparty_hosts`);
    const next = join(dir, "next.json");
    const partial = await runFirstParty(db, { areaSlug: "les", saveTo: next, keep: good, fetcher: fakeWeb({}, { "https://www.essexkitchen-nyc.com/": page(HOURS), "https://attorneycoffee.com/": down }), now: () => NOW });
    expect(partial.outcome).toBe("partial");
    const sites = JSON.parse(readFileSync(next, "utf8")).sites as { url: string; status: string; read?: unknown }[];
    expect(sites.map((x) => `${x.url} ${x.status} ${Boolean(x.read)}`).sort()).toEqual(["https://attorneycoffee.com/ ok true", "https://www.essexkitchen-nyc.com/ ok true"]);
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
    await db.query(`update facts set superseded_at = now() where source_id in ('firstparty', 'firstparty_found')`);
    await db.query(`delete from firstparty_sites`);
    await materializeSubjects(db, "venue", [await venueId("Essex Kitchen")]);
    expect((await hoursOf("Essex Kitchen"))?.source_ids ?? []).not.toContain("firstparty_found");
    const s = await runFirstParty(db, { fromFile: path });
    expect(s.hours).toBe(1);
    expect((await hoursOf("Essex Kitchen"))?.source_ids).toContain("firstparty_found");
    expect((await siteOf("Essex Kitchen"))?.last_status).toBe("replay: ok");
  });
});

describe.skipIf(!available)("a site found, not checked", () => {
  it("never lifts members_only, and stands below the founder's own check (which it contests)", async () => {
    const id = await venueId("Essex Bar");
    const site = "https://www.essex-members-club.example/";
    await writeFacts(db, [{ subjectKind: "venue", subjectId: id, attribute: "admission", value: { requirement: "members_only" }, evidenceClass: "published", sourceId: "osm", evidence: "access=private", fetchedAt: NOW, confidence: 0.7 }]);
    await registerSite(db, id, site, "auto: its own website; no source publishes its hours", true);
    await setFounderFact(db, { venueId: id, attribute: "opening_hours", value: { osm: "Mo-Su 09:00-12:00" }, evidence: "called 10/17: 9 to noon only", verifiedAt: new Date("2026-10-17T15:00:00Z") });
    const ld = `<script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@type": "Restaurant", name: "Essex Members Club", acceptsReservations: false })}</script>`;
    await runFirstParty(db, { areaSlug: "les", fetcher: fakeWeb({}, { [site]: page(`${ld}${HOURS}`) }), now: () => NOW });
    const cur = async (attribute: string) =>
      (await db.query<{ value: unknown; source_ids: string[]; conflict: boolean }>(`select value, source_ids, conflict from current_facts where subject_kind = 'venue' and subject_id = $1 and attribute = $2`, [id, attribute])).rows[0];
    expect((await cur("admission"))?.value).toEqual({ requirement: "members_only" });
    const hours = await cur("opening_hours");
    expect(hours?.source_ids).toEqual(["founder"]);
    expect(hours?.conflict).toBe(true);
  });
});

describe("facts from a venue's own page", () => {
  it("leaves out hours in OSM's syntax that don't read, and weighs a page's words below its structured data", () => {
    const x = (facts: FirstPartyExtraction["facts"]): FirstPartyExtraction => ({ url: "https://venue.example.com/", fetchedAt: NOW, facts, events: [], blocks: 1, types: ["Restaurant"] });
    expect(factsFromExtraction(x([{ attribute: "opening_hours", value: { osm: "whenever we like" }, evidence: "x", status: "stated", method: "jsonld" }]), "v")).toEqual([]);
    expect(factsFromExtraction(x([{ attribute: "opening_hours", value: { osm: "Mo-Su 11:00-22:00" }, evidence: "x", status: "stated", method: "jsonld" }]), "v")[0]).toMatchObject({ confidence: 0.85, sourceId: "firstparty" });
    expect(factsFromExtraction(x([{ attribute: "opening_hours", value: { weekly: [{ weekday: 1, startMin: 660, endMin: 1320 }] }, evidence: "x", status: "stated", method: "text" }]), "v")[0]).toMatchObject({ confidence: 0.75 });
    // A found site's facts are its own source, and say nothing of admission.
    const admission: FirstPartyExtraction["facts"][number] = { attribute: "admission", value: { requirement: "walk_in" }, evidence: "x", status: "stated" };
    expect(factsFromExtraction(x([admission]), "v", true)).toEqual([]);
    expect(factsFromExtraction(x([admission]), "v")[0]).toMatchObject({ sourceId: "firstparty" });
    expect(factsFromExtraction(x([{ attribute: "opening_hours", value: { osm: "Mo-Su 11:00-22:00" }, evidence: "x", status: "stated", method: "jsonld" }]), "v", true)[0]).toMatchObject({ sourceId: "firstparty_found" });
  });
});
