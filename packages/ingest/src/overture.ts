import { writeFile } from "node:fs/promises";
import { haversineMetres, isPublicWebHost, matchKey, type Category, type FactInput } from "@outrn/core";
import { assertSourceAllowed, getArea, withTx, type Db, type Queryable } from "@outrn/db";
import { materializeSubjects, retractSourceFactsExcept, writeFacts } from "@outrn/facts";
import { fetchOverturePlaces, finishRun, loadOvertureCapture, overtureCapture, parseOvertureCapture, startRun, type Bbox, type OvertureCapture, type OverturePlace } from "@outrn/sources";

/**
 * Overture Maps places as a second opinion on the venues OSM gave us. It creates no venues: it
 * says whether a place is still operating, and fills a website or phone number no other source has.
 *
 *  - A venue matches an Overture place with the same name within 120 m, or within 40 m one whose name
 *    contains the other's (whole words, 5 characters at least) and whose category the venue's could be.
 *    A street name alone ("The Delancey") would otherwise match every "Delancey …" on its block.
 *  - Any open match: "operating", published. 0.75 when Overture's own status signal backs it,
 *    0.6 when only a confident record does (0.8+), nothing otherwise.
 *  - Closed: only when no match is open or temporarily closed, and a match closed permanently has
 *    all of: Overture's status signal (0.9+); the venue's name, within 60 m; a kind the venue's could
 *    be; a record confidence of 0.5+; a dataset other than a company register (a dissolved company
 *    is not a closed storefront). Never for a venue whose name is only generic words ("Deli &
 *    Grocery", "Pizza"): the same name 50 m away is as likely another shop. A closure excludes the
 *    venue and asks for a check, like one from OSM, unless a founder has seen it operating since.
 *  - Website and phone only when no other source has one for the venue, and only from a place with
 *    the venue's name or one that starts with it ("Rong Hang" → "Rong Hang Restaurant", never
 *    "Pickle Guys - Essex Market" for Essex Market). A website must also carry the venue's name in its
 *    domain: Overture lists magazine reviews and blog posts as places' websites.
 *
 * One claim per venue and attribute (no per-record claims): Overture's duplicates of a place agree
 * or are resolved here, and a venue no longer matched loses the claims on the next run.
 */

export const OVERTURE_MATCH_M = 120;
const PARTIAL_MATCH_M = 40;
const CLOSURE_MATCH_M = 60;
const SIGNAL = 0.9;
/** A closed place's record must be at least this sure it exists as described. */
const CLOSURE_CONFIDENCE = 0.5;
/** Company registers: a dissolved company is not a closed storefront. */
const COMPANY_REGISTERS = new Set(["BrightQuery"]);

/** Overture basic_category values, by the kinds of OutRN venue they can be. */
const EAT_DRINK = [
  "restaurant", "casual_eatery", "fast_food_restaurant", "food_court", "food_truck_stand", "food_and_beverage_store", "food_service", "food_and_drink",
  "coffee_shop", "cafe", "non_alcoholic_beverage_venue", "smoothie_juice_bar", "bar", "alcoholic_beverage_venue", "brewery", "winery", "distillery",
  "lounge", "nightlife_venue", "dance_club", "music_venue", "comedy_club", "farmers_market", "market", "kiosk",
];
const SHOWS = ["movie_theater", "theatre_venue", "performing_arts_venue", "music_venue", "comedy_club", "event_venue", "festival_venue", "arts_and_entertainment", "cultural_center", "nightlife_venue", "bar", "dance_club", "lounge"];
const CULTURE = [
  "art_gallery", "museum", "historic_site", "arts_and_entertainment", "cultural_center", "library", "monument", "sculpture_statue", "street_art", "memorial_site",
  "arts_and_crafts_space", "performing_arts_venue", "event_venue", "aquarium", "zoo", "animal_attraction", "community_center",
];
const OUTDOORS = [
  "park", "dog_park", "playground", "public_plaza", "skate_park", "garden", "nature_reserve", "beach", "pier", "marina", "river", "national_park",
  "recreational_trail_or_path", "public_fountain", "monument", "historic_site", "sculpture_statue", "memorial_site",
];
const PLAY = ["arcade", "gaming_venue", "amusement_park", "amusement_attraction", "sports_and_recreation", "skating_rink", "arts_and_entertainment", "event_venue", "bar", "restaurant"];
const BOOKS = ["books_music_and_video_store", "specialty_store", "coffee_shop", "cafe"];
const COMMUNITY = ["community_center", "cultural_center", "social_club", "library", "event_venue", "arts_and_entertainment", "arts_and_crafts_space"];

