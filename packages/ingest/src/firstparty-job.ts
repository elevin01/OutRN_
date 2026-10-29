import { readFile, rename, writeFile } from "node:fs/promises";
import { websiteUrl, type Attribute, type FactInput } from "@outrn/core";
import { assertSourceAllowed, getArea, withTx, type Db, type Queryable } from "@outrn/db";
import { evaluateHours, materializeSubjects, writeFacts } from "@outrn/facts";
import {
  currentUserAgent,
  fetchAndExtract,
  fetchRobots,
  finishRun,
  guardedFetch,
  robotsAllows,
  sameSite,
  startRun,
  FetchBlocked,
  FetchFailed,
  RequestRefused,
  type CalendarEvent,
  type FirstPartyExtraction,
  type RequestGate,
  type RobotsPolicy,
} from "@outrn/sources";
import { CALENDAR_DAYS } from "./calendars.js";
import { calendarEventsOf, readSiteFeed, reviveCalendarEvents, reviveExtractedEvents, writeSiteEvents, type SiteFeedReader } from "./site-events.js";

/**
 * First-party extraction job: for every due site in firstparty_sites, fetch, extract (JSON-LD, and
 * for hours microdata or the page's own words), write venue facts (source 'firstparty', published
 * class) and dated occurrences, then re-materialize the venue. Raw HTML is never stored.
 *
 * Sites are registered by hand (`firstparty add`) or found (`discoverSites`): a venue's own website,
 * when no source publishes its hours. Every request, whichever host it goes to (a redirect, a site
 * that moved, a retry), passes one gate first (hostGate): the host is not backing off, its
 * robots.txt (RFC 9309, read once a day per host) allows that very path, and one of the host's four
 * requests for the day is reserved for it, robots.txt reads included. Requests to a host are at least
 * 5 s apart (longer when its robots.txt asks), eight hosts at a time. A host that answers 429 or 503
 * is left alone for at least six hours; a page a site refuses (403) or robots.txt keeps us from is
 * asked again in a month.
 */

export interface FirstPartyRunSummary {
  runId: string;
  sites: number;
  ok: number;
  noJsonLd: number;
  blocked: number;
  failed: number;
  facts: number;
  occurrences: number;
  /** Sites whose hours were read this run (from the page, or a page it links to). */
  hours: number;
  /** Sites robots.txt keeps us from. */
  robots: number;
  /** Sites left for later: their host asked us to wait, or today's requests for it are spent. */
  deferred: number;
  /** failed: sites were tried and none could be read (nothing is saved then). */
  outcome: "succeeded" | "partial" | "failed";
}

interface SiteRow {
  id: string;
  venue_id: string;
  url: string;
  fetch_interval_h: number;
  auto: boolean;
  /** Its venue is a kind whose site is read for its events (EVENT_VENUES): they come before its hours page. */
  lists_events: boolean;
}

/**
 * The source a site's facts are written as. A site registered by hand is one the founder checked is
 * the venue's ("firstparty", trusted above a founder's call); one found from a listed website
 * (OSM's, Overture's) nobody has checked, so it is "firstparty_found", trusted below the founder.
 */
export function siteSource(auto: boolean): "firstparty" | "firstparty_found" {
  return auto ? "firstparty_found" : "firstparty";
}

/**
 * What a fetcher does: read robots.txt, and a page's extraction (tests replace it). Each passes
 * `gate` every request it sends, before sending it, redirects and retries included.
 */
export interface SiteFetcher {
  robots(origin: string, gate: RequestGate): Promise<RobotsPolicy>;
  page(url: string, opts: { gate: RequestGate; text: boolean }): Promise<FirstPartyExtraction>;
  /** A feed's text (The Events Calendar's JSON, iCalendar), of the content types given. */
  text(url: string, opts: { gate: RequestGate; accept: string; contentTypes: string[] }): Promise<string>;
}

export function liveSiteFetcher(): SiteFetcher {
  const userAgent = currentUserAgent();
  return {
    robots: (origin, gate) => fetchRobots(origin, { userAgent, beforeRequest: gate }),
    page: (url, o) => fetchAndExtract(url, { beforeRequest: o.gate, text: o.text }),
    text: async (url, o) =>
      (await guardedFetch(url, { sourceId: "firstparty", beforeRequest: o.gate, accept: o.accept, allowedContentTypes: o.contentTypes, maxBytes: 8 * 1024 * 1024, timeoutMs: 30_000, retries: 1, sameSiteRedirects: true })).text,
  };
}

