import { readFile, writeFile } from "node:fs/promises";
import { destinationMaxTravel, haversineMetres, matchKey, maxReachMetres, parkingBufferAt, type Category, type DestinationKind, type FactInput, type LatLon } from "@outrn/core";
import { assertSourceAllowed, getArea, loadParkingRule, withTx, type Db, type Queryable } from "@outrn/db";
import { materializeSubjects, retractSourceFacts, writeFacts } from "@outrn/facts";
import { createIfNew } from "@outrn/identity";
import { fetchOverturePlaces, finishRun, overtureCapture, parseOvertureCapture, startRun, type Bbox, type OvertureCapture, type OverturePlace } from "@outrn/sources";
import { mostlyLatin, placeFacts, upsertPlace, venuePhone, venueWebsite } from "./overture.js";

/**
 * Destinations: places worth going out of the way for (a preserve, gardens, a beach, a lookout over
 * the Hudson, an estate), which a longer outing is built around. They come from Overture's places
 * around an area, out to the farthest a long window may travel for one (destinationMaxTravel):
 *
 *  - A short curated list per region: the places anyone local would name, with a line on why.
 *    Each entry names the place and roughly where it is; the record nearest that, of that name, is
 *    the place. Names, points and contact details are the record's, never the list's.
 *  - And places whose own record says what they are: a nature reserve or a park whose name says it
 *    is a preserve, a sanctuary, a reservation, a nature center or an arboretum (Overture files plazas,
 *    fountains and village greens as nature reserves too), that Overture is sure of (0.9) and that
 *    has a website. Beaches and "state parks" come only from the list: Overture files some far
 *    away under local points ("South Beach Miami", "Olana State Park"), and many beaches are private.
 *
 * A destination OSM or another source already has gets the destination fact on that venue; one no
 * venue has becomes a venue from its record, as Overture's new places do. Which places are
 * destinations is OutRN's own call: the fact is an estimate (source "curated"), shown as a reason.
 */

/** One place on the curated list. */
export interface CuratedDestination {
  /** The name shown on the card. */
  name: string;
  /** Names the place's record may be filed under, most specific first (compared as name keys, see matchKey). */
  aliases: string[];
  /** Roughly where it is: the record of that name nearest this, within CURATED_MATCH_M, is the place. */
  at: LatLon;
  kind: DestinationKind;
  /** Why it is worth the trip, in a line, lower case. */
  note: string;
  /** Overture categories its record is filed under, when a namesake nearby is filed under others (a dog run). */
  categories?: string[];
}

/** How far a curated place's record may be from where the list puts it. */
export const CURATED_MATCH_M = 4_000;