const ACCEPTS: Record<Category, ReadonlySet<string>> = {
  restaurant: new Set(EAT_DRINK),
  cafe: new Set(EAT_DRINK),
  bar: new Set([...EAT_DRINK, ...SHOWS]),
  dessert: new Set(EAT_DRINK),
  market: new Set(EAT_DRINK),
  nightclub: new Set([...EAT_DRINK, ...SHOWS]),
  cinema: new Set(SHOWS),
  theatre: new Set([...SHOWS, ...CULTURE]),
  live_music: new Set([...SHOWS, ...EAT_DRINK]),
  museum: new Set(CULTURE),
  gallery: new Set(CULTURE),
  arts_centre: new Set([...CULTURE, ...SHOWS]),
  attraction: new Set([...CULTURE, ...OUTDOORS, ...PLAY]),
  library: new Set(CULTURE),
  community: new Set(COMMUNITY),
  park: new Set(OUTDOORS),
  garden: new Set(OUTDOORS),
  waterfront: new Set(OUTDOORS),
  viewpoint: new Set([...OUTDOORS, ...CULTURE]),
  bowling: new Set(PLAY),
  arcade: new Set(PLAY),
  activity: new Set([...PLAY, ...CULTURE]),
  bookshop: new Set(BOOKS),
  other: new Set([...EAT_DRINK, ...SHOWS, ...CULTURE, ...OUTDOORS, ...PLAY, ...BOOKS, ...COMMUNITY]),
};

/** Every Overture category a venue could match: what a fetch keeps. */
export const OVERTURE_CATEGORIES: ReadonlySet<string> = new Set(Object.values(ACCEPTS).flatMap((s) => [...s]));

export interface MatchVenue {
  id: string;
  /** venues.name_key (matchKey of the name). */
  nameKey: string;
  category: Category;
  lat: number;
  lon: number;
}

export interface OvertureMatch {
  place: OverturePlace;
  metres: number;
  /** same: the names are equal (spacing aside); prefix: one starts with the other; within: one contains the other. */
  name: "same" | "prefix" | "within";
}

function namesMatch(venueKey: string, placeKey: string): OvertureMatch["name"] | null {
  if (!venueKey || !placeKey) return null;
  if (venueKey === placeKey || venueKey.replace(/ /g, "") === placeKey.replace(/ /g, "")) return "same";
  const [short, long] = venueKey.length <= placeKey.length ? [venueKey, placeKey] : [placeKey, venueKey];
  if (short.length < 5) return null;
  if (long.startsWith(`${short} `)) return "prefix";
  return ` ${long} `.includes(` ${short} `) ? "within" : null;
}

interface Indexed {
  place: OverturePlace;
  nameKey: string;
}

/** Places on a grid of about 250 m cells (wider than a match), so matching an area is not venues × places. */
export class PlaceIndex {
  private readonly cells = new Map<string, Indexed[]>();
  private static readonly CELL = 0.0025;
  constructor(places: readonly OverturePlace[]) {
    for (const place of places) {
      const k = PlaceIndex.cell(Math.floor(place.lat / PlaceIndex.CELL), Math.floor(place.lon / PlaceIndex.CELL));
      const list = this.cells.get(k) ?? [];
      list.push({ place, nameKey: matchKey(place.name) });
      this.cells.set(k, list);
    }
  }
  private static cell(i: number, j: number): string {
    return `${i}:${j}`;
  }
  near(lat: number, lon: number): Indexed[] {
    const i = Math.floor(lat / PlaceIndex.CELL);
    const j = Math.floor(lon / PlaceIndex.CELL);
    const out: Indexed[] = [];
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) out.push(...(this.cells.get(PlaceIndex.cell(i + di, j + dj)) ?? []));
    return out;
  }
}

