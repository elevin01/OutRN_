import { readFile, writeFile } from "node:fs/promises";
import { type Interest, type LatLon } from "@outrn/core";
import { assertSourceAllowed, getArea, loadParkingRule, type Db, type Queryable } from "@outrn/db";
import { matchKey } from "@outrn/identity";
import { fetchTicketedEvents, parseTicketingCapture, type TicketedEvent, type TicketingCapture, type TicketingSource } from "@outrn/sources";
import { placeOf } from "./calendars.js";
import { ingestEvents, type EventInput, type EventsSummary } from "./events.js";
import { ingestExtentFor } from "./pipeline.js";

/**
 * Ticketed events (Ticketmaster, SeatGeek) as events of an area: the ones within its reach for the
 * next TICKETING_DAYS, in the events file's shape, written by ingestEvents like any other source's.
 * An event is held at the venue we know by its name or address near where the API puts it, or at a
 * place of its own (an event site) when we know none there. A read of every page is the area's whole
 * listing, so an event the API no longer lists (taken down, moved) is withdrawn.
 */

export const TICKETING_DAYS = 14;
/** How far from the API's point a venue we know may stand and still be the event's venue. */
const VENUE_MATCH_M = 200;
/** The same event from the other API: at the same venue, starting within this many minutes. */
const SAME_EVENT_MINUTES = 30;

/** The environment variable each API's key is read from. */
export const TICKETING_KEYS: Readonly<Record<TicketingSource, string>> = { ticketmaster: "TICKETMASTER_API_KEY", seatgeek: "SEATGEEK_CLIENT_ID" };

