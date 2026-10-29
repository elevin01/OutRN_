import { z } from "zod";
import { withKey } from "./api-errors.js";
import { guardedFetch, type GuardedFetchOptions } from "./fetch.js";

/**
 * Ticketed events near a point from two ticketing APIs, read into one shape: Ticketmaster's Discovery
 * API (concerts, comedy, theatre and sports, at the venues that sell through it) and SeatGeek's
 * (the same kinds, with a popularity score). Each needs its own free key from the environment
 * (TICKETMASTER_API_KEY, SEATGEEK_CLIENT_ID), which is sent only to its own API and never saved,
 * logged or put in an error: a failure comes out as its status alone (withKey), never the answer's body. What a reply says is kept as it says it; nothing is guessed: an event
 * with no time yet ("TBA") is left out, a price is the range the API gives, an age limit only when
 * the API says the event is for adults.
 */

export type TicketingSource = "ticketmaster" | "seatgeek";

/** One event as either API gives it, in the words the conversion reads. */
export interface TicketedEvent {
  /** The API's own id for it: the same id is the same event on the next read. */
  id: string;
  title: string;
  url: string | null;
  /** UTC instant it starts. */
  start: string;
  status: "scheduled" | "cancelled";
  venue: { name: string; address: string | null; lat: number; lon: number };
  /** What the API files it under, lower case: Ticketmaster's segment, genre and sub-genre; SeatGeek's type and taxonomies. */
  kinds: string[];
  price: { min: number; max: number } | null;
  /** The API says the event is for adults only (Ticketmaster's legalAgeEnforced). */
  adultsOnly: boolean;
  /** SeatGeek's score for how much demand there is, 0 to 1. */
  popularity: number | null;
}

/** What `ingest ticketmaster|seatgeek --save` writes, and a replay reads: the events as read, never a key. */
export interface TicketingCapture {
  outrn_capture: "ticketed-events";
  source: TicketingSource;
  fetchedAt: string;
  area: string;
  /** Every page of the reply was read: the capture is the area's whole listing for its days. */
  complete: boolean;
  events: TicketedEvent[];
}

const MAX_EVENTS = 2000;
const num = z.union([z.number(), z.string().regex(/^-?\d+(\.\d+)?$/).transform(Number)]);
const point = (lat: number, lon: number) => Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0);

/**
 * Not an event to go to: a parking pass, a suite or VIP package, an add-on sold as an event. Ticketmaster
 * lists these beside the game or show they go with.
 */
const NOT_AN_EVENT = /\b(parking|vip (?:package|experience|upgrade)|suite|premium seating|hospitality package|gift cards?|add-?on|upsell|souvenir|merch(?:andise)? bundle|pre-?show party pass)\b/i;

// ── Ticketmaster ──────────────────────────────────────────────────────────────────────────────────

export const TICKETMASTER_EVENTS_URL = "https://app.ticketmaster.com/discovery/v2/events.json";
/** Discovery returns at most 1,000 results for a search (size × page). */
const TM_PAGE_SIZE = 200;
const TM_MAX_PAGES = 5;