export function matchVenue(v: MatchVenue, index: PlaceIndex): OvertureMatch[] {
  const accepts = ACCEPTS[v.category] ?? ACCEPTS.other;
  const out: OvertureMatch[] = [];
  for (const { place, nameKey } of index.near(v.lat, v.lon)) {
    const metres = haversineMetres(v, place);
    if (metres > OVERTURE_MATCH_M) continue;
    const name = namesMatch(v.nameKey, nameKey);
    // The same name at the same spot is the same place, whatever each source calls its kind (Overture
    // files community gardens under arts and entertainment); a partial name needs a kind that fits.
    if (!name || (name !== "same" && (metres > PARTIAL_MATCH_M || !accepts.has(place.category)))) continue;
    out.push({ place, metres, name });
  }
  // Best first: the same name, then Overture's confidence, then the nearest.
  const rank = { same: 0, prefix: 1, within: 2 } as const;
  return out.sort((a, b) => rank[a.name] - rank[b.name] || (b.place.confidence ?? 0) - (a.place.confidence ?? 0) || a.metres - b.metres);
}

/** Sites that are not the venue's own: a social profile or a delivery listing is no website. */
const NOT_OWN_SITE = /(^|\.)(facebook|fb|instagram|twitter|x|tiktok|yelp|tripadvisor|doordash|grubhub|ubereats|seamless|postmates|linktr|google|goo|opentable|resy)\.[a-z.]+$/;

/** Words too common to tie a domain, or a closure, to a venue: "pizza" is in pizzahut.com too. */
const GENERIC_WORDS = new Set([
  "restaurant", "cafe", "coffee", "kitchen", "pizza", "pizzeria", "grill", "deli", "grocery", "bakery", "market", "street", "avenue", "square", "place",
  "park", "garden", "gallery", "museum", "theatre", "theater", "cinema", "lounge", "club", "house", "shop", "store", "food", "foods", "york",
  "city", "east", "west", "north", "south", "village", "center", "centre", "company", "tavern", "wine", "beer", "bagel", "bagels", "sushi",
  "ramen", "noodle", "noodles", "thai", "chinese", "italian", "mexican", "japanese", "korean", "indian", "express", "original", "famous",
  "little", "community", "studio", "studios", "arts", "music", "books", "library", "church", "hall", "bistro", "cuisine", "and",
]);
/** Tracking parameters to drop from a link: they identify the listing that sent the visitor, not the page. */
const TRACKING = /^(utm_.*|y_source|fbclid|gclid|mc_[a-z]+|ref)$/i;

/** Whether a site's domain names the venue: a distinctive word of its name, or all of a short one. */
export function domainNamesVenue(hostname: string, venueNameKey: string): boolean {
  const host = hostname.toLowerCase().replace(/^www\./, "").replace(/[^a-z0-9]/g, "");
  const words = venueNameKey.split(" ").filter((w) => w.length >= 4 && !GENERIC_WORDS.has(w));
  if (words.length) return words.some((w) => host.includes(w));
  const whole = venueNameKey.replace(/ /g, "");
  return whole.length >= 3 && host.includes(whole);
}

/** A website a user may be sent to: http(s), a public host that is not a social or delivery page. */
export function venueWebsite(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (u.username || u.password || !isPublicWebHost(u.hostname)) return null;
  if (NOT_OWN_SITE.test(u.hostname.toLowerCase())) return null;
  for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
  u.hash = "";
  return u.toString();
}

/** A phone number to show: North American numbers as +1 212-555-0142, others as given with their +. */
export function venuePhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  const nanp = digits.length === 10 ? digits : digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : null;
  if (nanp && /^[2-9]\d{2}[2-9]\d{6}$/.test(nanp)) return `+1 ${nanp.slice(0, 3)}-${nanp.slice(3, 6)}-${nanp.slice(6)}`;
  if (raw.trim().startsWith("+") && digits.length >= 8 && digits.length <= 15) return `+${digits}`;
  return null;
}