/** What the APIs file events under, as interests: the first that fits each word, most specific first. */
const KIND_INTERESTS: readonly [RegExp, Interest][] = [
  [/\b(comedy|stand-?up|improv)\b/, "comedy"],
  [/\b(film|movies?|cinema|screenings?)\b/, "film"],
  [/\b(theat(?:re|er)|broadway|musicals?|opera|dance|ballet|cabaret|magic|circus|performance art)\b/, "theatre"],
  [/\b(fine art|multimedia|exhibits?|exhibitions?)\b/, "art"],
  [/\b(literary|lectures?|spoken word|talks?)\b/, "books"],
  [/\b(festivals?|fairs?)\b/, "festivals"],
  [/\b(sports?|basketball|baseball|football|hockey|soccer|tennis|boxing|wrestling|mma|nba|mlb|nfl|nhl|mls|wnba|ncaa\w*|wwe|ufc|racing)\b/, "sports"],
  [/\b(music|concerts?|classical|rock|pop|jazz|hip-hop|rap|r&b|country|electronic|folk|blues|latin|metal|alternative|indie|band|dj)\b/, "live_music"],
];
/** A segment that says only "a show": a comedy night is filed under Arts & Theatre too. */
const BROAD = new Set(["arts & theatre", "miscellaneous", "undefined", "other"]);
const FOR_KIDS = /\b(family|children'?s|kids)\b/;

export function ticketedKinds(kinds: readonly string[]): { kinds: Interest[]; forKids: boolean } {
  const specific = kinds.filter((k) => !BROAD.has(k));
  const words = specific.length ? specific : kinds;
  const out: Interest[] = [];
  for (const w of words) {
    const hit = KIND_INTERESTS.find(([re]) => re.test(w));
    if (hit && !out.includes(hit[1])) out.push(hit[1]);
  }
  // A comedy show is not also theatre because it is filed under Arts & Theatre's "Theatre" genre.
  const kept = out.includes("comedy") ? out.filter((k) => k !== "theatre") : out;
  return { kinds: kept.slice(0, 4), forKids: kinds.some((k) => FOR_KIDS.test(k)) };
}

/** At most `max` characters, cut at a word. */
function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), max / 2)).trimEnd()}…`;
}

/** The event in the events file's shape, its place still to be found. */
export function ticketedEventInput(e: TicketedEvent): Omit<EventInput, "place"> {
  const { kinds, forKids } = ticketedKinds(e.kinds);
  return {
    id: e.id,
    title: clip(e.title, 200),
    start: e.start,
    end: null,
    ...(e.status === "cancelled" ? { status: "cancelled" as const } : {}),
    ...(e.url?.startsWith("https://") ? { url: e.url } : {}),
    ...(kinds.length ? { kinds } : {}),
    ...(forKids ? { forKids: true as const } : {}),
    ...(e.adultsOnly ? { minAge: 21 } : {}),
    admission: "ticket",
    ...(e.price ? { price: { min: e.price.min, max: Math.max(e.price.min, e.price.max), currency: "USD" as const } } : {}),
    ...(e.popularity !== null ? { popularity: e.popularity } : {}),
  };
}

const distinctiveWords = (title: string) => new Set(matchKey(title).split(" ").filter((w) => w.length >= 4));

/** Whether the other API already lists this event at this venue: starting within SAME_EVENT_MINUTES, a word of its title in common. */
async function listedByAnother(q: Queryable, source: TicketingSource, venueId: string, e: TicketedEvent): Promise<boolean> {
  const other = source === "ticketmaster" ? "seatgeek" : "ticketmaster";
  const r = await q.query<{ title: string }>(
    `select title from occurrences where venue_id = $1 and recurrence_key like $2 and status not in ('withdrawn', 'ended')
        and start_at between $3::timestamptz - make_interval(mins => $4) and $3::timestamptz + make_interval(mins => $4)`,
    [venueId, `${other}:%`, e.start, SAME_EVENT_MINUTES],
  );
  const mine = distinctiveWords(e.title);
  return r.rows.some((x) => [...distinctiveWords(x.title)].some((w) => mine.has(w)));
}

export type TicketingSkip = "far" | "another_area" | "listed_by_other";

export interface TicketingIngestOptions {
  source: TicketingSource;
  areaSlug: string;
  /** Replay a saved read (`--save`) instead of asking the API. */
  fromFile?: string;
  saveTo?: string;
  /** Where the key is read from (default: process.env). */
  env?: Readonly<Record<string, string | undefined>>;
  now?: Date;
  log?: (line: string) => void;
}

export interface TicketingIngestSummary extends EventsSummary {
  read: number;
  skipped: Record<string, number>;
}

export async function ingestTicketedEvents(db: Db, opts: TicketingIngestOptions): Promise<TicketingIngestSummary> {
  const log = opts.log ?? (() => undefined);
  const { source } = opts;
  await assertSourceAllowed(db, source, "derive");
  if (!opts.fromFile) await assertSourceAllowed(db, source, "fetch");
  const area = await getArea(db, opts.areaSlug);
  const { radiusM } = ingestExtentFor(area, await loadParkingRule(db, area.slug));
  const center: LatLon = { lat: Number(area.lat), lon: Number(area.lon) };
  const now = opts.now ?? new Date();

  let capture: TicketingCapture;
  if (opts.fromFile) {
    capture = parseTicketingCapture(JSON.parse(await readFile(opts.fromFile, "utf8")), opts.fromFile);
    if (capture.source !== source) throw new Error(`${opts.fromFile} is a ${capture.source} capture, not ${source}`);
  } else {
    const keyName = TICKETING_KEYS[source];
    const key = (opts.env ?? process.env)[keyName]?.trim();
    if (!key) throw new Error(`${source}: set ${keyName} in the environment (a free key from the API's developer site)`);
    const read = await fetchTicketedEvents(source, { center, radiusM, from: now, until: new Date(now.getTime() + TICKETING_DAYS * 86_400_000), key });
    log(`read ${read.events.length} ${source} events within ${(radiusM / 1000).toFixed(1)} km${Object.keys(read.skipped).length ? ` (skipped: ${Object.entries(read.skipped).map(([k, n]) => `${k} ${n}`).join(", ")})` : ""}${read.complete ? "" : " (not every page: nothing withdrawn)"}`);
    capture = { outrn_capture: "ticketed-events", source, fetchedAt: read.fetchedAt.toISOString(), area: area.slug, complete: read.complete, events: read.events };
    if (opts.saveTo) await writeFile(opts.saveTo, JSON.stringify(capture), "utf8");
  }

  const skipped: Record<string, number> = {};
  const skip = (k: TicketingSkip) => (skipped[k] = (skipped[k] ?? 0) + 1);
  const memo = new Map<string, Awaited<ReturnType<typeof placeOf>>>();
  const events: EventInput[] = [];
  for (const e of capture.events) {
    const at = { lat: e.venue.lat, lon: e.venue.lon };
    const placed = await placeOf(db, [e.venue.name, ...(e.venue.address ? [e.venue.address] : [])], at, VENUE_MATCH_M, memo);
    if (placed && placed.area !== area.slug) {
      // That area's own read places it.
      skip("another_area");
      continue;
    }
    if (placed && (await listedByAnother(db, source, placed.venueId, e))) {
      skip("listed_by_other");
      continue;
    }
    events.push({ ...ticketedEventInput(e), place: placed ? { venue: placed.venueId } : { name: clip(e.venue.name, 120), lat: e.venue.lat, lon: e.venue.lon } });
  }
  if (Object.keys(skipped).length) log(`left out: ${Object.entries(skipped).map(([k, n]) => `${k} ${n}`).join(", ")}`);
  // A replay saved for another area holds that area's events only: it withdraws nothing here.
  const complete = capture.complete && capture.area === area.slug && capture.events.length > 0;
  const s = await ingestEvents(db, { source, events }, { areaSlug: area.slug, now, actor: source, complete });
  return { ...s, read: capture.events.length, skipped };
}