/** Southern Westchester, the Bronx, upper Manhattan and the Palisades. */
export const CURATED_DESTINATIONS: readonly CuratedDestination[] = [
  { name: "Van Cortlandt Park", aliases: ["van cortlandt park"], at: { lat: 40.897, lon: -73.886 }, kind: "park", note: "woods, a lake and miles of trails in one of the city's biggest parks", categories: ["park"] },
  { name: "Pelham Bay Park", aliases: ["pelham bay park"], at: { lat: 40.865, lon: -73.807 }, kind: "park", note: "the city's largest park, with shoreline trails along the Sound", categories: ["park"] },
  { name: "Orchard Beach", aliases: ["orchard beach"], at: { lat: 40.867, lon: -73.794 }, kind: "beach", note: "a long crescent beach and promenade on Long Island Sound", categories: ["beach"] },
  { name: "Wave Hill", aliases: ["wave hill"], at: { lat: 40.898, lon: -73.912 }, kind: "garden", note: "public gardens high above the Hudson, facing the Palisades" },
  { name: "New York Botanical Garden", aliases: ["new york botanical garden"], at: { lat: 40.862, lon: -73.880 }, kind: "garden", note: "vast gardens, a glass conservatory and an old-growth forest", categories: ["garden"] },
  { name: "Bronx Zoo", aliases: ["bronx zoo"], at: { lat: 40.851, lon: -73.877 }, kind: "zoo", note: "a huge zoo: plan on a few hours", categories: ["zoo"] },
  { name: "Fort Tryon Park", aliases: ["fort tryon park"], at: { lat: 40.862, lon: -73.932 }, kind: "park", note: "hilltop gardens and Hudson views around the Cloisters", categories: ["park"] },
  { name: "The Met Cloisters", aliases: ["the met cloisters"], at: { lat: 40.865, lon: -73.932 }, kind: "estate", note: "medieval art and cloister gardens in a hilltop museum", categories: ["museum"] },
  { name: "Inwood Hill Park", aliases: ["inwood hill park"], at: { lat: 40.872, lon: -73.925 }, kind: "nature", note: "Manhattan's last natural forest, above a salt marsh", categories: ["park"] },
  { name: "State Line Lookout", aliases: ["state line lookout"], at: { lat: 40.987, lon: -73.903 }, kind: "viewpoint", note: "clifftop views up and down the Hudson from the Palisades" },
  { name: "Untermyer Gardens", aliases: ["untermyer gardens"], at: { lat: 40.966, lon: -73.890 }, kind: "garden", note: "a walled Persian garden and a temple above the Hudson" },
  { name: "Lenoir Preserve", aliases: ["lenoir preserve"], at: { lat: 40.968, lon: -73.876 }, kind: "nature", note: "woodland trails and Hudson views" },
  { name: "Tibbetts Brook Park", aliases: ["tibbetts brook park"], at: { lat: 40.915, lon: -73.874 }, kind: "park", note: "a lake, wooded trails and picnic lawns", categories: ["park"] },
  { name: "Rockefeller State Park Preserve", aliases: ["rockefeller state park preserve"], at: { lat: 41.110, lon: -73.840 }, kind: "nature", note: "carriage roads around Swan Lake, through woods and fields" },
  { name: "Kensico Dam Plaza", aliases: ["kensico dam plaza", "kensico dam"], at: { lat: 41.070, lon: -73.767 }, kind: "park", note: "a grand stone dam with a long lawn beneath it", categories: ["park", "historic_site"] },
  { name: "Croton Point Park", aliases: ["croton point park"], at: { lat: 41.187, lon: -73.894 }, kind: "waterfront", note: "a peninsula in the Hudson with river views and a beach", categories: ["park"] },
  { name: "Croton Gorge Park", aliases: ["croton gorge park"], at: { lat: 41.226, lon: -73.858 }, kind: "park", note: "the New Croton Dam's spillway, falling into the gorge" },
  { name: "Teatown Lake Reservation", aliases: ["teatown lake reservation"], at: { lat: 41.210, lon: -73.834 }, kind: "nature", note: "lakeside trails and a nature center" },
  { name: "Lyndhurst", aliases: ["lyndhurst mansion", "lyndhurst"], at: { lat: 41.055, lon: -73.866 }, kind: "estate", note: "a Gothic Revival mansion with grounds on the Hudson" },
  { name: "Kykuit", aliases: ["kykuit"], at: { lat: 41.093, lon: -73.850 }, kind: "estate", note: "the Rockefeller family estate and gardens, seen by tour" },
  { name: "Sunnyside", aliases: ["sunnyside"], at: { lat: 41.046, lon: -73.866 }, kind: "estate", note: "Washington Irving's riverside home and grounds", categories: ["museum"] },
  { name: "Greenburgh Nature Center", aliases: ["greenburgh nature center"], at: { lat: 41.026, lon: -73.810 }, kind: "nature", note: "woodland trails and live animals, good with kids" },
  { name: "Saxon Woods Park", aliases: ["saxon woods park"], at: { lat: 40.985, lon: -73.770 }, kind: "park", note: "woods and trails between White Plains and Mamaroneck", categories: ["park"] },
  { name: "Marshlands Conservancy", aliases: ["marshlands conservancy"], at: { lat: 40.955, lon: -73.705 }, kind: "nature", note: "meadow and salt-marsh trails down to Long Island Sound" },
  { name: "Playland", aliases: ["playland amusement park", "playland"], at: { lat: 40.968, lon: -73.672 }, kind: "waterfront", note: "an Art Deco amusement park with a boardwalk on the Sound", categories: ["amusement_park"] },
  { name: "Glen Island Park", aliases: ["glen island park"], at: { lat: 40.887, lon: -73.785 }, kind: "waterfront", note: "lawns and a beach on Long Island Sound", categories: ["park"] },
  { name: "Westmoreland Sanctuary", aliases: ["westmoreland sanctuary"], at: { lat: 41.190, lon: -73.710 }, kind: "nature", note: "quiet woodland trails" },
  { name: "Mianus River Gorge Preserve", aliases: ["mianus river gorge preserve"], at: { lat: 41.180, lon: -73.620 }, kind: "nature", note: "an old-growth hemlock gorge" },
  { name: "Twin Lakes County Park", aliases: ["twin lakes county park"], at: { lat: 40.940, lon: -73.800 }, kind: "nature", note: "lakes and woodland trails" },
  { name: "Graham Hills Park", aliases: ["graham hills park"], at: { lat: 41.150, lon: -73.780 }, kind: "nature", note: "wooded hills with hiking and mountain-bike trails" },
  { name: "Cranberry Lake Preserve", aliases: ["cranberry lake preserve"], at: { lat: 41.090, lon: -73.750 }, kind: "nature", note: "a quiet lake and trails past an old quarry" },
  { name: "Sprain Ridge Park", aliases: ["sprain ridge park"], at: { lat: 40.980, lon: -73.830 }, kind: "park", note: "wooded ridge trails" },
  { name: "Jay Heritage Center", aliases: ["jay heritage center"], at: { lat: 40.965, lon: -73.693 }, kind: "estate", note: "the Jay family estate and meadow by the Sound" },
];

