import { readFile, writeFile } from "node:fs/promises";
import { fromLocal, haversineMetres, type Interest, type LatLon } from "@outrn/core";
import { assertSourceAllowed, getArea, loadParkingRule, type Db } from "@outrn/db";
import { fetchNycParksEvents, parseNycParksCapture, type NycParksCapture, type NycParksEventRow } from "@outrn/sources";
import { ingestEvents, type EventInput, type EventsSummary } from "./events.js";
import { ingestExtentFor } from "./pipeline.js";

/**
 * NYC Parks' public events (see fetchNycParksEvents) as events of an area: the rows held within the
 * area's reach, in the events file's shape, then written by ingestEvents like any other source's.
 * What a row says is kept as it says it: when it starts and ends, where, what kind of event (its
 * categories, as interests), whether to register first, and free only when the listing says so.
 */

/** NYC Parks' categories as interests; categories about who it's for (kids, seniors) are not one. */
const INTERESTS_OF: Readonly<Record<string, Interest>> = {
  "Concerts": "live_music",
  "Free Summer Concerts": "live_music",
  "Film": "film",
  "Movies Under the Stars": "film",
  "Free Summer Movies": "film",
  "Theater": "theatre",
  "Dance": "theatre",
  "Dance Classes": "theatre",
  "Art": "art",
  "Arts & Crafts": "art",
  "History": "museums",
  "Open House New York": "museums",
  "Festivals": "festivals",
  "Fall Festivals": "festivals",
  "Halloween": "festivals",
  "Arts, Culture & Fun Series": "festivals",
  "Nature": "outdoors",
  "Wildlife": "outdoors",
  "Birding": "outdoors",
  "Hiking": "outdoors",
  "Walking": "outdoors",
  "Gardening": "outdoors",
  "Urban Park Rangers": "outdoors",
  "Waterfront": "outdoors",
  "Astronomy": "outdoors",
  "Tours": "outdoors",
  "Sports": "sports",
  "Fitness": "sports",
  "Exercise Classes": "sports",
  "Outdoor Fitness": "sports",
  "Running/Jogging": "sports",
  "Yoga & Pilates Classes": "sports",
  "Basketball/Netball": "sports",
  "Social Sports": "sports",
  "Bicycling": "sports",
  "Adventure Courses/Rock Climbing": "sports",
  "Games": "games",
  "Food": "food",
  "Markets": "markets",
  "Talks": "books",
  "Workshops": "books",
};

/** Not something to go out to: online, or a public meeting. */
const NOT_AN_OUTING = new Set(["Virtual/Online Events", "Community Input Meetings"]);

const ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** The table's titles and places carry HTML entities ("NYC Parks&#8217;", "P&#233;tanque"). */
export function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d{1,7});|&#x([0-9a-f]{1,6});|&([a-z]+);/gi, (m, dec: string | undefined, hex: string | undefined, name: string | undefined) => {
      const code = dec ? Number(dec) : hex ? parseInt(hex, 16) : null;
      if (code !== null) return code > 0x1f && code <= 0x10ffff && !(code >= 0x7f && code <= 0x9f) ? String.fromCodePoint(code) : " ";
      return ENTITIES[name!.toLowerCase()] ?? m;
    })
    .replace(/\s+/g, " ")
    .trim();
}

