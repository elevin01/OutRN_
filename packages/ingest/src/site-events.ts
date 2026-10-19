import { isInterest, matchKey, ownValue, type Interest, type LatLon } from "@outrn/core";
import { assertSourceAllowed, type Db, type Queryable } from "@outrn/db";
import { FetchFailed, readCalendar, type CalendarEvent, type CalendarRead, type EventsFeed, type ExtractedEvent, type FirstPartyExtraction } from "@outrn/sources";
import { CALENDAR_DAYS, calendarEventInput, namesAnotherPlace, OFF_SITE_M, placeOf, type CalendarFeed, type CalendarSkip, type Placed } from "./calendars.js";
import { ingestEvents, type EventInput, type EventsSummary, type WrittenEvent } from "./events.js";

/**
 * Venues' own event listings: what a theatre's, a music room's or an arts center's own website
 * lists, read with its pages by the firstparty job (through its gate: robots.txt per request, a
 * host's requests paced and capped a day). The home page says where the site lists them (see
 * eventsFeedOf): The Events Calendar's REST API, an iCalendar feed, or a page of its own, read for
 * its JSON-LD. Its own JSON-LD events count too.
 *
 * They are written as calendars' events are (calendarEventInput: what is not an outing is left
 * out, kinds, who it is for, registration, price as stated, no drink event for children), at the
 * venue unless an event names another place we know nearby, as the source "venue_events". A page is
 * never the whole of a venue's events (it lists some), so nothing is withdrawn for missing from one.
 * A feed read whole (The Events Calendar's API, an iCalendar feed, every page of it) is: what this
 * site listed before and its feed no longer lists by then (a show taken down, or moved to another
 * time) is withdrawn.
 */

export const VENUE_EVENTS_SOURCE = "venue_events";
/** The most events one site writes in a run, the soonest. */
export const SITE_EVENTS_MAX = 200;

/** schema.org types as the words a calendar files events under: calendarEventInput reads kinds and "for children" from them. */
const TYPE_WORDS: Readonly<Record<string, string>> = {
  MusicEvent: "Concerts",
  TheaterEvent: "Theater",
  DanceEvent: "Dance",
  ComedyEvent: "Comedy",
  ScreeningEvent: "Film",
  VisualArtsEvent: "Art",
  ExhibitionEvent: "Exhibits",
  LiteraryEvent: "Books",
  ChildrensEvent: "Kids",
  Festival: "Festivals",
  FoodEvent: "Tastings",
  SportsEvent: "Sports",
};

/** What a page said an event is, as the words calendarEventInput reads kinds from (a capture from before types were kept has only these). */
const INTEREST_WORDS: Readonly<Partial<Record<Interest, string>>> = {
  live_music: "Concerts",
  theatre: "Theater",
  comedy: "Comedy",
  film: "Film",
  art: "Art",
  books: "Books",
  festivals: "Festivals",
  food: "Tastings",
  sports: "Sports",
  markets: "Markets",
};

/** A price as a calendar writes it: free only when the page says so, not for a price of 0 (often a placeholder). */
function costOf(e: ExtractedEvent): string | null {
  if (e.free) return "Free";
  const p = e.price;
  if (!p || p.free || p.currency !== "USD" || p.min === undefined || p.min <= 0) return null;
  return p.max !== undefined && p.max > p.min ? `$${p.min} - $${p.max}` : `$${p.min}`;
}

/** A page's JSON-LD events as calendar events. */
export function calendarEventsOf(events: readonly ExtractedEvent[]): CalendarEvent[] {
  return events.map((e) => ({
    uid: (e.url ?? `${e.title}@${e.start.toISOString()}`).slice(0, 500),
    title: e.title,
    start: e.start.toISOString(),
    end: e.end && e.end > e.start ? e.end.toISOString() : null,
    allDay: e.allDay,
    location: e.location,
    categories: [...new Set([...e.types.map((t) => ownValue(TYPE_WORDS, t)), ...e.kinds.map((k) => ownValue(INTEREST_WORDS, k))].filter((w): w is string => w !== undefined))],
    url: e.url && /^https:\/\//i.test(e.url) ? e.url : null,
    cancelled: e.status === "cancelled",
    recurring: false,
    cost: costOf(e),
    text: "",
    ...(e.minAge !== null ? { minAge: e.minAge } : {}),
  }));
}