/** The Overture categories a destination's record may be filed under: what a read for them asks for. */
export const DESTINATION_READ_CATEGORIES: ReadonlySet<string> = new Set([
  "park", "nature_reserve", "national_park", "beach", "garden", "zoo", "museum", "historic_site", "arts_and_entertainment", "amusement_park",
]);

/** A record's own words for a destination: a preserve, a sanctuary, a reservation, a nature center, an arboretum. */
const NATURE_NAME = /\b(preserve|sanctuary|reservation|nature center|arboretum|audubon|wilderness|refuge)\b/;
/** Not a place to spend an afternoon, whatever it is filed under: a ball field, a triangle, a gate, a deli. */
const NOT_THE_PLACE = /\b(field|fields|court|courts|pool|playground|parking|lot|entrance|gate|station|bridge|deli|grill|cafe|restaurant|office|offices|headquarters|maintenance|garage|rink|tennis|basketball|soccer|baseball|softball|golf|dog|marina|yacht|club|camp|camping|school|church|condo|condominium|apartments|realty|association|inc|llc|shop|store|hall|pavilion|restroom|boathouse|track|skate|triangle|cemetery|memorial|society|foundation|council|trust|catskill|catskills|adirondack|adirondacks)\b/;
/** Gated records need this much confidence that the place exists as described. */
export const DESTINATION_CONFIDENCE = 0.9;

/**
 * Across water from the mainland the search starts on: Long Island's north shore is minutes away as
 * the crow flies from New Rochelle and an hour by road. Straight-line travel cannot see the Sound.
 */
const ACROSS_THE_SOUND: Bbox = { west: -73.775, south: 40.5, east: -71.8, north: 40.905 };
const inBox = (b: Bbox, p: LatLon) => p.lon >= b.west && p.lon <= b.east && p.lat >= b.south && p.lat <= b.north;