const TmName = z.object({ name: z.string().max(200).optional() }).passthrough();
const TmEvent = z
  .object({
    id: z.string().min(1).max(100),
    name: z.string().min(1).max(500),
    url: z.string().max(2000).optional(),
    test: z.boolean().optional(),
    dates: z
      .object({
        start: z.object({ dateTime: z.string().max(40).optional(), dateTBD: z.boolean().optional(), dateTBA: z.boolean().optional(), timeTBA: z.boolean().optional(), noSpecificTime: z.boolean().optional() }).passthrough(),
        status: z.object({ code: z.string().max(40).optional() }).passthrough().optional(),
      })
      .passthrough(),
    classifications: z.array(z.object({ segment: TmName.optional(), genre: TmName.optional(), subGenre: TmName.optional() }).passthrough()).max(20).optional(),
    priceRanges: z.array(z.object({ currency: z.string().max(10).optional(), min: num.optional(), max: num.optional() }).passthrough()).max(20).optional(),
    ageRestrictions: z.object({ legalAgeEnforced: z.boolean().optional() }).passthrough().optional(),
    _embedded: z
      .object({
        venues: z
          .array(
            z
              .object({
                name: z.string().min(1).max(300),
                address: z.object({ line1: z.string().max(300).optional() }).passthrough().optional(),
                location: z.object({ latitude: num, longitude: num }).passthrough().optional(),
              })
              .passthrough(),
          )
          .max(10),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const TmPage = z
  .object({
    _embedded: z.object({ events: z.array(z.unknown()).max(TM_PAGE_SIZE) }).passthrough().optional(),
    page: z.object({ totalPages: z.number().int().min(0), number: z.number().int().min(0) }).passthrough(),
  })
  .passthrough();

const lower = (xs: (string | undefined)[]) => [...new Set(xs.filter((x): x is string => !!x && x.toLowerCase() !== "undefined").map((x) => x.trim().toLowerCase()))];

/** One Discovery event, or why it can't be one (no time yet, no place, a parking pass). */
export function ticketmasterEvent(raw: unknown): TicketedEvent | { skip: "unreadable" | "no_time" | "no_place" | "not_an_event" } {
  const p = TmEvent.safeParse(raw);
  if (!p.success) return { skip: "unreadable" };
  const e = p.data;
  if (e.test || NOT_AN_EVENT.test(e.name)) return { skip: "not_an_event" };
  const s = e.dates.start;
  const start = s.dateTime && !s.dateTBD && !s.dateTBA && !s.timeTBA && !s.noSpecificTime ? new Date(s.dateTime) : null;
  if (!start || Number.isNaN(start.getTime())) return { skip: "no_time" };
  const v = e._embedded?.venues?.[0];
  if (!v?.location || !point(v.location.latitude, v.location.longitude)) return { skip: "no_place" };
  const c = e.classifications ?? [];
  const usd = (e.priceRanges ?? []).filter((r) => (r.currency ?? "USD").toUpperCase() === "USD" && (r.min !== undefined || r.max !== undefined));
  const mins = usd.map((r) => r.min ?? r.max!).filter((n) => n >= 0);
  const maxs = usd.map((r) => r.max ?? r.min!).filter((n) => n >= 0);
  const code = (e.dates.status?.code ?? "").toLowerCase();
  return {
    id: e.id,
    title: e.name.trim(),
    url: e.url ?? null,
    start: start.toISOString(),
    status: code === "cancelled" || code === "canceled" || code === "postponed" ? "cancelled" : "scheduled",
    venue: { name: v.name.trim(), address: v.address?.line1?.trim() || null, lat: v.location.latitude, lon: v.location.longitude },
    kinds: lower(c.flatMap((x) => [x.segment?.name, x.genre?.name, x.subGenre?.name])),
    price: mins.length && maxs.length ? { min: Math.min(...mins), max: Math.max(...maxs) } : null,
    adultsOnly: e.ageRestrictions?.legalAgeEnforced === true,
    popularity: null,
  };
}

export function parseTicketmasterPage(json: unknown): { events: TicketedEvent[]; skipped: Record<string, number>; totalPages: number } {
  const page = TmPage.parse(json);
  const events: TicketedEvent[] = [];
  const skipped: Record<string, number> = {};
  for (const raw of page._embedded?.events ?? []) {
    const e = ticketmasterEvent(raw);
    if ("skip" in e) skipped[e.skip] = (skipped[e.skip] ?? 0) + 1;
    else events.push(e);
  }
  return { events, skipped, totalPages: page.page.totalPages };
}

// ── SeatGeek ──────────────────────────────────────────────────────────────────────────────────────

export const SEATGEEK_EVENTS_URL = "https://api.seatgeek.com/2/events";
const SG_PAGE_SIZE = 100;
const SG_MAX_PAGES = 10;

const SgEvent = z
  .object({
    id: num,
    title: z.string().min(1).max(500),
    url: z.string().max(2000).optional(),
    datetime_utc: z.string().max(40).optional(),
    datetime_tbd: z.boolean().optional(),
    time_tbd: z.boolean().optional(),
    date_tbd: z.boolean().optional(),
    status: z.string().max(40).optional(),
    type: z.string().max(100).optional(),
    taxonomies: z.array(z.object({ name: z.string().max(100).optional() }).passthrough()).max(20).optional(),
    score: num.nullable().optional(),
    stats: z.object({ lowest_price: num.nullable().optional(), highest_price: num.nullable().optional() }).passthrough().optional(),
    venue: z
      .object({
        name: z.string().min(1).max(300),
        address: z.string().max(300).nullable().optional(),
        location: z.object({ lat: num, lon: num }).passthrough().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const SgPage = z.object({ events: z.array(z.unknown()).max(SG_PAGE_SIZE), meta: z.object({ total: z.number().int().min(0) }).passthrough() }).passthrough();

/** One SeatGeek event, or why it can't be one. */
export function seatGeekEvent(raw: unknown): TicketedEvent | { skip: "unreadable" | "no_time" | "no_place" | "not_an_event" } {
  const p = SgEvent.safeParse(raw);
  if (!p.success) return { skip: "unreadable" };
  const e = p.data;
  if (NOT_AN_EVENT.test(e.title)) return { skip: "not_an_event" };
  // datetime_utc is UTC without its "Z".
  const start = e.datetime_utc && !e.datetime_tbd && !e.time_tbd && !e.date_tbd ? new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(e.datetime_utc) ? e.datetime_utc : `${e.datetime_utc}Z`) : null;
  if (!start || Number.isNaN(start.getTime())) return { skip: "no_time" };
  const v = e.venue;
  if (!v?.location || !point(v.location.lat, v.location.lon)) return { skip: "no_place" };
  const lo = e.stats?.lowest_price ?? null;
  const hi = e.stats?.highest_price ?? lo;
  const score = e.score ?? null;
  return {
    id: String(e.id),
    title: e.title.trim(),
    url: e.url ?? null,
    start: start.toISOString(),
    status: /cancel|postpone/i.test(e.status ?? "") ? "cancelled" : "scheduled",
    venue: { name: v.name.trim(), address: v.address?.trim() || null, lat: v.location.lat, lon: v.location.lon },
    kinds: lower([e.type?.replace(/_/g, " "), ...(e.taxonomies ?? []).map((t) => t.name?.replace(/_/g, " "))]),
    price: lo !== null && lo >= 0 ? { min: lo, max: Math.max(lo, hi ?? lo) } : null,
    adultsOnly: false,
    popularity: score !== null && score >= 0 && score <= 1 ? score : null,
  };
}

export function parseSeatGeekPage(json: unknown): { events: TicketedEvent[]; skipped: Record<string, number>; total: number } {
  const page = SgPage.parse(json);
  const events: TicketedEvent[] = [];
  const skipped: Record<string, number> = {};
  for (const raw of page.events) {
    const e = seatGeekEvent(raw);
    if ("skip" in e) skipped[e.skip] = (skipped[e.skip] ?? 0) + 1;
    else events.push(e);
  }
  return { events, skipped, total: page.meta.total };
}

// ── Reading ───────────────────────────────────────────────────────────────────────────────────────

export interface TicketingQuery {
  center: { lat: number; lon: number };
  radiusM: number;
  from: Date;
  until: Date;
  /** The API's key (TICKETMASTER_API_KEY or SEATGEEK_CLIENT_ID). */
  key: string;
}

/** Second precision, as both APIs want it ("2026-10-29T16:00:00Z"). */
const isoSeconds = (d: Date) => `${d.toISOString().slice(0, 19)}Z`;
const miles = (m: number) => Math.max(1, Math.ceil(m / 1609.344));

/** Reads every page (up to each API's cap); `complete` when the reply's last page was read. */
export async function fetchTicketedEvents(source: TicketingSource, q: TicketingQuery): Promise<{ events: TicketedEvent[]; skipped: Record<string, number>; complete: boolean; fetchedAt: Date }> {
  if (!q.key.trim()) throw new Error(`${source}: no key`);
  const events: TicketedEvent[] = [];
  const skipped: Record<string, number> = {};
  const add = (r: { events: TicketedEvent[]; skipped: Record<string, number> }) => {
    events.push(...r.events);
    for (const [k, n] of Object.entries(r.skipped)) skipped[k] = (skipped[k] ?? 0) + n;
  };
  const opts: GuardedFetchOptions = { sourceId: source, accept: "application/json", allowedContentTypes: ["application/json"], timeoutMs: 30_000, maxBytes: 10 * 1024 * 1024 };
  let complete = false;
  const fetchedAt = new Date();
  if (source === "ticketmaster") {
    for (let page = 0; page < TM_MAX_PAGES; page++) {
      const u = new URL(TICKETMASTER_EVENTS_URL);
      u.search = new URLSearchParams({ apikey: q.key, latlong: `${q.center.lat.toFixed(4)},${q.center.lon.toFixed(4)}`, radius: String(miles(q.radiusM)), unit: "miles", startDateTime: isoSeconds(q.from), endDateTime: isoSeconds(q.until), size: String(TM_PAGE_SIZE), page: String(page), sort: "date,asc" }).toString();
      // Five requests a second at most. Its failures carry no key (see withKey).
      const r = await withKey(source, async () => parseTicketmasterPage(JSON.parse((await guardedFetch(u.toString(), { ...opts, minIntervalMs: 250 })).text)));
      add(r);
      if (page + 1 >= r.totalPages) {
        complete = true;
        break;
      }
    }
  } else {
    for (let page = 1; page <= SG_MAX_PAGES; page++) {
      const u = new URL(SEATGEEK_EVENTS_URL);
      u.search = new URLSearchParams({ client_id: q.key, lat: q.center.lat.toFixed(4), lon: q.center.lon.toFixed(4), range: `${miles(q.radiusM)}mi`, "datetime_utc.gte": isoSeconds(q.from).slice(0, 19), "datetime_utc.lte": isoSeconds(q.until).slice(0, 19), per_page: String(SG_PAGE_SIZE), page: String(page), sort: "datetime_utc.asc" }).toString();
      const r = await withKey(source, async () => parseSeatGeekPage(JSON.parse((await guardedFetch(u.toString(), { ...opts, minIntervalMs: 500 })).text)));
      add(r);
      if (page * SG_PAGE_SIZE >= r.total) {
        complete = true;
        break;
      }
    }
  }
  // A record we could not read may be one listed before: without it the read is not the area's whole
  // listing, so nothing is withdrawn for missing from it (an empty read is whole only when it is empty).
  return { events: events.slice(0, MAX_EVENTS), skipped, complete: complete && events.length <= MAX_EVENTS && !skipped["unreadable"], fetchedAt };
}

const CaptureEvent = z.object({
  id: z.string().min(1).max(100),
  title: z.string().min(1).max(500),
  url: z.string().max(2000).nullable(),
  start: z.string().datetime(),
  status: z.enum(["scheduled", "cancelled"]),
  venue: z.object({ name: z.string().min(1).max(300), address: z.string().max(300).nullable(), lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) }),
  kinds: z.array(z.string().max(100)).max(20),
  price: z.object({ min: z.number().min(0), max: z.number().min(0) }).nullable(),
  adultsOnly: z.boolean(),
  popularity: z.number().min(0).max(1).nullable(),
});

const Capture = z.object({
  outrn_capture: z.literal("ticketed-events"),
  source: z.enum(["ticketmaster", "seatgeek"]),
  fetchedAt: z.string().datetime(),
  area: z.string().min(1).max(64),
  complete: z.boolean(),
  events: z.array(CaptureEvent).max(MAX_EVENTS),
});

export function parseTicketingCapture(data: unknown, label: string): TicketingCapture {
  const c = Capture.safeParse(data);
  if (!c.success) throw new Error(`${label} is not a ticketed events capture (outrn ingest ticketmaster|seatgeek --save): ${c.error.issues[0]?.message ?? "unreadable"}`);
  return c.data;
}
