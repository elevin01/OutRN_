import { ownValue, type Interest, type WeeklyIntervals } from "@outrn/core";
import { guardedFetch } from "./fetch.js";

/**
 * First-party extraction, rung 1 of the ladder: schema.org JSON-LD published by the venue
 * itself. No LLM, no prose parsing. Every extracted fact carries the JSON it came from as
 * evidence so a reviewer can check it. Raw HTML is never retained.
 *
 * Rungs 2 (site-specific parser) and 3 (LLM over bounded text) plug into the same
 * ExtractedFact shape; they are not implemented here.
 */

export type ExtractionStatus = "stated" | "not_stated" | "ambiguous";

export interface ExtractedFact {
  attribute: "opening_hours" | "price" | "phone" | "name" | "admission" | "business_status";
  value: unknown;
  evidence: string;
  status: ExtractionStatus;
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
}

export interface FirstPartyExtraction {
  url: string;
  fetchedAt: Date;
  facts: ExtractedFact[];
  events: ExtractedEvent[];
  /** JSON-LD blocks found (for diagnostics) */
  blocks: number;
  types: string[];
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

export function extractFromJsonLd(blocks: unknown[], url: string, fetchedAt: Date): FirstPartyExtraction {
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
      if (parsed) facts.push({ attribute: "opening_hours", value: { weekly: parsed.weekly }, evidence: parsed.evidence, status: "stated" });
      else if (typeof n["openingHours"] === "string" || Array.isArray(n["openingHours"])) {
        const s = Array.isArray(n["openingHours"]) ? (n["openingHours"] as unknown[]).filter((x) => typeof x === "string").join("; ") : (n["openingHours"] as string);
        facts.push({ attribute: "opening_hours", value: { osm: s }, evidence: `"openingHours": ${JSON.stringify(s)}`, status: "stated" });
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
    if (ts.some((t) => t === "Event" || t.endsWith("Event"))) {
      const start = typeof n["startDate"] === "string" ? new Date(n["startDate"]) : null;
      if (!start || Number.isNaN(start.getTime())) continue;
      const end = typeof n["endDate"] === "string" ? new Date(n["endDate"]) : null;
      const st = typeof n["eventStatus"] === "string" ? n["eventStatus"].split("/").pop()! : "EventScheduled";
      const status: ExtractedEvent["status"] = st === "EventCancelled" ? "cancelled" : "scheduled";
      const offers = n["offers"];
      const soldOut = Array.isArray(offers) ? offers.some((o) => typeof (o as Record<string, unknown>)?.["availability"] === "string" && String((o as Record<string, unknown>)["availability"]).endsWith("SoldOut")) : offers && typeof offers === "object" && String((offers as Record<string, unknown>)["availability"] ?? "").endsWith("SoldOut");
      events.push({
        title: typeof n["name"] === "string" ? n["name"] : "(untitled event)",
        kinds: [...new Set(ts.map((t) => ownValue(EVENT_TYPE_INTERESTS, t)).filter((k): k is Interest => k !== undefined))].slice(0, 4),
        start,
        end: end && !Number.isNaN(end.getTime()) ? end : null,
        status: soldOut ? "sold_out" : status,
        price: priceFromOffers(offers),
        url: typeof n["url"] === "string" ? n["url"] : null,
        evidence: JSON.stringify({ name: n["name"], startDate: n["startDate"], endDate: n["endDate"], eventStatus: n["eventStatus"] }).slice(0, 1000),
      });
    }
  }
  return { url, fetchedAt, facts, events, blocks: blocks.length, types: [...types] };
}

export async function fetchAndExtract(url: string): Promise<FirstPartyExtraction> {
  const res = await guardedFetch(url, {
    sourceId: "firstparty",
    accept: "text/html, application/xhtml+xml",
    allowedContentTypes: ["text/html", "application/xhtml+xml"],
    maxBytes: 3 * 1024 * 1024,
    minIntervalMs: 5000,
    retries: 1,
    timeoutMs: 20_000,
  });
  return extractFromJsonLd(extractJsonLdBlocks(res.text), res.url, res.fetchedAt);
}