/** Words that say what kind of place it is, not which one: "park", "preserve", "the". */
const KIND_WORDS = new Set([
  "the", "of", "at", "and", "park", "parks", "state", "county", "preserve", "reservation", "sanctuary", "conservancy", "nature", "center", "centre", "garden",
  "gardens", "botanical", "beach", "trail", "trails", "lake", "lakes", "area", "historic", "site", "estate", "mansion", "museum", "zoo", "plaza", "wildlife",
  "audubon", "woods", "forest", "arboretum", "new", "york", "ny",
]);
/** Which place a name is: its words that are not kind words ("croton point" for "Croton Point Park"). */
export function placeWords(name: string): string {
  return matchKey(name).split(" ").filter((w) => w && !KIND_WORDS.has(w)).join(" ");
}

export type DestinationSkip = "status" | "confidence" | "contact" | "category" | "name" | "across";

/** What a record not on the list must say to be a destination (see the header). */
export function destinationGate(p: OverturePlace): { kind: DestinationKind } | { skip: DestinationSkip } {
  if (p.status !== "open") return { skip: "status" };
  if ((p.confidence ?? 0) < DESTINATION_CONFIDENCE) return { skip: "confidence" };
  const key = matchKey(p.name);
  if (!(p.category === "nature_reserve" || p.category === "park" || p.category === "national_park") || !NATURE_NAME.test(key)) return { skip: "category" };
  if (!key || !mostlyLatin(p.name) || NOT_THE_PLACE.test(key) || /\d/.test(p.name) || !placeWords(p.name)) return { skip: "name" };
  if (!p.websites.some((w) => venueWebsite(w) !== null)) return { skip: "contact" };
  if (inBox(ACROSS_THE_SOUND, p)) return { skip: "across" };
  return { kind: "nature" };
}

/** The record a curated place is: of one of its names, filed as expected, nearest where the list puts it. */
export function curatedRecord(entry: CuratedDestination, places: readonly OverturePlace[]): OverturePlace | null {
  const aliases = entry.aliases.map(matchKey);
  let best: { rank: [number, number, number, number, number]; p: OverturePlace } | null = null;
  for (const p of places) {
    const metres = haversineMetres(entry.at, p);
    if (metres > CURATED_MATCH_M) continue;
    const key = matchKey(p.name);
    const alias = aliases.findIndex((a) => key === a || key.startsWith(`${a} `));
    if (alias < 0) continue;
    const exact = key === aliases[alias] ? 0 : 1;
    const filed = !entry.categories || entry.categories.includes(p.category) ? 0 : 1;
    // Nearest first, to the half kilometre: a namesake misplaced a few km off loses to the one in place.
    const rank: [number, number, number, number, number] = [exact, alias, filed, Math.round(metres / 500), -(p.confidence ?? 0)];
    if (!best || before(rank, best.rank) || (!before(best.rank, rank) && p.id < best.p.id)) best = { rank, p };
  }
  return best?.p ?? null;
}

/** Whether rank a comes before rank b, compared element by element. */
function before(a: readonly number[], b: readonly number[]): boolean {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! < b[i]!;
  return false;
}

/** The venue category a destination of each kind becomes. */
export const DESTINATION_CATEGORY: Readonly<Record<DestinationKind, Category>> = {
  nature: "park",
  park: "park",
  garden: "garden",
  beach: "waterfront",
  waterfront: "waterfront",
  viewpoint: "viewpoint",
  estate: "attraction",
  zoo: "attraction",
};

export interface Destination {
  place: OverturePlace;
  name: string;
  kind: DestinationKind;
  note: string | null;
  curated: boolean;
}

/** Same place, filed twice: within this distance and named alike ("Croton Point Park", "Croton Point Beach"). */
const SAME_DESTINATION_M = 3_000;

/**
 * The destinations among an area's places: the curated ones found, then the records that say what
 * they are, less any that is a curated one or another of them filed twice. In a stable order.
 */
