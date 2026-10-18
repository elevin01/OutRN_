import { fromLocal, ownValue, type Interest, type WeeklyIntervals } from "@outrn/core";
import { guardedFetch, type RequestGate } from "./fetch.js";
import { hoursFromText, hoursLinks, microdataHours, visibleText } from "./sitehours.js";

/**
 * First-party extraction from a venue's own page. Rung 1: schema.org JSON-LD. Rung 2, for opening
 * hours only: microdata, then hours written out in the page's text, read strictly (see sitehours).
 * No LLM. Every extracted fact carries what it was read from as evidence so a reviewer can check
 * it. Raw HTML is never retained.
 *
 * Rung 3 (LLM over bounded text) would plug into the same ExtractedFact shape; it is not implemented.
 */

export type ExtractionStatus = "stated" | "not_stated" | "ambiguous";

export interface ExtractedFact {
  attribute: "opening_hours" | "price" | "phone" | "name" | "admission" | "business_status";
  value: unknown;
  evidence: string;
  status: ExtractionStatus;
  /** How it was read: structured data the venue published for machines, or its words for people. */
  method?: "jsonld" | "microdata" | "text";
}

/** What schema.org says an event is, as interests: a MusicEvent is live music. Event, SocialEvent and the like say nothing. */
export const EVENT_TYPE_INTERESTS: Readonly<Record<string, Interest>> = {
  MusicEvent: "live_music",
  ComedyEvent: "comedy",
  TheaterEvent: "theatre",
  DanceEvent: "theatre",
  ScreeningEvent: "film",
  VisualArtsEvent: "art",
  ExhibitionEvent: "art",
  LiteraryEvent: "books",
  EducationEvent: "books",
  Festival: "festivals",
  FoodEvent: "food",
  SportsEvent: "sports",
  SaleEvent: "markets",
};

export interface ExtractedEvent {
  title: string;
  /** What it is, from its schema.org types (empty when they say nothing). */
  kinds: Interest[];
  start: Date;
  end: Date | null;
  status: "scheduled" | "cancelled" | "sold_out";
  price: { min?: number; max?: number; currency: string; free?: boolean } | null;
  url: string | null;
  evidence: string;
  /** Its schema.org types ("MusicEvent", "TheaterEvent"), at most four. */
  types: string[];
  /** A date with no time: the whole day. */
  allDay: boolean;
  /** It says it is free to attend (isAccessibleForFree), which a price of 0 does not. */
  free: boolean;
  /** Where it says it is held, a line each (the place's name, its street, its town); empty when it says nothing. */
  location: string[];
}

/**
 * Where a site lists its events for machines, as found on the page: The Events Calendar's REST API
 * (WordPress), an iCalendar feed it links, or a page of its own for events (read for its JSON-LD).
 */
export interface EventsFeed {
  format: "tec" | "ical" | "page";
  url: string;
}

export interface FirstPartyExtraction {
  url: string;
  fetchedAt: Date;
  facts: ExtractedFact[];
  events: ExtractedEvent[];
  /** JSON-LD blocks found (for diagnostics) */
  blocks: number;
  types: string[];
  /** Links to where the site states its hours, best first (only when this page states none). */
  hoursLinks?: string[];
  /** Where the site lists its events, when the page shows one (see eventsFeedOf). */
  eventsFeed?: EventsFeed;
}

const DAY_INDEX: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
  su: 0, mo: 1, tu: 2, we: 3, th: 4, fr: 5, sa: 6,
};

function dayFromSchema(v: unknown): number[] {
  const list = Array.isArray(v) ? v : [v];
  const out: number[] = [];
  for (const d of list) {
    if (typeof d !== "string") continue;
    const key = d.split("/").pop()!.toLowerCase();
    const idx = ownValue(DAY_INDEX, key);
    if (idx !== undefined) out.push(idx);
  }
  return out;
}

function hhmmToMinutes(s: unknown): number | null {
  if (typeof s !== "string") return null;
  const m = /^(\d{1,2}):(\d{2})/.exec(s.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 24 || mi > 59) return null;
  return h * 60 + mi;
}