/** At most `max` characters, cut at a word. */
function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), max / 2)).trimEnd()}…`;
}

/** A row's local wall-clock time ("2026-10-17T08:30:00.000") in its time zone. */
function localTime(s: string | undefined, timeZone: string): Date | null {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/.exec(s ?? "");
  if (!m) return null;
  const t = fromLocal(m[1]!, Number(m[2]) * 60 + Number(m[3]), timeZone);
  return Number.isNaN(t.getTime()) ? null : t;
}

/** The first point of a row's "lat, lon[; lat, lon…]". */
function firstPoint(s: string | undefined): LatLon | null {
  const [lat, lon] = (s ?? "").split(";")[0]!.split(",").map((x) => Number(x.trim()));
  if (lat === undefined || lon === undefined || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180 || (lat === 0 && lon === 0)) return null;
  return { lat, lon };
}

/** NYC Parks' own pages are served over https too. */
function eventUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  return raw.replace(/^http:\/\/(www\.)?nycgovparks\.org\//i, "https://www.nycgovparks.org/");
}

/** What the listing says about getting in: register first, come along, or it's full. */
function entry(r: NycParksEventRow): { admission?: EventInput["admission"]; closed: boolean } {
  const d = (r.registration_description ?? "").toLowerCase();
  if (/registration is closed/.test(d)) return { closed: true };
  if (/\b(not required|no registration)\b|self-guided/.test(d)) return { admission: "walk_in", closed: false };
  if (r.registration_url?.url || /registration (has begun|is required)|\brsvp\b|by appointment|sign up/.test(d)) return { admission: "reservation", closed: false };
  return { closed: false };
}

export type NycParksSkip = "far" | "no_time" | "no_place" | "online" | "over";

/**
 * The rows held within `radiusM` of the area that have not ended, as events (see the header). Each
 * row is one event on one day: its id is NYC Parks' own.
 */
export function nycParksEvents(rows: readonly NycParksEventRow[], area: { center: LatLon; radiusM: number; timezone: string }, now: Date): { events: EventInput[]; skipped: Record<NycParksSkip, number> } {
  const skipped: Record<NycParksSkip, number> = { far: 0, no_time: 0, no_place: 0, online: 0, over: 0 };
  const events: EventInput[] = [];
  for (const r of rows) {
    const point = firstPoint(r.coordinates);
    if (!point) {
      skipped.no_place++;
      continue;
    }
    if (haversineMetres(point, area.center) > area.radiusM) {
      skipped.far++;
      continue;
    }
    const categories = (r.categories ?? "").split("|").map((c) => decodeEntities(c)).filter(Boolean);
    if (categories.some((c) => NOT_AN_OUTING.has(c))) {
      skipped.online++;
      continue;
    }
    const start = localTime(r.starttime, area.timezone);
    if (!start) {
      skipped.no_time++;
      continue;
    }
    let end = localTime(r.endtime, area.timezone);
    // An end before the start runs past midnight, when that makes an evening of it; else it's unknown.
    if (end && end <= start) {
      const next = new Date(end.getTime() + 86_400_000);
      end = next > start && next.getTime() - start.getTime() <= 12 * 3_600_000 ? next : null;
    }
    if ((end ?? new Date(start.getTime() + 2 * 3_600_000)) < now) {
      skipped.over++;
      continue;
    }
    const title = clip(decodeEntities(r.title), 200);
    const description = decodeEntities(r.description ?? "");
    const kinds = [...new Set(categories.map((c) => INTERESTS_OF[c]).filter((k): k is Interest => k !== undefined))].slice(0, 4);
    const { admission, closed } = entry(r);
    // A cancelled event stays listed, its title saying so ("CANCELED: Zumba").
    const cancelled = /^\W*cancell?ed\b/i.test(title);
    const free = /\bfree\b/i.test(`${title} ${description}`) && !/\$\s?\d/.test(`${title} ${description}`);
    const placeName = clip(decodeEntities(r.location || r.parknames || "") || "NYC Parks", 120);
    const url = eventUrl(r.link?.url);
    events.push({
      id: r.guid,
      title,
      start: start.toISOString(),
      end: end ? end.toISOString() : null,
      ...(cancelled ? { status: "cancelled" as const } : closed ? { status: "sold_out" as const } : {}),
      ...(url ? { url } : {}),
      ...(kinds.length ? { kinds } : {}),
      ...(categories.includes("Best for Kids") ? { forKids: true as const } : {}),
      ...(admission ? { admission } : {}),
      ...(free ? { price: { free: true as const } } : {}),
      place: { name: placeName, lat: point.lat, lon: point.lon },
    });
  }
  return { events, skipped };
}

export interface NycParksIngestOptions {
  areaSlug: string;
  /** Replay a saved read (`--save`) instead of reading the table. */
  fromFile?: string;
  /** Save the rows the area holds, for replay. */
  saveTo?: string;
  now?: Date;
  log?: (line: string) => void;
}

export interface NycParksIngestSummary extends EventsSummary {
  rows: number;
  skipped: Record<NycParksSkip, number>;
}

export async function ingestNycParksEvents(db: Db, opts: NycParksIngestOptions): Promise<NycParksIngestSummary> {
  const log = opts.log ?? (() => undefined);
  await assertSourceAllowed(db, "nyc_parks", "derive");
  if (!opts.fromFile) await assertSourceAllowed(db, "nyc_parks", "fetch");
  const area = await getArea(db, opts.areaSlug);
  const { radiusM } = ingestExtentFor(area, await loadParkingRule(db, area.slug));
  const center = { lat: Number(area.lat), lon: Number(area.lon) };

  let capture: NycParksCapture;
  if (opts.fromFile) {
    let data: unknown;
    try {
      data = JSON.parse(await readFile(opts.fromFile, "utf8"));
    } catch (e) {
      throw new Error(`${opts.fromFile} is not an NYC Parks events capture (outrn ingest nyc-parks --save): ${(e as Error).message}`);
    }
    capture = parseNycParksCapture(data, opts.fromFile);
  } else {
    const read = await fetchNycParksEvents();
    log(`read ${read.rows.length} NYC Parks events${read.unreadable ? ` (${read.unreadable} rows unreadable)` : ""}`);
    capture = read;
  }
  const now = opts.now ?? new Date();
  const { events, skipped } = nycParksEvents(capture.rows, { center, radiusM, timezone: area.timezone }, now);
  log(`${events.length} events within ${(radiusM / 1000).toFixed(1)} km of ${area.slug} (skipped: ${Object.entries(skipped).map(([k, n]) => `${k} ${n}`).join(", ")})`);
  if (opts.saveTo && !opts.fromFile) {
    // Only the rows this area holds: a replay selects the same events from them.
    const ids = new Set(events.map((e) => e.id));
    const saved: NycParksCapture = { ...capture, rows: capture.rows.filter((r) => ids.has(r.guid)) };
    await writeFile(opts.saveTo, JSON.stringify({ outrn_capture: saved.outrn_capture, dataset: saved.dataset, fetchedAt: saved.fetchedAt, rows: saved.rows }), "utf8");
  }
  const s = await ingestEvents(db, { source: "nyc_parks", events }, { areaSlug: area.slug, now, actor: "nyc_parks" });
  return { ...s, rows: capture.rows.length, skipped };
}