export function selectDestinations(places: readonly OverturePlace[], curated: readonly CuratedDestination[] = CURATED_DESTINATIONS): { destinations: Destination[]; missing: string[]; skipped: Record<DestinationSkip | "duplicate", number> } {
  const skipped: Record<DestinationSkip | "duplicate", number> = { status: 0, confidence: 0, contact: 0, category: 0, name: 0, across: 0, duplicate: 0 };
  const missing: string[] = [];
  const out: Destination[] = [];
  const taken = new Set<string>();
  for (const entry of curated) {
    const p = curatedRecord(entry, places);
    if (!p || taken.has(p.id)) {
      missing.push(entry.name);
      continue;
    }
    taken.add(p.id);
    out.push({ place: p, name: entry.name, kind: entry.kind, note: entry.note, curated: true });
  }
  const sorted = [...places].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const p of sorted) {
    if (taken.has(p.id)) continue;
    const gate = destinationGate(p);
    if ("skip" in gate) {
      skipped[gate.skip]++;
      continue;
    }
    const words = placeWords(p.name);
    const twin = out.find((d) => haversineMetres(d.place, p) <= SAME_DESTINATION_M && sharesWords(placeWords(d.name), words));
    if (twin) {
      skipped.duplicate++;
      continue;
    }
    taken.add(p.id);
    out.push({ place: p, name: p.name.trim(), kind: gate.kind, note: null, curated: false });
  }
  return { destinations: out.sort((a, b) => (a.place.id < b.place.id ? -1 : a.place.id > b.place.id ? 1 : 0)), missing, skipped };
}

/** Whether one name's place words are all in the other's ("croton point" and "croton point nature"). */
function sharesWords(a: string, b: string): boolean {
  if (!a || !b) return false;
  const [wa, wb] = [a.split(" "), b.split(" ")];
  return wa.every((w) => wb.includes(w)) || wb.every((w) => wa.includes(w));
}

/**
 * The records selection reads: every namesake of a curated place near where the list puts it, and
 * every record that passes the gate. Selecting from only these gives the same destinations, so a
 * saved read keeps only these (a few hundred of an area's fifteen thousand places).
 */
export function recordsRead(places: readonly OverturePlace[], curated: readonly CuratedDestination[] = CURATED_DESTINATIONS): Set<string> {
  const keys = curated.map((e) => ({ at: e.at, aliases: e.aliases.map(matchKey) }));
  const out = new Set<string>();
  for (const p of places) {
    const key = matchKey(p.name);
    const namesake = keys.some((e) => e.aliases.some((a) => key === a || key.startsWith(`${a} `)) && haversineMetres(e.at, p) <= CURATED_MATCH_M);
    if (namesake || "kind" in destinationGate(p)) out.add(p.id);
  }
  return out;
}

/** A read of an area's destinations: one Overture capture per tile of at most half a degree a side. */
export interface DestinationsCapture {
  outrn_capture: "overture-destinations";
  tiles: OvertureCapture[];
}

export function parseDestinationsCapture(data: unknown, what: string): DestinationsCapture {
  const d = data as { outrn_capture?: unknown; tiles?: unknown } | null;
  if (d?.outrn_capture !== "overture-destinations" || !Array.isArray(d.tiles) || d.tiles.length === 0 || d.tiles.length > 16) throw new Error(`${what} is not a destinations capture (outrn ingest destinations --save)`);
  const tiles = d.tiles.map((t, i) => parseOvertureCapture(t, `${what} tile ${i + 1}`));
  if (new Set(tiles.map((t) => t.release)).size !== 1) throw new Error(`${what} mixes Overture releases`);
  return { outrn_capture: "overture-destinations", tiles };
}