const LD_JSON_TYPE = /\btype\s*=\s*["']application\/ld\+json["']/i;

/**
 * JSON-LD blocks in a page. The page is untrusted and up to the fetch cap (3 MB), so this is one
 * forward scan: each `<script` is visited once and the next search starts after its `</script>`.
 * (The single regex this replaces backtracked quadratically: minutes on a crafted 3 MB page.)
 */
export function extractJsonLdBlocks(html: string): unknown[] {
  const out: unknown[] = [];
  const open = /<script\b/gi;
  const close = /<\/script>/gi;
  let tag: RegExpExecArray | null;
  while ((tag = open.exec(html))) {
    const attrsStart = tag.index + tag[0].length;
    const tagEnd = html.indexOf(">", attrsStart);
    if (tagEnd === -1) break;
    close.lastIndex = tagEnd + 1;
    const end = close.exec(html);
    if (!end) break;
    open.lastIndex = close.lastIndex;
    if (!LD_JSON_TYPE.test(html.slice(attrsStart, tagEnd))) continue;
    const body = html.slice(tagEnd + 1, end.index).trim();
    if (!body || body.length > 200_000) continue;
    try {
      out.push(JSON.parse(body));
    } catch {
      // Some sites ship trailing commas or comments; skip rather than guess.
    }
  }
  return out;
}

function flattenGraph(node: unknown, acc: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(node)) {
    for (const n of node) flattenGraph(n, acc);
    return acc;
  }
  if (node && typeof node === "object") {
    const o = node as Record<string, unknown>;
    if (Array.isArray(o["@graph"])) flattenGraph(o["@graph"], acc);
    if (o["@type"]) acc.push(o);
    for (const k of ["location", "subEvent", "event", "mainEntity"]) if (o[k]) flattenGraph(o[k], acc);
  }
  return acc;
}

function typesOf(o: Record<string, unknown>): string[] {
  const t = o["@type"];
  return (Array.isArray(t) ? t : [t]).filter((x): x is string => typeof x === "string").map((x) => x.split("/").pop()!);
}

const BUSINESS_TYPES = new Set([
  "LocalBusiness", "Restaurant", "CafeOrCoffeeShop", "BarOrPub", "Bakery", "IceCreamShop", "FoodEstablishment",
  "Museum", "ArtGallery", "MovieTheater", "PerformingArtsTheater", "MusicVenue", "Library", "BookStore", "Store",
  "TouristAttraction", "Park", "NightClub", "Organization", "EntertainmentBusiness", "Winery", "Brewery",
  "BowlingAlley", "Casino", "AmusementPark",
]);

export function openingHoursFromSpec(spec: unknown): { weekly: WeeklyIntervals; evidence: string } | null {
  const list = Array.isArray(spec) ? spec : [spec];
  const weekly: WeeklyIntervals = [];
  for (const s of list) {
    if (!s || typeof s !== "object") continue;
    const o = s as Record<string, unknown>;
    if (o["validFrom"] || o["validThrough"]) continue; // date-bounded exceptions: handle separately later
    const days = dayFromSchema(o["dayOfWeek"]);
    const open = hhmmToMinutes(o["opens"]);
    const close = hhmmToMinutes(o["closes"]);
    if (!days.length || open === null || close === null) continue;
    for (const d of days) weekly.push({ weekday: d, startMin: open, endMin: close <= open ? close + 1440 : close });
  }
  if (!weekly.length) return null;
  return { weekly, evidence: JSON.stringify(list).slice(0, 2000) };
}

function priceFromOffers(offers: unknown): ExtractedEvent["price"] {
  const list = Array.isArray(offers) ? offers : offers ? [offers] : [];
  let min: number | undefined;
  let max: number | undefined;
  let currency = "USD";
  for (const o of list) {
    if (!o || typeof o !== "object") continue;
    const r = o as Record<string, unknown>;
    const p = typeof r["price"] === "string" ? Number(r["price"]) : typeof r["price"] === "number" ? r["price"] : NaN;
    if (typeof r["priceCurrency"] === "string") currency = r["priceCurrency"];
    if (Number.isFinite(p)) {
      min = min === undefined ? p : Math.min(min, p);
      max = max === undefined ? p : Math.max(max, p);
    }
  }
  if (min === undefined) return null;
  return min === 0 && max === 0 ? { currency, free: true } : { min, max: max ?? min, currency };
}

/**
 * schema.org's openingHours text as OSM's opening_hours syntax, which it nearly is: sites write
 * "Mo 09:00 - 23:00 Tu 09:00 - 23:00" (no separator between days, spaces around the dash). Whether
 * the result reads is the caller's to check.
 */