/** How a site's feed is read: its text (The Events Calendar's JSON, iCalendar) and its pages, each through the job's gate. */
export interface SiteFeedReader {
  text(url: string, opts: { accept: string; contentTypes: string[] }): Promise<string>;
  page(url: string): Promise<FirstPartyExtraction>;
}

/** A feed read, and the answer that asked us to slow down (429, 503), when one did: its host is to be left alone. */
export interface SiteFeedRead {
  read: CalendarRead;
  slowDown?: FetchFailed;
}

/**
 * Read the feed a site's home page showed. Every request goes through the reader, and so through the
 * job's gate, which checks robots.txt for that very path, paces the host and spends its day's
 * requests: readCalendar's own robots.txt read is not used (an always-yes policy stands in for it).
 * A refusal or failure is a read that is not ok (never an empty feed), and a 429 or 503 is handed
 * back as it came, for the job to back the host off.
 */
export async function readSiteFeed(feed: EventsFeed, reader: SiteFeedReader, opts: { now: Date; until: Date; timeZone: string }): Promise<SiteFeedRead> {
  let slowDown: FetchFailed | undefined;
  const noting = async <T>(f: () => Promise<T>): Promise<T> => {
    try {
      return await f();
    } catch (e) {
      if (e instanceof FetchFailed && (e.status === 429 || e.status === 503)) slowDown ??= e;
      throw e;
    }
  };
  if (feed.format === "page") {
    try {
      const x = await noting(() => reader.page(feed.url));
      return { read: { feed: feed.url, url: feed.url, status: "ok", pages: 1, events: calendarEventsOf(x.events), complete: false, incomplete: "a page lists some of a venue's events" } };
    } catch (e) {
      return { read: { feed: feed.url, url: feed.url, status: "failed", error: (e as Error).message, pages: 0, events: [], complete: false }, ...(slowDown ? { slowDown } : {}) };
    }
  }
  const read = await readCalendar(
    { id: feed.url, url: feed.url, format: feed.format },
    {
      timeZone: opts.timeZone,
      from: opts.now,
      until: opts.until,
      robots: new Map(),
      robotsFor: async () => ({ status: "none", rules: [], crawlDelayS: null }),
      get: (url, o) => noting(() => reader.text(url, { accept: o.accept, contentTypes: o.contentTypes })),
    },
  );
  return { read, ...(slowDown ? { slowDown } : {}) };
}

export interface SiteEventsSummary {
  written: number;
  /** This site's events its feed, read whole, no longer lists. */
  withdrawn: number;
  skipped: Partial<Record<CalendarSkip, number>>;
  areas: EventsSummary[];
}

/**
 * Write a venue's events from its own site, at the venue unless one names another place we know
 * within 3 km (a site found for the venue, `auto`, keeps them all at it). The same event twice (on
 * its page and in its feed) is one. Only when `complete` (its feed read whole) is what this site
 * listed before and no longer lists, up to the last day read, withdrawn; the events this site's pages
 * once wrote straight into occurrences (keyed by host) give way to these.
 */