/** The source policy's limits (0024): hosts at a time, a host's requests apart, and requests per host a day. */
/** An error as one short line: some carry the page they got ("404 from x: <!doctype html>…"). */
const oneLine = (s: string) => s.replace(/\s+/g, " ").slice(0, 120);

/** The launch areas' zone: a site's date and time with no offset is read in it, and its feed asked for in it. */
const SITE_TIME_ZONE = "America/New_York";

export const FIRSTPARTY_LIMITS = { hostsAtOnce: 8, minIntervalMs: 5000, perHostPerDay: 4, robotsMaxAgeH: 24, backoffH: 6, refusedRecheckH: 720 } as const;

export async function registerSite(q: Queryable, venueId: string, url: string, reason: string, auto = false): Promise<void> {
  await q.query(
    `insert into firstparty_sites (venue_id, url, reason, auto) values ($1, $2, $3, $4)
     on conflict (venue_id, url) do update set reason = excluded.reason, enabled = true, auto = excluded.auto`,
    [venueId, url, reason, auto],
  );
}

/**
 * A website that is a venue's own, as far as its address says: not a social network, a review site,
 * a map, a booking or ordering service, or a link page. Their pages are someone else's words about
 * many places, and most of their terms forbid reading them this way.
 */
const NOT_OWN_SITE = /(?:^|\.)(?:facebook|fb|instagram|twitter|x|tiktok|youtube|linkedin|pinterest|yelp|tripadvisor|google|goo|foursquare|zomato|doordash|grubhub|ubereats|seamless|postmates|caviar|slicelife|opentable|resy|exploretock|sevenrooms|toasttab|squareup|square|clover|menufy|chownow|beyondmenu|allmenus|menupages|linktr|carrd|eventbrite|ticketmaster|wikipedia|wikidata|apple|amazon)\.[a-z.]+$/i;

export function ownSiteUrl(raw: string | null | undefined): string | null {
  const url = websiteUrl(raw);
  if (!url) return null;
  return NOT_OWN_SITE.test(new URL(url).hostname) ? null : url;
}

/** Kinds of place whose own site is read for its events, whatever source publishes their hours. Not cinemas: showtimes are not events. */
export const EVENT_VENUES: ReadonlySet<string> = new Set(["theatre", "live_music", "arts_centre", "museum", "community"]);

export interface DiscoverSummary {
  /** Venues with a website and no published hours. */
  candidates: number;
  registered: number;
  /** Their website is not their own (social, review, ordering, booking). */
  notOwn: number;
}

/**
 * Register the own websites of venues (of one area, or all) that no source publishes hours for.
 * Already registered venues are left as they are; a venue that later gets published hours keeps its
 * site, whose hours then stand beside the others' (the materializer weighs them).
 */
export async function discoverSites(db: Db, opts: { areaSlug?: string; limit?: number } = {}): Promise<DiscoverSummary> {
  const areaId = opts.areaSlug ? (await getArea(db, opts.areaSlug)).id : null;
  const rows = (
    await db.query<{ id: string; website: string | null; listsEvents: boolean }>(
      `select v.id, w.value->>'value' as website, v.category = any($3::text[]) as "listsEvents" from venues v
         join current_facts w on w.subject_kind = 'venue' and w.subject_id = v.id and w.attribute = 'website'
         left join current_facts h on h.subject_kind = 'venue' and h.subject_id = v.id and h.attribute = 'opening_hours'
        where v.publish_state <> 'merged' and ($1::uuid is null or v.area_id = $1)
          and (h.subject_id is null or h.evidence_class = 'estimate' or v.category = any($3::text[]))
          and not exists (select 1 from firstparty_sites f where f.venue_id = v.id)
        order by v.id limit $2`,
      [areaId, opts.limit ?? 100_000, [...EVENT_VENUES]],
    )
  ).rows;
  const s: DiscoverSummary = { candidates: rows.length, registered: 0, notOwn: 0 };
  for (const r of rows) {
    const url = ownSiteUrl(r.website);
    if (!url) {
      s.notOwn++;
      continue;
    }
    await registerSite(db, r.id, url, r.listsEvents ? "auto: its own website lists its events" : "auto: its own website; no source publishes its hours", true);
    s.registered++;
  }
  return s;
}