export function osmHoursFromSchema(s: string): string {
  // Spaces first: `\s*-` over a long run of spaces is tried from each of them (quadratic).
  return s
    .replace(/\s+/g, " ")
    .replace(/ ?[-–] ?(?=\d)/g, "-")
    .replace(/(\d{2}:\d{2}) (?=(?:Mo|Tu|We|Th|Fr|Sa|Su|PH)\b)/g, "$1; ")
    .trim();
}

/** The most events one page may add, and the longest title kept: a page is untrusted and may list thousands. */
const MAX_EVENTS_PER_PAGE = 100;
const MAX_TITLE = 200;

/**
 * A schema.org date as an instant: one with an offset as it says; a date and time without one in
 * the venue's zone (sites write "2026-10-24T19:30", meaning their own clock); a date alone is the
 * whole day, from local midnight.
 */
export function schemaDate(v: unknown, timeZone: string): { at: Date; allDay: boolean } | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  // A calendar date and a clock time, or nothing (a date library would roll "2026-13-40" into 2027).
  const parts = /^\d{4}-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(s);
  if (!parts || +parts[1]! < 1 || +parts[1]! > 12 || +parts[2]! < 1 || +parts[2]! > 31 || (parts[3] !== undefined && (+parts[3] > 23 || +parts[4]! > 59))) return null;
  // A day the month does not have ("2026-02-30", "2026-04-31") is no date, not the 2nd of the next.
  if (new Date(Date.UTC(Number(s.slice(0, 4)), +parts[1]! - 1, +parts[2]!)).getUTCDate() !== +parts[2]!) return null;
  const day = /^(\d{4}-\d{2}-\d{2})$/.exec(s);
  if (day) {
    const at = fromLocal(day[1]!, 0, timeZone);
    return Number.isNaN(at.getTime()) ? null : { at, allDay: true };
  }
  const local = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(s);
  const at = local ? fromLocal(local[1]!, Number(local[2]) * 60 + Number(local[3]), timeZone) : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/.test(s) ? new Date(s) : null;
  return at && !Number.isNaN(at.getTime()) ? { at, allDay: false } : null;
}