/** How far around an area destinations are read: its catchment plus the farthest a long window travels for one. */
export function destinationsExtentFor(area: { radius_m: number | null; travel_mode: "walk" | "drive" | "transit" }, parkingBufferForHour?: (h: number) => number): number {
  const reach = maxReachMetres(area.travel_mode, destinationMaxTravel(area.travel_mode, 24 * 60), parkingBufferForHour ? { parkingBufferForHour } : {});
  return Math.ceil(((area.radius_m ?? 1500) + reach) / 100) * 100;
}

/** Tiles of at most half a degree a side (an Overture read's limit) covering a circle. */
export function tilesAround(center: LatLon, radiusM: number): Bbox[] {
  const dLat = radiusM / 111_320;
  const dLon = radiusM / (111_320 * Math.cos((center.lat * Math.PI) / 180));
  const [west, south, east, north] = [center.lon - dLon, center.lat - dLat, center.lon + dLon, center.lat + dLat];
  const cols = Math.ceil((east - west) / 0.49);
  const rows = Math.ceil((north - south) / 0.49);
  const tiles: Bbox[] = [];
  const r6 = (x: number) => Math.round(x * 1e6) / 1e6;
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      tiles.push({ west: r6(west + ((east - west) * j) / cols), east: r6(west + ((east - west) * (j + 1)) / cols), south: r6(south + ((north - south) * i) / rows), north: r6(south + ((north - south) * (i + 1)) / rows) });
    }
  }
  return tiles;
}

export interface DestinationsIngestOptions {
  areaSlug: string;
  /** Replay a capture (--save) instead of reading Overture. */
  fromFile?: string;
  /** Save the read for replay: only the records selection reads (see recordsRead). */
  saveTo?: string;
  release?: string;
  clock?: () => Date;
  log?: (line: string) => void;
}

export interface DestinationsIngestSummary {
  runId: string;
  area: string;
  release: string;
  places: number;
  destinations: { curated: number; gated: number };
  /** Curated places with no record of that name where the list puts them. */
  missing: string[];
  venues: { added: number; existing: number; removed: number; possibleDuplicates: number };
  facts: { inserted: number; superseded: number; rejected: number };
}

/** Venue categories a destination can be the same place as. */
const DESTINATION_LIKE: ReadonlySet<Category> = new Set(["park", "garden", "waterfront", "viewpoint", "attraction", "museum"]);

/** A venue of another source that is this destination: named the same place, of a kind it could be, nearby. */
async function existingVenue(q: Queryable, d: Destination): Promise<string | null> {
  const r = await q.query<{ id: string; canonical_name: string; category: Category }>(
    `select id, canonical_name, category from venues
      where publish_state <> 'merged' and ST_DWithin(geom, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, 2000)
      order by ST_Distance(geom, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography), id`,
    [d.place.lon, d.place.lat],
  );
  const words = placeWords(d.name);
  const own = placeWords(d.place.name);
  return (
    r.rows.find((v) => {
      // Never on kind words alone: "The Nature Center" names no place in particular.
      const theirs = placeWords(v.canonical_name);
      return theirs !== "" && DESTINATION_LIKE.has(v.category) && (theirs === words || theirs === own);
    })?.id ?? null
  );
}

/** The venue this place's record is already linked to, if any. */
async function linkedVenue(q: Queryable, sourceEntityId: string): Promise<string | null> {
  const r = await q.query<{ venue_id: string }>(`select venue_id from entity_links where source_entity_id = $1 and superseded_by is null and decision <> 'rejected' limit 1`, [sourceEntityId]);
  return r.rows[0]?.venue_id ?? null;
}

/** Whether a venue has no source but Overture (a venue made from a record). */
async function overtureOnly(q: Queryable, venueId: string): Promise<boolean> {
  const r = await q.query<{ others: number }>(
    `select count(*)::int as others from entity_links l join source_entities s on s.id = l.source_entity_id
      where l.venue_id = $1 and l.superseded_by is null and l.decision <> 'rejected' and s.source_id <> 'overture'`,
    [venueId],
  );
  return r.rows[0]!.others === 0;
}