export async function writeSiteEvents(db: Db, site: { venueId: string; host: string; auto?: boolean }, events: readonly CalendarEvent[], now: Date, opts: { complete?: boolean } = {}): Promise<SiteEventsSummary> {
  const summary: SiteEventsSummary = { written: 0, withdrawn: 0, skipped: {}, areas: [] };
  // Before anything is written or withdrawn: a feed read whole that lists nothing reaches no
  // ingestEvents call (which checks it too), and must not withdraw for a source that is switched off.
  await assertSourceAllowed(db, VENUE_EVENTS_SOURCE, "retain");
  const venue = await venueOf(db, site.venueId);
  if (!venue) return summary;
  const feed: Pick<CalendarFeed, "id" | "venue"> = { id: `site-${site.host}`.slice(0, 80), venue: { aliases: [venue.name], at: venue.point } };
  const until = new Date(now.getTime() + CALENDAR_DAYS * 86_400_000);
  const own: Placed = { venueId: site.venueId, area: venue.area };
  const memo = new Map<string, Placed | null>();
  const seen = new Set<string>();
  const byArea = new Map<string, EventInput[]>();
  const skip = (k: CalendarSkip) => (summary.skipped[k] = (summary.skipped[k] ?? 0) + 1);
  // A site's soonest SITE_EVENTS_MAX: a venue has dozens a month, and a page is untrusted input.
  const soonest = [...events].sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0)).slice(0, SITE_EVENTS_MAX);
  for (const e of soonest) {
    const input = calendarEventInput(feed, e, now, until);
    if ("skip" in input) {
      skip(input.skip);
      continue;
    }
    // At the venue, or at another place it names that we know nearby. One it names elsewhere (a
    // touring date, another branch) is left out: a site found for a venue (auto) is nobody's checked
    // word, so it never places an event at another venue either.
    const placed = await placeOf(db, e.location, venue.point, OFF_SITE_M, memo);
    if ((placed && placed.venueId !== site.venueId && site.auto) || (!placed && namesAnotherPlace(e.location, [venue.name]))) {
      skip("elsewhere");
      continue;
    }
    const place = placed ?? own;
    const twin = `${place.venueId}|${matchKey(input.title)}|${input.start}`;
    if (seen.has(twin)) {
      skip("duplicate");
      continue;
    }
    seen.add(twin);
    byArea.set(place.area, [...(byArea.get(place.area) ?? []), { ...input, place: { venue: place.venueId } }]);
  }
  // The way this job once wrote a site's JSON-LD events: straight into occurrences, keyed by its host.
  const oldKeys = `${site.host.replace(/[\\%_]/g, (c) => `\\${c}`)}:%`;
  // What another source already lists (a library's LibCal feed in calendars, a town's) at the same
  // place and start is that event: not written twice.
  const places = [...new Set([...byArea.values()].flat().map((e) => (e.place as { venue: string }).venue))];
  if (places.length) {
    const listed = await db.query<{ venue_id: string; title: string; start_at: Date }>(
      `select o.venue_id, o.title, o.start_at from occurrences o
        where o.venue_id = any($1::uuid[]) and o.start_at between $2 and $3 and o.status in ('scheduled', 'sold_out')
          and (o.recurrence_key is null or (o.recurrence_key not like 'venue_events:%' and o.recurrence_key not like $4 escape '\\'))`,
      [places, now, until, oldKeys],
    );
    const other = new Set(listed.rows.map((r) => `${r.venue_id}|${matchKey(r.title)}|${r.start_at.toISOString().slice(0, 16)}`));
    for (const [area, list] of byArea) {
      const kept = list.filter((e) => !other.has(`${(e.place as { venue: string }).venue}|${matchKey(e.title)}|${e.start.slice(0, 16)}`));
      for (let i = kept.length; i < list.length; i++) skip("duplicate");
      if (kept.length) byArea.set(area, kept);
      else byArea.delete(area);
    }
  }
  for (const [area, list] of byArea) {
    // An event this job once wrote straight into occurrences, keyed by the site's host, gives way to
    // the one written now, in the same transaction; one not written now stays as it was.
    const afterWrite = async (tx: Queryable, written: readonly WrittenEvent[]) => {
      const now_ = new Set(written.map((w) => `${w.venueId}|${matchKey(w.title)}|${w.start.getTime()}`));
      const legacy = await tx.query<{ id: string; venue_id: string; title: string; start_at: Date }>(
        `select id, venue_id, title, start_at from occurrences where venue_id = any($1::uuid[]) and recurrence_key like $2 escape '\\' and status in ('scheduled', 'sold_out')`,
        [[...new Set(written.map((w) => w.venueId))], oldKeys],
      );
      const replaced = legacy.rows.filter((r) => now_.has(`${r.venue_id}|${matchKey(r.title)}|${r.start_at.getTime()}`)).map((r) => r.id);
      if (replaced.length) await tx.query(`update occurrences set status = 'withdrawn', updated_at = now() where id = any($1::uuid[])`, [replaced]);
    };
    const s = await ingestEvents(db, { source: VENUE_EVENTS_SOURCE, events: list }, { areaSlug: area, now, actor: "firstparty", complete: false, afterWrite });
    summary.written += s.written;
    summary.areas.push(s);
  }
  if (opts.complete) {
    // Its feed, read whole, is this site's listing up to the last day read (or, past the most it
    // writes, up to the last of those it wrote): an event it listed before and no longer lists by
    // then is gone, wherever it was placed. One another source lists too gives way to that one.
    const listed = [...byArea.values()].flat().map((e) => `${VENUE_EVENTS_SOURCE}:${e.id}`);
    const through = events.length > SITE_EVENTS_MAX ? new Date(soonest[soonest.length - 1]!.start) : until;
    const gone = await db.query(
      `update occurrences set status = 'withdrawn', updated_at = now()
        where recurrence_key like $1 escape '\\' and not (recurrence_key = any($2::text[]))
          and status in ('scheduled', 'sold_out') and start_at > $3 and start_at < $4`,
      [`${VENUE_EVENTS_SOURCE}:${feed.id.replace(/[\\%_]/g, (c) => `\\${c}`)}/%`, listed, now, through],
    );
    summary.withdrawn = gone.rowCount ?? 0;
  }
  return summary;
}