export function extractFromJsonLd(blocks: unknown[], url: string, fetchedAt: Date, timeZone = "America/New_York"): FirstPartyExtraction {
  const nodes = flattenGraph(blocks);
  const facts: ExtractedFact[] = [];
  const events: ExtractedEvent[] = [];
  const types = new Set<string>();
  for (const n of nodes) {
    const ts = typesOf(n);
    ts.forEach((t) => types.add(t));
    if (ts.some((t) => BUSINESS_TYPES.has(t))) {
      if (typeof n["name"] === "string") facts.push({ attribute: "name", value: { value: n["name"] }, evidence: `"name": ${JSON.stringify(n["name"])}`, status: "stated" });
      if (typeof n["telephone"] === "string") facts.push({ attribute: "phone", value: { value: n["telephone"] }, evidence: `"telephone": ${JSON.stringify(n["telephone"])}`, status: "stated" });
      const spec = n["openingHoursSpecification"];
      const parsed = spec ? openingHoursFromSpec(spec) : null;
      if (parsed) facts.push({ attribute: "opening_hours", value: { weekly: parsed.weekly }, evidence: parsed.evidence, status: "stated", method: "jsonld" });
      else if (typeof n["openingHours"] === "string" || Array.isArray(n["openingHours"])) {
        const s = (Array.isArray(n["openingHours"]) ? (n["openingHours"] as unknown[]).filter((x) => typeof x === "string").join("; ") : (n["openingHours"] as string)).trim();
        // An empty value (a site template's placeholder) states nothing, and a page of text is no hours.
        if (/\d/.test(s) && s.length <= 1000) facts.push({ attribute: "opening_hours", value: { osm: osmHoursFromSchema(s) }, evidence: `"openingHours": ${JSON.stringify(s)}`, status: "stated", method: "jsonld" });
      }
      if (typeof n["priceRange"] === "string") {
        const tier = (n["priceRange"].match(/\$/g) ?? []).length;
        const bands: Record<number, [number, number]> = { 1: [0, 15], 2: [15, 35], 3: [35, 70], 4: [70, 150] };
        const band = bands[tier];
        facts.push({
          attribute: "price",
          value: band ? { min: band[0], max: band[1], currency: "USD", basis: "per_person", tier } : { currency: "USD", basis: "per_person", unknown: true },
          evidence: `"priceRange": ${JSON.stringify(n["priceRange"])}`,
          status: band ? "stated" : "ambiguous",
        });
      }
      if (n["acceptsReservations"] !== undefined) {
        const v = n["acceptsReservations"];
        const accepts = v === true || v === "True" || v === "true" || (typeof v === "string" && v.startsWith("http"));
        facts.push({ attribute: "admission", value: { requirement: accepts ? "reservation_available" : "walk_in" }, evidence: `"acceptsReservations": ${JSON.stringify(v)}`, status: "stated" });
      }
    }
    if (ts.some((t) => t === "Event" || t.endsWith("Event")) && events.length < MAX_EVENTS_PER_PAGE) {
      const begins = schemaDate(n["startDate"], timeZone);
      if (!begins) continue;
      const start = begins.at;
      const end = schemaDate(n["endDate"], timeZone)?.at ?? null;
      const st = typeof n["eventStatus"] === "string" ? n["eventStatus"].split("/").pop()! : "EventScheduled";
      const status: ExtractedEvent["status"] = st === "EventCancelled" ? "cancelled" : "scheduled";
      const offers = n["offers"];
      const soldOut = Array.isArray(offers) ? offers.some((o) => typeof (o as Record<string, unknown>)?.["availability"] === "string" && String((o as Record<string, unknown>)["availability"]).endsWith("SoldOut")) : offers && typeof offers === "object" && String((offers as Record<string, unknown>)["availability"] ?? "").endsWith("SoldOut");
      events.push({
        title: (typeof n["name"] === "string" ? n["name"].replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, MAX_TITLE) : "") || "(untitled event)",
        kinds: [...new Set(ts.map((t) => ownValue(EVENT_TYPE_INTERESTS, t)).filter((k): k is Interest => k !== undefined))].slice(0, 4),
        start,
        end: end && !Number.isNaN(end.getTime()) ? end : null,
        status: soldOut ? "sold_out" : status,
        price: priceFromOffers(offers),
        url: typeof n["url"] === "string" ? n["url"] : null,
        evidence: JSON.stringify({ name: n["name"], startDate: n["startDate"], endDate: n["endDate"], eventStatus: n["eventStatus"] }).slice(0, 1000),
        types: ts.filter((t) => t === "Event" || t.endsWith("Event") || t === "Festival").slice(0, 4),
        allDay: begins.allDay,
        free: n["isAccessibleForFree"] === true || n["isAccessibleForFree"] === "true" || n["isAccessibleForFree"] === "True",
        location: eventLocation(n["location"]),
      });
    }
  }
  return { url, fetchedAt, facts, events, blocks: blocks.length, types: [...types] };
}

/**
 * Everything a venue's page states: its JSON-LD; and, when that gives no hours, the hours in its
 * microdata or written in its text; and, when the page states none at all, where on the site it
 * might (hoursLinks).
 */
export function extractPage(html: string, url: string, fetchedAt: Date, opts: { text?: boolean } = {}): FirstPartyExtraction {
  const feed = eventsFeedOf(html, url);
  const x: FirstPartyExtraction = { ...extractFromJsonLd(extractJsonLdBlocks(html), url, fetchedAt), ...(feed ? { eventsFeed: feed } : {}) };
  if (x.facts.some((f) => f.attribute === "opening_hours")) return x;
  const micro = microdataHours(html);
  if (micro.length) {
    const osm = osmHoursFromSchema(micro.join("; "));
    x.facts.push({ attribute: "opening_hours", value: { osm }, evidence: `itemprop="openingHours": ${JSON.stringify(osm)}`, status: "stated", method: "microdata" });
    return x;
  }
  // A page's own words for its hours only where they are its venue's (not a town's site, or a chain's).
  const visible = opts.text === false ? null : visibleText(html);
  const text = visible ? hoursFromText(visible.lines, visible) : null;
  if (text) {
    x.facts.push({ attribute: "opening_hours", value: { weekly: text.weekly }, evidence: `page text: ${JSON.stringify(text.evidence)}`, status: "stated", method: "text" });
    return x;
  }
  return { ...x, hoursLinks: hoursLinks(html, url).slice(0, 3) };
}