export async function ingestDestinations(db: Db, opts: DestinationsIngestOptions): Promise<DestinationsIngestSummary> {
  const log = opts.log ?? (() => undefined);
  const area = await getArea(db, opts.areaSlug);
  await assertSourceAllowed(db, "overture", "derive");
  await assertSourceAllowed(db, "overture", "retain");
  await assertSourceAllowed(db, "curated", "derive");
  if (!opts.fromFile) await assertSourceAllowed(db, "overture", "fetch");
  const parking = await loadParkingRule(db, area.slug);
  const center = { lat: area.lat, lon: area.lon };
  const extentM = destinationsExtentFor(area, (h) => parkingBufferAt(parking, h));

  let capture: DestinationsCapture;
  if (opts.fromFile) {
    let data: unknown;
    try {
      data = JSON.parse(await readFile(opts.fromFile, "utf8"));
    } catch (e) {
      throw new Error(`${opts.fromFile} is not a destinations capture (outrn ingest destinations --save): ${(e as Error).message}`);
    }
    capture = parseDestinationsCapture(data, opts.fromFile);
  } else {
    const tiles: OvertureCapture[] = [];
    for (const bbox of tilesAround(center, extentM)) {
      log(`reading Overture places in ${bbox.west},${bbox.south},${bbox.east},${bbox.north}`);
      const r = await fetchOverturePlaces({ bbox, categories: DESTINATION_READ_CATEGORIES, ...(opts.release ? { release: opts.release } : {}), log });
      tiles.push(parseOvertureCapture(overtureCapture(r), "the Overture read"));
    }
    capture = parseDestinationsCapture({ outrn_capture: "overture-destinations", tiles }, "the Overture read");
    if (opts.saveTo) {
      const read = recordsRead(capture.tiles.flatMap((t) => t.places));
      const saved: DestinationsCapture = { outrn_capture: "overture-destinations", tiles: capture.tiles.map((t) => ({ ...t, places: t.places.filter((x) => read.has(x.id)) })) };
      await writeFile(opts.saveTo, JSON.stringify(saved), "utf8");
    }
  }
  const release = capture.tiles[0]!.release;
  const fetchedAt = new Date(capture.tiles[0]!.fetchedAt);
  const now = opts.clock?.() ?? new Date();
  // Only what the area reaches: a capture read for a wider area replays for a smaller one.
  const places = capture.tiles.flatMap((t) => t.places).filter((p) => haversineMetres(center, p) <= extentM);
  const { destinations, missing, skipped } = selectDestinations(places);
  log(`${places.length} places within ${(extentM / 1000).toFixed(1)} km: ${destinations.filter((d) => d.curated).length} curated destinations, ${destinations.filter((d) => !d.curated).length} by their records (skipped: ${Object.entries(skipped).map(([k, n]) => `${k} ${n}`).join(", ")})`);
  if (missing.length) log(`curated, not found: ${missing.join(", ")}`);

  const runId = await startRun(db, { sourceId: "curated", areaId: area.id, kind: opts.fromFile ? "replay" : "destinations", params: { release, extent_m: extentM, from_file: opts.fromFile ?? null } });
  try {
    const summary: DestinationsIngestSummary = {
      runId,
      area: area.slug,
      release,
      places: places.length,
      destinations: { curated: destinations.filter((d) => d.curated).length, gated: destinations.filter((d) => !d.curated).length },
      missing,
      venues: { added: 0, existing: 0, removed: 0, possibleDuplicates: 0 },
      facts: { inserted: 0, superseded: 0, rejected: 0 },
    };
    await withTx(db, async (tx) => {
      const changed = new Set<string>();
      const kept = new Set<string>();
      const write = async (facts: FactInput[], venueId: string) => {
        const w = await writeFacts(tx, facts);
        summary.facts.inserted += w.inserted;
        summary.facts.superseded += w.superseded;
        summary.facts.rejected += w.rejected.length;
        for (const r of w.rejected) log(`  ${venueId}: ${r.attribute} rejected: ${r.reason}`);
        if (w.inserted || w.superseded) changed.add(venueId);
      };
      for (const d of destinations) {
        const category = DESTINATION_CATEGORY[d.kind];
        const se = await upsertPlace(tx, runId, d.place, fetchedAt);
        let venueId = await linkedVenue(tx, se.id);
        const mine = venueId !== null && (await overtureOnly(tx, venueId));
        if (!venueId) venueId = await existingVenue(tx, d);
        if (!venueId) {
          const made = await createIfNew(tx, {
            sourceEntityId: se.id,
            record: {
              name: d.name,
              category,
              point: { lat: d.place.lat, lon: d.place.lon },
              website: d.place.websites.map(venueWebsite).find((w): w is string => w !== null) ?? null,
              phone: d.place.phones.map(venuePhone).find((x): x is string => x !== null) ?? null,
              housenumber: null,
              street: null,
              brand: null,
            },
            areaId: area.id,
            timezone: area.timezone,
          });
          if ("skipped" in made) {
            // Identity says a venue nearby is this place, but not one named as it: leave both alone.
            summary.venues.possibleDuplicates++;
            log(`  left out ${d.name}: identity matched venue ${made.skipped.venueId} (score ${made.skipped.score.toFixed(2)})`);
            if (se.inserted) await tx.query(`delete from source_entities where id = $1`, [se.id]);
            continue;
          }
          venueId = made.venueId;
          summary.venues.added++;
          await write(placeFacts(venueId, { ...d.place, name: d.name }, category, runId, now), venueId);
        } else if (mine) {
          // Made from this record on an earlier run: refreshed from it.
          await write(placeFacts(venueId, { ...d.place, name: d.name }, category, runId, now), venueId);
        } else {
          summary.venues.existing++;
        }
        kept.add(venueId);
        await write(
          [
            {
              subjectKind: "venue",
              subjectId: venueId,
              attribute: "destination",
              value: d.note ? { kind: d.kind, note: d.note } : { kind: d.kind },
              evidenceClass: "estimate",
              sourceId: "curated",
              evidence: d.curated ? `curated list: ${d.name}` : `Overture ${d.place.category} "${d.place.name.trim()}" (${d.place.id})`,
              sourceUpdatedAt: null,
              fetchedAt: now,
              confidence: d.curated ? 0.7 : 0.55,
              lineageGroup: "curated",
              ingestionRunId: runId,
            },
          ],
          venueId,
        );
      }
      // Destinations an earlier run of this area named that this one does not: no longer named, and a
      // venue made from a record only for being one goes with it.
      const earlier = await tx.query<{ subject_id: string }>(
        `select distinct f.subject_id from facts f join venues v on v.id = f.subject_id
          where f.subject_kind = 'venue' and f.source_id = 'curated' and f.attribute = 'destination' and f.superseded_at is null
            and ST_DWithin(v.geom, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, $3)`,
        [center.lon, center.lat, extentM],
      );
      for (const { subject_id } of earlier.rows) {
        if (kept.has(subject_id)) continue;
        let n = await retractSourceFacts(tx, "venue", subject_id, "curated");
        if (await overtureOnly(tx, subject_id)) n += await retractSourceFacts(tx, "venue", subject_id, "overture");
        if (n) {
          summary.facts.superseded += n;
          summary.venues.removed++;
          changed.add(subject_id);
        }
      }
      await materializeSubjects(tx, "venue", [...changed], now);
    });
    await finishRun(db, runId, {
      status: "succeeded",
      counts: { places: summary.places, curated: summary.destinations.curated, gated: summary.destinations.gated, added: summary.venues.added, existing: summary.venues.existing, removed: summary.venues.removed, facts_inserted: summary.facts.inserted },
    });
    return summary;
  } catch (e) {
    await finishRun(db, runId, { status: "failed", error: (e as Error).message });
    throw e;
  }
}