async function venueOf(q: Queryable, venueId: string): Promise<{ name: string; point: LatLon; area: string } | null> {
  const r = await q.query<{ name: string; lat: number; lon: number; area: string }>(
    `select v.canonical_name as name, ST_Y(v.geom::geometry) as lat, ST_X(v.geom::geometry) as lon, a.slug as area from venues v join service_areas a on a.id = v.area_id where v.id = $1`,
    [venueId],
  );
  const v = r.rows[0];
  return v ? { name: v.name, point: { lat: Number(v.lat), lon: Number(v.lon) }, area: v.area } : null;
}

// ---------------------------------------------------------------------------------------------
// A capture's events, read back: JSON, so checked as such (a capture may be from before a field was kept).

const str = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() ? v.slice(0, max) : null);
const strings = (v: unknown, max: number): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map((x) => x.slice(0, 200)).slice(0, max) : []);
const instant = (v: unknown): Date | null => {
  const d = typeof v === "string" || v instanceof Date ? new Date(v) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
};
const ageOf = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 25 ? v : null);

/** A page's events as a capture holds them: the fields this version reads, with what an older capture lacks left empty. */
export function reviveExtractedEvents(raw: unknown): ExtractedEvent[] {
  if (!Array.isArray(raw)) return [];
  const out: ExtractedEvent[] = [];
  for (const v of raw.slice(0, 200)) {
    if (!v || typeof v !== "object") continue;
    const e = v as Record<string, unknown>;
    const title = str(e["title"], 200);
    const start = instant(e["start"]);
    if (!title || !start) continue;
    const status = e["status"] === "cancelled" || e["status"] === "sold_out" ? e["status"] : "scheduled";
    out.push({
      title,
      kinds: strings(e["kinds"], 4).filter(isInterest),
      start,
      end: instant(e["end"]),
      status,
      price: null,
      url: str(e["url"], 2000),
      evidence: str(e["evidence"], 1000) ?? title,
      types: strings(e["types"], 4),
      allDay: e["allDay"] === true,
      free: e["free"] === true,
      location: strings(e["location"], 3),
      minAge: ageOf(e["minAge"]),
    });
  }
  return out;
}

/** A site's events as a capture holds them (calendar events), or null when it holds none in this shape. */
export function reviveCalendarEvents(raw: unknown): CalendarEvent[] | null {
  if (!Array.isArray(raw)) return null;
  const out: CalendarEvent[] = [];
  for (const v of raw.slice(0, 2000)) {
    if (!v || typeof v !== "object") continue;
    const e = v as Record<string, unknown>;
    const title = str(e["title"], 300);
    const start = instant(e["start"]);
    if (!title || !start) continue;
    out.push({
      uid: str(e["uid"], 500) ?? `${title}@${start.toISOString()}`,
      title,
      start: start.toISOString(),
      end: instant(e["end"])?.toISOString() ?? null,
      allDay: e["allDay"] === true,
      location: strings(e["location"], 6),
      categories: strings(e["categories"], 10),
      url: str(e["url"], 2000),
      cancelled: e["cancelled"] === true,
      recurring: e["recurring"] === true,
      cost: str(e["cost"], 100),
      text: str(e["text"], 1000) ?? "",
      ...(ageOf(e["minAge"]) !== null ? { minAge: ageOf(e["minAge"])! } : {}),
    });
  }
  return out;
}