/** One line of what a page says, as plain text: no control characters, at most `max` characters. */
const line = (v: unknown, max = 200): string => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "");

/** Where an event says it is held: a Place's name, street and town; a plain string as it is. */
function eventLocation(v: unknown): string[] {
  const place = Array.isArray(v) ? v[0] : v;
  if (typeof place === "string") return [line(place)].filter(Boolean);
  if (!place || typeof place !== "object") return [];
  const p = place as Record<string, unknown>;
  const address = p["address"];
  const a = address && typeof address === "object" && !Array.isArray(address) ? (address as Record<string, unknown>) : null;
  return [line(p["name"]), a ? line(a["streetAddress"]) : line(address), a ? line(a["addressLocality"]) : ""].filter(Boolean).slice(0, 3);
}

/** A page of a site's own for its events, by its address: /events, /calendar, /shows, /whats-on … */
const EVENTS_PATH = /^\/(?:[a-z-]+\/)?(?:events?|calendar|shows?|whats-?on|performances?|concerts?|schedule|upcoming|programs?)(?:\/|$)/i;

/**
 * Where a page shows its site lists events, best first: The Events Calendar's REST API (a WordPress
 * site running it names "tribe-events" or its API), an iCalendar feed it links, or a link to a page
 * of its own for events (same site). Linear in the page: each tag is read at most 500 characters.
 */
export function eventsFeedOf(html: string, url: string): EventsFeed | undefined {
  const here = new URL(url);
  if (/\/wp-json\/tribe\/events\/v1\b|\btribe-events\b/.test(html)) return { format: "tec", url: `${here.origin}/wp-json/tribe/events/v1/events` };
  for (const m of html.matchAll(/<link\b[^<>]{0,500}>/gi)) {
    if (!/\btype\s*=\s*["']text\/calendar["']/i.test(m[0])) continue;
    const href = /\bhref\s*=\s*["']([^"'<>]{1,500})["']/i.exec(m[0])?.[1];
    const to = href ? sameSiteUrl(href, here) : null;
    if (to) return { format: "ical", url: to };
  }
  let seen = 0;
  for (const m of html.matchAll(/<a\b[^<>]{0,500}>/gi)) {
    if (seen++ > 500) break;
    const href = /\bhref\s*=\s*["']([^"'<>]{1,300})["']/i.exec(m[0])?.[1];
    const to = href ? sameSiteUrl(href, here) : null;
    if (to && EVENTS_PATH.test(new URL(to).pathname) && to !== here.toString()) return { format: "page", url: to };
  }
  return undefined;
}

/** A link on the page as an https URL on the page's own site (its www. or bare name), or null. */
function sameSiteUrl(href: string, here: URL): string | null {
  let to: URL;
  try {
    to = new URL(href.replace(/&amp;/g, "&"), here);
  } catch {
    return null;
  }
  if (to.protocol !== "https:" && to.protocol !== "http:") return null;
  if (to.host.replace(/^www\./, "") !== here.host.replace(/^www\./, "")) return null;
  to.hash = "";
  if (to.protocol === "http:" && here.protocol === "https:") to.protocol = "https:";
  return to.toString();
}

/** A venue page: same-host pacing (throttleKey) is the caller's, at least `minIntervalMs` apart. */
export async function fetchAndExtract(url: string, opts: { throttleKey?: string; minIntervalMs?: number; text?: boolean; beforeRequest?: RequestGate } = {}): Promise<FirstPartyExtraction> {
  const res = await guardedFetch(url, {
    sourceId: "firstparty",
    ...(opts.throttleKey ? { throttleKey: opts.throttleKey } : {}),
    ...(opts.beforeRequest ? { beforeRequest: opts.beforeRequest } : {}),
    accept: "text/html, application/xhtml+xml",
    allowedContentTypes: ["text/html", "application/xhtml+xml"],
    maxBytes: 3 * 1024 * 1024,
    minIntervalMs: opts.minIntervalMs ?? 5000,
    retries: 1,
    timeoutMs: 20_000,
    // A site moving between its www. and bare name is the same site; anywhere else is the caller's to follow.
    sameSiteRedirects: true,
  });
  return extractPage(res.text, res.url, res.fetchedAt, opts.text === undefined ? {} : { text: opts.text });
}