/** How confident a fact read from a venue's own page is: structured data it published, or its words read strictly. */
function confidenceOf(f: FirstPartyExtraction["facts"][number]): number {
  if (f.status !== "stated") return 0.5;
  return f.method === "text" ? 0.75 : 0.85;
}

/** Hours in OSM's syntax that don't read are no hours (a site's own shorthand): left out rather than stored. */
function readable(f: FirstPartyExtraction["facts"][number], at: Date): boolean {
  if (f.attribute !== "opening_hours") return true;
  const v = f.value as { osm?: unknown };
  if (typeof v.osm !== "string") return true;
  return !evaluateHours({ osm: v.osm }, at, "America/New_York").parseError;
}

export function factsFromExtraction(x: FirstPartyExtraction, venueId: string, auto = false): FactInput[] {
  const out: FactInput[] = [];
  for (const f of x.facts) {
    if (f.status === "not_stated" || !readable(f, x.fetchedAt)) continue;
    // Whether a site takes reservations says nothing of who may come in: from a site nobody checked
    // it must not stand in for a private club's members_only (a template's acceptsReservations: false).
    if (auto && f.attribute === "admission") continue;
    out.push({
      subjectKind: "venue",
      subjectId: venueId,
      attribute: f.attribute as Attribute,
      value: f.value,
      evidenceClass: "published",
      sourceId: siteSource(auto),
      evidence: `${x.url} :: ${f.evidence}`,
      fetchedAt: x.fetchedAt,
      sourceUpdatedAt: null,
      confidence: confidenceOf(f),
      lineageGroup: `firstparty:${new URL(x.url).hostname}`,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Capture and replay: what each site stated (never its HTML), keyed by the venue's source record.

interface CapturedSite {
  /** The venue, by a source record that names it in any database: "osm:node/123", "overture:…". */
  venue: string;
  url: string;
  status: string;
  /** What was read, when anything was. */
  read?: FirstPartyExtraction;
  /** Its events as read: its page's and its feed's (absent in a capture from before feeds were read). */
  events?: CalendarEvent[];
  /** Its hours page could not be read: the read says nothing of its hours (an earlier capture's are kept). */
  hoursUnread?: true;
}

export interface FirstPartyCapture {
  outrn_capture: "firstparty-sites";
  area: string | null;
  fetchedAt: string;
  sites: CapturedSite[];
}

async function venueKey(q: Queryable, venueId: string): Promise<string | null> {
  return (
    await q.query<{ key: string }>(
      `select se.source_id || ':' || se.external_id as key from entity_links l join source_entities se on se.id = l.source_entity_id
        where l.venue_id = $1 and l.superseded_by is null and l.decision <> 'rejected'
        order by (se.source_id = 'osm') desc, se.external_id limit 1`,
      [venueId],
    )
  ).rows[0]?.key ?? null;
}

async function venueByKey(q: Queryable, key: string): Promise<string | null> {
  const i = key.indexOf(":");
  if (i < 1) return null;
  return (
    await q.query<{ venue_id: string }>(
      `select l.venue_id from entity_links l join source_entities se on se.id = l.source_entity_id
        where se.source_id = $1 and se.external_id = $2 and l.superseded_by is null and l.decision <> 'rejected' limit 1`,
      [key.slice(0, i), key.slice(i + 1)],
    )
  ).rows[0]?.venue_id ?? null;
}

function revive(x: FirstPartyExtraction): FirstPartyExtraction {
  // Its events checked as JSON: a capture from before a field was kept has only the older ones.
  return { ...x, fetchedAt: new Date(x.fetchedAt), events: reviveExtractedEvents(x.events) };
}

// ---------------------------------------------------------------------------------------------

/**
 * Write what a site stated for a venue: its facts, and, when a page was read and states no hours, no
 * hours from it any more; then its events (see site-events.ts), as the source venue_events.
 */
async function writeExtraction(db: Db, runId: string, venueId: string, x: FirstPartyExtraction, s: FirstPartyRunSummary, auto: boolean, events: readonly CalendarEvent[], now: Date, hoursUnread = false, eventsComplete = false): Promise<void> {
  await withTx(db, async (tx) => {
    const w = await writeFacts(tx, factsFromExtraction(x, venueId, auto).map((f) => ({ ...f, ingestionRunId: runId })));
    s.facts += w.inserted;
    // Hours its own site no longer states (moved, or taken down) stop counting as published; not when
    // the page that states them could not be read this time (it failed, or its host asked us to wait).
    if (!hoursUnread && !x.facts.some((f) => f.attribute === "opening_hours")) {
      await tx.query(
        `update facts set superseded_at = now() where subject_kind = 'venue' and subject_id = $1 and source_id in ('firstparty', 'firstparty_found') and attribute = 'opening_hours' and superseded_at is null`,
        [venueId],
      );
    }
    await materializeSubjects(tx, "venue", [venueId]);
  });
  // A feed read whole that lists nothing still says the site's earlier events are gone.
  if (events.length || eventsComplete) s.occurrences += (await writeSiteEvents(db, { venueId, host: new URL(x.url).hostname, auto }, events, now, { complete: eventsComplete })).written;
}

interface HostRow {
  robots_status: string;
  robots_rules: RobotsPolicy["rules"];
  crawl_delay_s: string | null;
  robots_fetched_at: Date;
  retry_after: Date | null;
}

/**
 * The one gate every request passes (see the header), for a run: each host's back-off, its
 * robots.txt for the very path, a reservation of one of its requests for the day, and its pace.
 * Hosts are found as requests go to them: a redirect or a moved site's new host is gated as its own.
 */
function hostGate(db: Db, fetcher: SiteFetcher, clock: () => Date) {
  const policies = new Map<string, Promise<RobotsPolicy>>();
  const delays = new Map<string, number>();
  const pace = (host: string) => ({ throttleKey: `firstparty:${host}`, minIntervalMs: Math.max(FIRSTPARTY_LIMITS.minIntervalMs, (delays.get(host) ?? 0) * 1000) });

  /** One of the host's requests for today, or a refusal when they are spent (atomic: hosts are read side by side). */
  const reserve = async (host: string): Promise<void> => {
    const today = clock().toISOString().slice(0, 10);
    const r = await db.query(
      `insert into firstparty_hosts as h (host, robots_status, robots_fetched_at, requests_on, requests) values ($1, 'unreachable', 'epoch', $2::date, 1)
       on conflict (host) do update set requests = case when h.requests_on = $2::date then h.requests + 1 else 1 end, requests_on = $2::date
        where h.requests_on is distinct from $2::date or h.requests < $3
       returning requests`,
      [host, today, FIRSTPARTY_LIMITS.perHostPerDay],
    );
    if (!r.rowCount) throw new RequestRefused(`today's requests for ${host} are spent`, "allowance", host);
  };
  const row = async (host: string) => (await db.query<HostRow>(`select robots_status, robots_rules, crawl_delay_s, robots_fetched_at, retry_after from firstparty_hosts where host = $1`, [host])).rows[0];
  const notBackingOff = async (host: string) => {
    const r = await row(host);
    if (r?.retry_after && r.retry_after > clock()) throw new RequestRefused(`${host} asked us to wait`, "backoff", host);
    return r;
  };

  /** robots.txt for a host: today's read, or a new one (its requests reserved like any other). */
  const policyFor = (origin: string, host: string): Promise<RobotsPolicy> => {
    let p = policies.get(host);
    if (!p) {
      p = (async () => {
        const r = await row(host);
        if (r && clock().getTime() - r.robots_fetched_at.getTime() < FIRSTPARTY_LIMITS.robotsMaxAgeH * 3_600_000) {
          return { status: r.robots_status as RobotsPolicy["status"], rules: r.robots_rules, crawlDelayS: r.crawl_delay_s === null ? null : Number(r.crawl_delay_s) };
        }
        // Reading robots.txt asks no robots.txt, but it is a request like any other to whichever host it reaches.
        const policy = await fetcher.robots(origin, async (url) => {
          const h = url.host.toLowerCase();
          await notBackingOff(h);
          await reserve(h);
          return pace(h);
        });
        await db.query(
          `update firstparty_hosts set robots_status = $2, robots_rules = $3, crawl_delay_s = $4, robots_fetched_at = $5 where host = $1`,
          [host, policy.status, JSON.stringify(policy.rules), policy.crawlDelayS, clock()],
        );
        return policy;
      })();
      // A read that was refused (its allowance spent, a back-off) is tried again next time, not kept.
      p.catch(() => policies.delete(host));
      policies.set(host, p);
    }
    return p;
  };

  const gate: RequestGate = async (url) => {
    const host = url.host.toLowerCase();
    await notBackingOff(host);
    const policy = await policyFor(url.origin, host);
    delays.set(host, policy.crawlDelayS ?? 0);
    if (!robotsAllows(policy, pathOf(url))) {
      throw new RequestRefused(policy.status === "unreachable" ? `robots.txt for ${host} could not be read` : `robots.txt disallows ${pathOf(url)} on ${host}`, "robots", host);
    }
    await reserve(host);
    return pace(host);
  };
  return gate;
}

/** Words on a host's pages are read for hours: not on a government site, or one many venues share. */
function textAllowed(host: string, shared: ReadonlySet<string>): boolean {
  return !(/\.(?:gov|mil)$/i.test(host) || /\.(?:ny|ct|nj)\.us$/i.test(host) || shared.has(host.replace(/^www\./, "")));
}

/** `url` is under `page`'s own path ("/delancey/events.ics" under "/delancey"); nothing is under a home page's. */
function underPath(url: string, page: string): boolean {
  const base = new URL(page).pathname.replace(/\/?$/, "/");
  return base !== "/" && new URL(url).pathname.startsWith(base);
}

function pathOf(u: URL): string {
  return `${u.pathname}${u.search}`;
}

export interface RunOptions {
  /** Only this area's venues' sites. */
  areaSlug?: string;
  limit?: number;
  force?: boolean;
  log?: (l: string) => void;
  fetcher?: SiteFetcher;
  /** Hosts read side by side (at most the policy's). */
  concurrency?: number;
  /** Save what each site stated (never its HTML) for replay. */
  saveTo?: string;
  /** An earlier capture: what it read for a site this run could not (later, an error) is saved again. */
  keep?: string;
  /** Replay a saved capture instead of fetching. */
  fromFile?: string;
  now?: () => Date;
}

export async function runFirstParty(db: Db, opts: RunOptions = {}): Promise<FirstPartyRunSummary> {
  const log = opts.log ?? (() => undefined);
  if (opts.fromFile) return replayFirstParty(db, opts.fromFile, log, (opts.now ?? (() => new Date()))());
  await assertSourceAllowed(db, "firstparty", "fetch");
  const fetcher = opts.fetcher ?? liveSiteFetcher();
  const clock = opts.now ?? (() => new Date());
  const areaId = opts.areaSlug ? (await getArea(db, opts.areaSlug)).id : null;
  const due = (
    await db.query<SiteRow>(
      `select f.id, f.venue_id, f.url, f.fetch_interval_h, f.auto, v.category = any($4::text[]) as lists_events from firstparty_sites f join venues v on v.id = f.venue_id
        where f.enabled and ($3::uuid is null or v.area_id = $3)
          and ($2 or f.last_fetched_at is null or f.last_fetched_at < now() - (f.fetch_interval_h || ' hours')::interval)
        order by f.last_fetched_at nulls first, v.category = any($4::text[]) desc, f.id limit $1`,
      [opts.limit ?? 50, opts.force ?? false, areaId, [...EVENT_VENUES]],
    )
  ).rows;
  // Hosts many venues share (a town's parks pages, a chain's store pages): only their structured data is read.
  const sharedHosts = new Set(
    (
      await db.query<{ host: string }>(
        `select lower(regexp_replace(substring(url from '^[a-z]+://([^/:?#]+)'), '^www\\.', '')) as host from firstparty_sites group by 1 having count(distinct venue_id) > 1`,
      )
    ).rows.map((r) => r.host),
  );
  const runId = await startRun(db, { sourceId: "firstparty", kind: "firstparty_site", params: { sites: due.length, area: opts.areaSlug ?? null } });
  const s: FirstPartyRunSummary = { runId, sites: due.length, ok: 0, noJsonLd: 0, blocked: 0, failed: 0, facts: 0, occurrences: 0, hours: 0, robots: 0, deferred: 0, outcome: "succeeded" };
  const captured: CapturedSite[] = [];
  const byHost = new Map<string, SiteRow[]>();
  for (const site of due) {
    let host: string;
    try {
      host = new URL(site.url).host.toLowerCase();
    } catch {
      continue;
    }
    byHost.set(host, [...(byHost.get(host) ?? []), site]);
  }

  const finish = async (site: SiteRow, status: string, recheckH?: number) => {
    await db.query(`update firstparty_sites set last_fetched_at = now(), last_status = $2, fetch_interval_h = coalesce($3, fetch_interval_h) where id = $1`, [site.id, status, recheckH ?? null]);
    log(`  ${site.url} → ${status}`);
  };
  const gate = hostGate(db, fetcher, clock);
  /**
   * Asked to slow down (429, 503), by whichever page: the host that answered is left alone for six
   * hours at least, or as long as it asked, its other sites with it (the gate refuses it until then).
   */
  const backOff = async (e: FetchFailed, host: string): Promise<number> => {
    const hours = Math.max(FIRSTPARTY_LIMITS.backoffH, (e.retryAfterS ?? 0) / 3600);
    await db.query(`update firstparty_hosts set retry_after = $2 where host = $1`, [e.host ?? host, new Date(clock().getTime() + hours * 3_600_000)]);
    return hours;
  };

  const readHost = async (host: string, sites: SiteRow[]) => {
    for (const site of sites) {
      let status = "ok";
      let recheck: number | undefined;
      let x: FirstPartyExtraction | undefined;
      let events: CalendarEvent[] = [];
      let hoursUnread = false;
      try {
        try {
          x = await fetcher.page(site.url, { gate, text: textAllowed(host, sharedHosts) });
        } catch (e) {
          // Moved to another host: followed once, as that host's own gate allows (its robots.txt, its requests).
          const to = e instanceof FetchBlocked && e.redirectTo ? ownSiteUrl(e.redirectTo) : null;
          if (!to) throw e;
          const t = new URL(to);
          x = await fetcher.page(to, { gate, text: textAllowed(t.host.toLowerCase(), sharedHosts) });
          status = `ok (moved to ${t.host})`;
        }
        // A host's requests a day are few (robots.txt, the page, one or two more): a theatre's or music
        // room's events come before its hours page, a restaurant's hours before its events.
        const page = x;
        const hoursPage = async () => {
          // No hours on the page: the site's page for them, through the same gate.
          if (page.facts.some((f) => f.attribute === "opening_hours") || !page.hoursLinks?.length) return;
          const from = new URL(page.url);
          const link = page.hoursLinks.map((l) => new URL(l)).find((l) => sameSite(l.host, from.host));
          if (!link) return;
          try {
            const y = await fetcher.page(link.toString(), { gate, text: textAllowed(link.host.toLowerCase(), sharedHosts) });
            const hours = y.facts.filter((f) => f.attribute === "opening_hours");
            if (hours.length) x = { ...x!, url: y.url, facts: [...x!.facts.filter((f) => f.attribute !== "opening_hours"), ...hours], events: [...x!.events, ...y.events] };
          } catch (e) {
            // The page itself was read; its hours page was not, so this read says nothing of its hours:
            // the ones published stay, and a capture keeps an earlier read's. A host that asked us to
            // slow down is left alone like any other.
            if (!(e instanceof RequestRefused || e instanceof FetchBlocked || e instanceof FetchFailed)) throw e;
            hoursUnread = true;
            let why = e instanceof RequestRefused ? e.reason : e instanceof FetchFailed && e.status ? String(e.status) : "failed";
            if (e instanceof FetchFailed && (e.status === 429 || e.status === 503)) why = `${e.status}, waiting ${Math.ceil(await backOff(e, link.host))} h`;
            status = `${status} (hours page not read: ${why})`;
          }
        };
        // Its events where the page says the site lists them, through the same gate (a feed refused or
        // failed leaves the page's own).
        let feedEvents: CalendarEvent[] = [];
        let feedComplete = false;
        const eventsFeed = async () => {
          if (!page.eventsFeed) return;
          // On a host many venues share, a feed is this venue's only under its own path (a host-wide
          // one lists every venue's), and its events are keyed by the host: it never withdraws.
          const shared = sharedHosts.has(new URL(page.eventsFeed.url).hostname.toLowerCase().replace(/^www\./, ""));
          if (shared && !underPath(page.eventsFeed.url, page.url)) return;
          const reader: SiteFeedReader = { text: (u, o) => fetcher.text(u, { ...o, gate }), page: (u) => fetcher.page(u, { gate, text: false }) };
          const now = clock();
          const { read: r, slowDown } = await readSiteFeed(page.eventsFeed, reader, { now, until: new Date(now.getTime() + CALENDAR_DAYS * 86_400_000), timeZone: SITE_TIME_ZONE });
          feedEvents = r.events;
          // Only a feed read to its end says what the site no longer lists (a page lists some).
          feedComplete = !shared && page.eventsFeed.format !== "page" && r.status === "ok" && r.complete === true;
          // A feed that asked us to slow down backs its host off like any page of it would.
          const waited = slowDown ? `, waiting ${Math.ceil(await backOff(slowDown, new URL(page.eventsFeed.url).host))} h` : "";
          if (r.status !== "ok") log(`  ${site.url} events (${page.eventsFeed.format}) → ${r.status}${r.error ? `: ${oneLine(r.error)}` : ""}${waited}`);
        };
        for (const step of site.lists_events ? [eventsFeed, hoursPage] : [hoursPage, eventsFeed]) await step();
        events = [...feedEvents, ...calendarEventsOf(x.events)];
        if (!x.blocks && !x.facts.length && !x.events.length) {
          status = status === "ok" ? "no_jsonld" : status;
          s.noJsonLd++;
        } else s.ok++;
        if (x.facts.some((f) => f.attribute === "opening_hours")) s.hours++;
        await writeExtraction(db, runId, site.venue_id, x, s, site.auto, events, clock(), hoursUnread, feedComplete);
      } catch (e) {
        if (e instanceof RequestRefused && e.reason !== "robots") {
          // Its host's requests for today are spent, or it asked us to wait: this site is not due-marked,
          // and an earlier capture's read of it stands (see `keep`).
          s.deferred++;
          log(`  ${site.url} → later: ${e.message}`);
          continue;
        }
        if (e instanceof RequestRefused) {
          status = e.message.includes("could not be read") ? "robots: unreachable (nothing read)" : "robots: disallowed";
          recheck = FIRSTPARTY_LIMITS.refusedRecheckH;
          s.robots++;
        } else if (e instanceof FetchBlocked) {
          status = `blocked: ${e.message}`;
          s.blocked++;
        } else if (e instanceof FetchFailed && (e.status === 429 || e.status === 503)) {
          status = `later: ${e.status} (waiting ${Math.ceil(await backOff(e, host))} h)`;
          s.failed++;
        } else if (e instanceof FetchFailed && (e.status === 401 || e.status === 403)) {
          status = `refused: ${e.status}`;
          recheck = FIRSTPARTY_LIMITS.refusedRecheckH;
          s.blocked++;
        } else {
          status = `error: ${oneLine((e as Error).message)}`;
          s.failed++;
        }
      }
      await finish(site, status, recheck);
      captured.push({ venue: (await venueKey(db, site.venue_id)) ?? site.venue_id, url: site.url, status: status.startsWith("robots") ? "robots" : status, ...(x ? { read: x, events } : {}), ...(hoursUnread ? { hoursUnread: true as const } : {}) });
    }
  };

  // Hosts side by side, at most the policy's number at once.
  const queue = [...byHost.entries()];
  const workers = Array.from({ length: Math.max(1, Math.min(opts.concurrency ?? FIRSTPARTY_LIMITS.hostsAtOnce, FIRSTPARTY_LIMITS.hostsAtOnce)) }, async () => {
    for (let next = queue.shift(); next; next = queue.shift()) await readHost(next[0], next[1]);
  });
  await Promise.all(workers);

  // Tried and none read: a failed run, and nothing it saw replaces a capture that holds reads.
  const read = s.ok + s.noJsonLd;
  s.outcome = s.failed && !read ? "failed" : s.failed ? "partial" : "succeeded";
  if (opts.saveTo && s.outcome !== "failed") {
    const capture: FirstPartyCapture = { outrn_capture: "firstparty-sites", area: opts.areaSlug ?? null, fetchedAt: clock().toISOString(), sites: opts.keep ? await keptWith(captured, opts.keep) : captured };
    // Written whole, then moved into place: a reader never sees half a capture.
    await writeFile(`${opts.saveTo}.tmp`, JSON.stringify(capture), "utf8");
    await rename(`${opts.saveTo}.tmp`, opts.saveTo);
  }
  await finishRun(db, runId, { status: s.outcome, counts: { ...s, outcome: undefined } as unknown as Record<string, number> });
  return s;
}

/** A site this run settled (read, refused, kept out) speaks for itself; one it could not, by an earlier capture's read. */
async function keptWith(captured: CapturedSite[], earlierPath: string): Promise<CapturedSite[]> {
  let earlier: CapturedSite[] = [];
  try {
    const raw = JSON.parse(await readFile(earlierPath, "utf8")) as Partial<FirstPartyCapture>;
    if (raw.outrn_capture === "firstparty-sites" && Array.isArray(raw.sites)) earlier = raw.sites;
  } catch {
    // No earlier capture (a first run): nothing to keep.
  }
  const key = (c: CapturedSite) => `${c.venue}|${c.url}`;
  const unsettled = (c: CapturedSite) => c.status.startsWith("later") || c.status.startsWith("error");
  const before = new Map(earlier.map((c) => [key(c), c]));
  // A read whose hours page could not be read keeps the hours an earlier read had.
  const withHours = (c: CapturedSite): CapturedSite => {
    const was = c.hoursUnread && c.read ? before.get(key(c))?.read?.facts.filter((f) => f.attribute === "opening_hours") : undefined;
    return was?.length && c.read ? { ...c, read: { ...c.read, facts: [...c.read.facts.filter((f) => f.attribute !== "opening_hours"), ...was] } } : c;
  };
  const settled = new Map(captured.filter((c) => !unsettled(c)).map((c) => [key(c), withHours(c)]));
  const out = [...settled.values()];
  for (const c of earlier) if (!settled.has(key(c))) out.push(c);
  const kept = new Set(out.map(key));
  for (const c of captured) if (!kept.has(key(c))) out.push(c);
  return out;
}

/** Replay a saved run: register each site for its venue (found by source record) and write what it stated. */
async function replayFirstParty(db: Db, path: string, log: (l: string) => void, now: Date): Promise<FirstPartyRunSummary> {
  const raw = JSON.parse(await readFile(path, "utf8")) as Partial<FirstPartyCapture>;
  if (raw.outrn_capture !== "firstparty-sites" || !Array.isArray(raw.sites)) throw new Error(`${path} is not a first-party sites capture (outrn firstparty run --save)`);
  const runId = await startRun(db, { sourceId: "firstparty", kind: "replay", params: { from_file: path, area: raw.area ?? null } });
  const s: FirstPartyRunSummary = { runId, sites: raw.sites.length, ok: 0, noJsonLd: 0, blocked: 0, failed: 0, facts: 0, occurrences: 0, hours: 0, robots: 0, deferred: 0, outcome: "succeeded" };
  let unmatched = 0;
  for (const site of raw.sites) {
    const venueId = typeof site.venue === "string" ? await venueByKey(db, site.venue) : null;
    const url = ownSiteUrl(site.url);
    if (!venueId || !url) {
      unmatched++;
      continue;
    }
    await registerSite(db, venueId, url, "auto: its own website; no source publishes its hours", true);
    await db.query(`update firstparty_sites set last_fetched_at = $3, last_status = $4 where venue_id = $1 and url = $2`, [venueId, url, raw.fetchedAt ?? new Date().toISOString(), `replay: ${site.status}`]);
    if (site.status === "robots") s.robots++;
    if (!site.read || typeof site.read.url !== "string" || !/^https?:\/\//.test(site.read.url)) continue;
    const x = revive(site.read);
    s.ok++;
    if (x.facts.some((f) => f.attribute === "opening_hours")) s.hours++;
    const events = reviveCalendarEvents(site.events) ?? calendarEventsOf(x.events);
    // Never withdraws: a capture is a read from its day, and an older one must not take a newer
    // read's events away.
    await writeExtraction(db, runId, venueId, x, s, true, events, now, site.hoursUnread === true);
  }
  if (unmatched) log(`  ${unmatched} captured sites name venues not in this database (another area's, or gone)`);
  await finishRun(db, runId, { status: "succeeded", counts: { ...s } as unknown as Record<string, number> });
  return s;
}
