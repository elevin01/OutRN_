import { matchKey, ownValue, type LatLon } from "@outrn/core";
import type { Db, Queryable } from "@outrn/db";
import { readCalendar, type CalendarEvent, type CalendarRead, type EventsFeed, type ExtractedEvent, type FirstPartyExtraction } from "@outrn/sources";
import { CALENDAR_DAYS, calendarEventInput, OFF_SITE_M, placeOf, type CalendarFeed, type CalendarSkip, type Placed } from "./calendars.js";
import { ingestEvents, type EventInput, type EventsSummary } from "./events.js";

/**
 * Venues' own event listings: what a theatre's, a music room's or an arts center's own website
 * lists, read with its pages by the firstparty job (through its gate: robots.txt per request, a
 * host's requests paced and capped a day). The home page says where the site lists them (see
 * eventsFeedOf): The Events Calendar's REST API, an iCalendar feed, or a page of its own, read for
 * its JSON-LD. Its own JSON-LD events count too.
 *
 * They are written as calendars' events are (calendarEventInput: what is not an outing is left
 * out, kinds, who it is for, registration, price as stated, no drink event for children), at the
 * venue unless an event names another place we know nearby, as the source "venue_events". A read is
 * never the whole of a venue's events (a page lists some), so nothing is withdrawn for missing from
 * one: an event leaves when it is over, or when the site marks it cancelled.
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
    categories: e.types.map((t) => ownValue(TYPE_WORDS, t)).filter((w): w is string => w !== undefined),
    url: e.url && /^https:\/\//i.test(e.url) ? e.url : null,
    cancelled: e.status === "cancelled",
    recurring: false,
    cost: costOf(e),
    text: "",
  }));
}

/** How a site's feed is read: its text (The Events Calendar's JSON, iCalendar) and its pages, each through the job's gate. */
export interface SiteFeedReader {
  text(url: string, opts: { accept: string; contentTypes: string[] }): Promise<string>;
  page(url: string): Promise<FirstPartyExtraction>;
}

/**
 * Read the feed a site's home page showed. Every request goes through the reader, and so through the
 * job's gate, which checks robots.txt for that very path, paces the host and spends its day's
 * requests: readCalendar's own robots.txt read is not used (an always-yes policy stands in for it).
 */
export async function readSiteFeed(feed: EventsFeed, reader: SiteFeedReader, opts: { now: Date; until: Date; timeZone: string }): Promise<CalendarRead> {
  if (feed.format === "page") {
    try {
      const x = await reader.page(feed.url);
      return { feed: feed.url, url: feed.url, status: "ok", pages: 1, events: calendarEventsOf(x.events), complete: false, incomplete: "a page lists some of a venue's events" };
    } catch (e) {
      return { feed: feed.url, url: feed.url, status: "failed", error: (e as Error).message, pages: 0, events: [], complete: false };
    }
  }
  return readCalendar(
    { id: feed.url, url: feed.url, format: feed.format },
    {
      timeZone: opts.timeZone,
      from: opts.now,
      until: opts.until,
      robots: new Map(),
      robotsFor: async () => ({ status: "none", rules: [], crawlDelayS: null }),
      get: (url, o) => reader.text(url, { accept: o.accept, contentTypes: o.contentTypes }),
    },
  );
}

export interface SiteEventsSummary {
  written: number;
  skipped: Partial<Record<CalendarSkip, number>>;
  areas: EventsSummary[];
}

/**
 * Write a venue's events from its own site, at the venue unless one names another place we know
 * within 3 km. The same event twice (on its page and in its feed) is one. Nothing is withdrawn for
 * missing; the events this site's pages once wrote straight into occurrences (keyed by host) give way
 * to these.
 */
export async function writeSiteEvents(db: Db, site: { venueId: string; host: string }, events: readonly CalendarEvent[], now: Date): Promise<SiteEventsSummary> {
  const summary: SiteEventsSummary = { written: 0, skipped: {}, areas: [] };
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
    const place = (await placeOf(db, e.location, venue.point, OFF_SITE_M, memo)) ?? own;
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
  // The old way this job wrote a site's JSON-LD events, straight into occurrences keyed by its host:
  // those yet to happen give way to this listing.
  await db.query(
    `update occurrences set status = 'withdrawn', updated_at = now()
      where venue_id = $1 and recurrence_key like $2 escape '\\' and status in ('scheduled', 'sold_out') and start_at > $3`,
    [site.venueId, oldKeys, now],
  );
  for (const [area, list] of byArea) {
    const s = await ingestEvents(db, { source: VENUE_EVENTS_SOURCE, events: list }, { areaSlug: area, now, actor: "firstparty", complete: false });
    summary.written += s.written;
    summary.areas.push(s);
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