export interface OvertureClaim {
  attribute: "business_status" | "website" | "phone";
  value: unknown;
  confidence: number;
  evidence: string;
  sourceUpdatedAt: Date | null;
}

const date = (s: string | null): Date | null => (s ? new Date(s) : null);

/** Whether every word of a name is a generic one ("deli and grocery", "pizza"): nothing ties a closure to this shop. */
export function genericName(nameKey: string): boolean {
  const words = nameKey.split(" ").filter(Boolean);
  return words.every((w) => GENERIC_WORDS.has(w));
}

/** A permanently closed match that may close the venue (see the header for the rule). */
function closes(venue: Pick<MatchVenue, "category">, m: OvertureMatch): boolean {
  const p = m.place;
  return (
    p.status === "permanently_closed" && (p.statusSignal ?? 0) >= SIGNAL &&
    m.name === "same" && m.metres <= CLOSURE_MATCH_M &&
    (ACCEPTS[venue.category] ?? ACCEPTS.other).has(p.category) &&
    (p.confidence ?? 0) >= CLOSURE_CONFIDENCE &&
    p.datasets.some((d) => !COMPANY_REGISTERS.has(d))
  );
}

/** What the matches say about a venue, given which attributes other sources already cover. */
export function claimsFor(venue: Pick<MatchVenue, "nameKey" | "category">, matches: readonly OvertureMatch[], has: { website: boolean; phone: boolean }): OvertureClaim[] {
  const venueNameKey = venue.nameKey;
  const claims: OvertureClaim[] = [];
  const open = matches.filter((m) => m.place.status === "open");
  const signalled = open.find((m) => (m.place.statusSignal ?? 0) >= SIGNAL);
  const confident = open.find((m) => (m.place.confidence ?? 0) >= 0.8);
  if (signalled) {
    const p = signalled.place;
    claims.push({ attribute: "business_status", value: { status: "operating" }, confidence: 0.75, evidence: `Overture place ${p.id} "${p.name}": open, by Overture's operating-status signal`, sourceUpdatedAt: date(p.statusUpdatedAt ?? p.updatedAt) });
  } else if (confident) {
    const p = confident.place;
    claims.push({ attribute: "business_status", value: { status: "operating" }, confidence: 0.6, evidence: `Overture place ${p.id} "${p.name}": open (${p.datasets.join(", ") || "Overture"})`, sourceUpdatedAt: date(p.updatedAt) });
  } else if (!open.length && !matches.some((m) => m.place.status === "temporarily_closed") && !genericName(venueNameKey)) {
    const closed = matches.find((m) => closes(venue, m));
    if (closed) {
      const p = closed.place;
      claims.push({ attribute: "business_status", value: { status: "closed_permanently" }, confidence: 0.65, evidence: `Overture place ${p.id} "${p.name}": permanently closed, by Overture's operating-status signal`, sourceUpdatedAt: date(p.statusUpdatedAt ?? p.updatedAt) });
    }
  }
  // Contact details only from a place believed to be operating, that is the venue and not something in it.
  const live = matches.filter((m) => m.place.status !== "permanently_closed" && m.name !== "within");
  if (!has.website) {
    for (const m of live) {
      const site = m.place.websites.map(venueWebsite).find((w): w is string => w !== null && domainNamesVenue(new URL(w).hostname, venueNameKey));
      if (site) {
        claims.push({ attribute: "website", value: { value: site }, confidence: 0.6, evidence: `Overture place ${m.place.id} "${m.place.name}": website`, sourceUpdatedAt: date(m.place.updatedAt) });
        break;
      }
    }
  }
  if (!has.phone) {
    for (const m of live) {
      const phone = m.place.phones.map(venuePhone).find((p): p is string => p !== null);
      if (phone) {
        claims.push({ attribute: "phone", value: { value: phone }, confidence: 0.6, evidence: `Overture place ${m.place.id} "${m.place.name}": phone`, sourceUpdatedAt: date(m.place.updatedAt) });
        break;
      }
    }
  }
  return claims;
}

/** The venues' extent plus a margin: every place that could match lies inside. */
export function bboxAround(points: readonly { lat: number; lon: number }[], marginM: number): Bbox {
  if (!points.length) throw new Error("no venues to look up");
  const lats = points.map((p) => p.lat);
  const lons = points.map((p) => p.lon);
  const south = Math.min(...lats), north = Math.max(...lats);
  const dLat = marginM / 111_320;
  const dLon = marginM / (111_320 * Math.cos((((south + north) / 2) * Math.PI) / 180));
  const r = (x: number) => Math.round(x * 1e5) / 1e5;
  return { west: r(Math.min(...lons) - dLon), south: r(south - dLat), east: r(Math.max(...lons) + dLon), north: r(north + dLat) };
}

function inside(b: Bbox, p: { lat: number; lon: number }, marginM: number): boolean {
  const dLat = marginM / 111_320;
  const dLon = marginM / (111_320 * Math.cos((p.lat * Math.PI) / 180));
  return p.lat >= b.south + dLat && p.lat <= b.north - dLat && p.lon >= b.west + dLon && p.lon <= b.east - dLon;
}

export interface OvertureIngestOptions {
  areaSlug: string;
  /** Replay a saved capture instead of reading the bucket. */
  fromFile?: string;
  /** Save what was read, for replay. */
  saveTo?: string;
  /** An Overture release ("2026-09-23.1"); the newest when omitted. */
  release?: string;
  clock?: () => Date;
  log?: (line: string) => void;
}

export interface OvertureIngestSummary {
  runId: string;
  area: string;
  release: string;
  places: number;
  venues: { considered: number; matched: number };
  claims: { operating: number; closed: number; website: number; phone: number };
  facts: { inserted: number; superseded: number; rejected: number };
  materialized: { subjects: number; conflicts: number; tasks: number };
  read: { rowGroups: number; totalRowGroups: number; bytes: number } | null;
}

interface VenueRow {
  id: string;
  name_key: string;
  category: Category;
  lat: number;
  lon: number;
}

async function areaVenues(q: Queryable, areaId: string): Promise<VenueRow[]> {
  return (
    await q.query<VenueRow>(
      `select id, name_key, category, ST_Y(geom::geometry) as lat, ST_X(geom::geometry) as lon from venues where area_id = $1 and publish_state <> 'merged' order by id`,
      [areaId],
    )
  ).rows;
}

/** Venues with a website or phone from a source other than Overture. */
async function coveredElsewhere(q: Queryable, venueIds: string[], now: Date): Promise<Map<string, Set<string>>> {
  const r = await q.query<{ subject_id: string; attribute: string }>(
    `select distinct subject_id, attribute from facts
      where subject_kind = 'venue' and subject_id = any($1::uuid[]) and attribute in ('website', 'phone')
        and source_id <> 'overture' and superseded_at is null and (valid_until is null or valid_until > $2)`,
    [venueIds, now],
  );
  const out = new Map<string, Set<string>>();
  for (const row of r.rows) out.set(row.subject_id, (out.get(row.subject_id) ?? new Set()).add(row.attribute));
  return out;
}

export async function ingestOverture(db: Db, opts: OvertureIngestOptions): Promise<OvertureIngestSummary> {
  const log = opts.log ?? (() => undefined);
  const area = await getArea(db, opts.areaSlug);
  await assertSourceAllowed(db, "overture", "derive");
  if (!opts.fromFile) await assertSourceAllowed(db, "overture", "fetch");
  const venues = await areaVenues(db, area.id);
  if (!venues.length) throw new Error(`${area.slug} has no venues yet: ingest it from OSM first (outrn ingest osm --area ${area.slug})`);

  let capture: OvertureCapture;
  let read: OvertureIngestSummary["read"] = null;
  if (opts.fromFile) {
    capture = await loadOvertureCapture(opts.fromFile);
    if (opts.release && opts.release !== capture.release) throw new Error(`${opts.fromFile} is release ${capture.release}, not ${opts.release}`);
  } else {
    const bbox = bboxAround(venues, OVERTURE_MATCH_M + 30);
    log(`reading Overture places in ${bbox.west},${bbox.south},${bbox.east},${bbox.north}`);
    const r = await fetchOverturePlaces({ bbox, categories: OVERTURE_CATEGORIES, ...(opts.release ? { release: opts.release } : {}), log });
    log(`read ${r.rowGroups.read} of ${r.rowGroups.total} row groups, ${(r.bytes / 1_048_576).toFixed(0)} MB; ${r.places.length} places kept (${r.skipped.category} other kinds, ${r.skipped.license} other or missing licenses)`);
    // The same check as a replay: a read that would not replay is not written either.
    capture = parseOvertureCapture(overtureCapture(r), "the Overture read");
    read = { rowGroups: r.rowGroups.read, totalRowGroups: r.rowGroups.total, bytes: r.bytes };
    // Saved before anything is written: a failure below can be replayed without reading the bucket again.
    if (opts.saveTo) await writeFile(opts.saveTo, JSON.stringify(capture), "utf8");
  }
  const now = opts.clock?.() ?? new Date();
  const runId = await startRun(db, { sourceId: "overture", areaId: area.id, kind: opts.fromFile ? "replay" : "overture_places", params: { release: capture.release, bbox: capture.bbox, from_file: opts.fromFile ?? null } });
  try {
    const index = new PlaceIndex(capture.places);
    // Venues the capture covers entirely; the rest keep whatever an earlier run said.
    const considered = venues.filter((v) => inside(capture.bbox, v, OVERTURE_MATCH_M));
    const covered = await coveredElsewhere(db, considered.map((v) => v.id), now);
    const summary: OvertureIngestSummary = {
      runId,
      area: area.slug,
      release: capture.release,
      places: capture.places.length,
      venues: { considered: considered.length, matched: 0 },
      claims: { operating: 0, closed: 0, website: 0, phone: 0 },
      facts: { inserted: 0, superseded: 0, rejected: 0 },
      materialized: { subjects: 0, conflicts: 0, tasks: 0 },
      read,
    };
    await withTx(db, async (tx) => {
      const changed: string[] = [];
      for (const v of considered) {
        const matches = matchVenue({ id: v.id, nameKey: v.name_key, category: v.category, lat: v.lat, lon: v.lon }, index);
        if (matches.length) summary.venues.matched++;
        const has = covered.get(v.id);
        const claims = claimsFor({ nameKey: v.name_key, category: v.category }, matches, { website: has?.has("website") ?? false, phone: has?.has("phone") ?? false });
        for (const c of claims) {
          if (c.attribute !== "business_status") summary.claims[c.attribute]++;
          else if ((c.value as { status: string }).status === "operating") summary.claims.operating++;
          else summary.claims.closed++;
        }
        const facts: FactInput[] = claims.map((c) => ({
          subjectKind: "venue",
          subjectId: v.id,
          attribute: c.attribute,
          value: c.value,
          evidenceClass: "published",
          sourceId: "overture",
          evidence: c.evidence,
          sourceUpdatedAt: c.sourceUpdatedAt,
          fetchedAt: now,
          confidence: c.confidence,
          lineageGroup: "overture",
          ingestionRunId: runId,
        }));
        const w = await writeFacts(tx, facts);
        const retracted = await retractSourceFactsExcept(tx, "venue", v.id, "overture", claims.map((c) => c.attribute));
        summary.facts.inserted += w.inserted;
        summary.facts.superseded += w.superseded + retracted;
        summary.facts.rejected += w.rejected.length;
        for (const r of w.rejected) log(`  ${v.id}: ${r.attribute} rejected: ${r.reason}`);
        if (w.inserted || w.superseded || retracted) changed.push(v.id);
      }
      const mat = await materializeSubjects(tx, "venue", changed, now);
      summary.materialized = { subjects: mat.subjects, conflicts: mat.conflicts, tasks: mat.tasksCreated };
    });
    await finishRun(db, runId, {
      status: "succeeded",
      counts: { places: summary.places, venues_considered: summary.venues.considered, venues_matched: summary.venues.matched, ...Object.fromEntries(Object.entries(summary.claims).map(([k, n]) => [`claims_${k}`, n])), facts_inserted: summary.facts.inserted, facts_superseded: summary.facts.superseded },
    });
    return summary;
  } catch (e) {
    await finishRun(db, runId, { status: "failed", error: (e as Error).message });
    throw e;
  }
}
