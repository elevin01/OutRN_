import { writeFile } from "node:fs/promises";
import { contentHash, haversineMetres, isPublicWebHost, matchKey, ownValue, type Category, type FactInput } from "@outrn/core";
import { assertSourceAllowed, getArea, withTx, type Db, type Queryable } from "@outrn/db";
import { materializeSubjects, retractSourceFacts, retractSourceFactsExcept, writeFacts } from "@outrn/facts";
import { createIfNew } from "@outrn/identity";
import { fetchOverturePlaces, finishRun, loadOvertureCapture, overtureCapture, parseOvertureCapture, startRun, type Bbox, type OvertureCapture, type OverturePlace } from "@outrn/sources";
import { normalizeOsm } from "./osm-normalize.js";

/**
 * Overture Maps places as a second opinion on the venues OSM gave us: whether a place is still
 * operating, and a website or phone number no other source has. And, strictly, the places OSM
 * lacks (see "New places" below).
 *
 *  - A venue matches an Overture place with the same name within 120 m, or within 40 m one whose name
 *    contains the other's (whole words, 5 characters at least) and whose category the venue's could be.
 *    A street name alone ("The Delancey") would otherwise match every "Delancey …" on its block.
 *  - Any open match: "operating", published. 0.75 when Overture's own status signal backs it,
 *    0.6 when only a confident record does (0.8+), nothing otherwise.
 *  - Closed: only when no match is open or temporarily closed, and a match closed permanently has
 *    all of: Overture's status signal (0.9+), with its own date; the venue's name, within 60 m; a kind the venue's could
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
 *
 * New places. A place no venue matched becomes a venue of its own only when all of these hold: it
 * is open; its record is confident (0.8+), updated in the last two years, and not from a company
 * register alone; its Overture category is one of the fast-changing kinds we map (restaurants,
 * cafés, bars, galleries, music venues, clubs, arcades, farmers markets; not fast food, which waits
 * on the founder's call); its name is a name (not generic words, an address, a street, a company, a
 * shop, and mostly in Latin script) and not a chain's; it has a phone or its own website, so "check first" can be done; no venue
 * within 500 m has its name, none within 100 m shares a distinctive word of it ("Hunan 3" beside
 * "Hunan III"), and none of its family (food, drink, art) stands within 10 m (the storefront's
 * earlier or later tenant); and identity resolution finds nothing nearby it could be. Anything close
 * is left out rather than risk two cards for one place. Such a venue has Overture as its only source: its name, category, status,
 * website and phone, and the estimates any venue of its kind gets (walk-in for a café, free for a
 * park). No hours, so it is always Check first. It is refreshed on each run, and when a later read
 * no longer has it (or it no longer qualifies, or a venue from another source now matches its
 * place), its claims are retracted and it stops being shown.
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

/** Numbers read the same however they are written: "Hunan III" is "Hunan 3". */
const NUMBER_WORDS: Readonly<Record<string, string>> = {
  i: "1", ii: "2", iii: "3", iv: "4", v: "5", vi: "6", vii: "7", viii: "8", ix: "9", x: "10",
  one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10",
};
/** A name key with its numbers written as digits. */
const numbered = (key: string): string => key.split(" ").map((w) => ownValue(NUMBER_WORDS, w) ?? w).join(" ");

function namesMatch(venueKeyAsWritten: string, placeKeyAsWritten: string): OvertureMatch["name"] | null {
  const venueKey = numbered(venueKeyAsWritten);
  const placeKey = numbered(placeKeyAsWritten);
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
  const accepts = ownValue(ACCEPTS, v.category) ?? ACCEPTS.other;
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

/**
 * The Overture categories a place OSM lacks may become, one of ours each: the kinds that open and
 * close faster than mappers keep up with. Parks, museums, libraries, theatres and cinemas are left
 * out: OSM maps them well, and Overture's extras of those kinds are mostly not places to visit (an
 * office filed as a library). So are categories that say too little (a "specialty_store", a
 * "historic_site" plaque, a bodega filed as "food_and_beverage_store"), and fast food: counter
 * service waits on the founder's call.
 */
const NEW_PLACE_CATEGORY: Readonly<Record<string, Category>> = {
  restaurant: "restaurant", casual_eatery: "restaurant", cafe: "cafe", coffee_shop: "cafe", bar: "bar", lounge: "bar",
  art_gallery: "gallery", music_venue: "live_music", dance_club: "nightclub", arcade: "arcade", farmers_market: "market",
};
/** A record last updated this long before the read is not news about a place that is open now. */
const NEW_PLACE_MAX_AGE_DAYS = 730;
/** A new place's record must be at least this sure it exists as described. */
export const NEW_PLACE_CONFIDENCE = 0.8;
/** A name that is an address ("142 Sullivan St") is a listing, not a name to put on a card. */
const ADDRESS_NAME = /^\d+[a-z]?(\s+\S+)*\s+(st|street|ave|avenue|av|rd|road|pl|place|blvd|boulevard|dr|drive|ln|lane|sq|square|broadway|bowery)\.?$/i;

export type NewPlaceSkip = "status" | "confidence" | "register" | "category" | "name" | "chain" | "stale" | "contact";

/** Not somewhere to go out to, whatever Overture files it under: a grocery, a bodega, a pharmacy. */
const NOT_A_DESTINATION = /\b(grocery|groceries|grocer|grocers|bodega|convenience|minimart|mini mart|mini market|minimarket|supermarket|pharmacy|laundromat|liquor|liquors|gourmet deli|deli and grocery)\b/;
/**
 * A name mostly in another script is, in a New York read, most often a record misplaced from abroad
 * (a roti shop's "branch 2, Chaweng" is on Koh Samui). Venues here are listed under Latin names.
 */
export function mostlyLatin(name: string): boolean {
  const letters = [...name.normalize("NFKD")].filter((ch) => /\p{L}/u.test(ch));
  const latin = letters.filter((ch) => /\p{Script=Latin}/u.test(ch)).length;
  return latin >= 2 && latin / letters.length >= 0.6;
}
/** A company's registered name ("MoMoya 4 inc", on the name as written) or a bare street ("Grove st") is a listing, not a place's name. */
const COMPANY_NAME = /\b(inc|llc|corp|ltd)\.?$/i;
const STREET_ONLY = /^[a-z]+( [a-z]+)? (street|avenue|road|place|boulevard|st|ave|rd|pl|blvd)$/;
/** An artist's studio is filed as a gallery, but open by appointment if at all. */
const STUDIO_NAME = /\bstudios?\b/;
/** What a place's name says it serves, when Overture only says "restaurant". */
const DESSERT_NAME = /\b(ice cream|gelato|gelateria|creamery|frozen yogurt|froyo|desserts?|cupcakes?|cookies?|donuts?|doughnuts?|cheesecakes?|cakes?|pastry|pastries)\b/;
const CAFE_NAME = /\b(coffee|cafe|espresso|bakery|bakeshop|patisserie|boulangerie)\b/;
const KARAOKE_NAME = /\bkaraoke\b/;

/**
 * National and New York chains, as name keys: a franchise is the same everywhere, and OSM maps
 * chains well, so a place OSM lacks is worth adding when it is local. Brands OSM tags are added at run time.
 */
export const KNOWN_CHAINS: ReadonlySet<string> = new Set(
  [
    "Starbucks", "Dunkin", "Dunkin Donuts", "McDonald's", "Subway", "Chipotle", "Sweetgreen", "Pret A Manger", "Baskin-Robbins", "Häagen-Dazs",
    "Cinnabon", "Domino's", "Papa John's", "Pizza Hut", "Burger King", "Wendy's", "KFC", "Popeyes", "Taco Bell", "Panera Bread", "Shake Shack",
    "Chick-fil-A", "Five Guys", "Le Pain Quotidien", "Just Salad", "Dos Toros", "Wingstop", "Applebee's", "IHOP", "Denny's", "TGI Fridays",
    "Olive Garden", "Red Lobster", "The Cheesecake Factory", "Tim Hortons", "Krispy Kreme", "Insomnia Cookies", "Crumbl", "Jamba", "Auntie Anne's",
    "Pinkberry", "16 Handles", "Ben & Jerry's", "Carvel", "Cold Stone Creamery", "Nathan's Famous", "White Castle", "Arby's", "Sbarro", "Qdoba",
    "Potbelly", "Jersey Mike's", "Jimmy John's", "Blue Bottle Coffee", "Joe & The Juice", "Gregorys Coffee", "Bluestone Lane", "Paris Baguette",
    "Tous les Jours", "Chopt", "Playa Bowls", "7-Eleven", "Au Bon Pain", "Pie Face", "Joe Coffee",
  ].map(matchKey),
);

/** Whether a name is a chain's: the brand's name, or the brand's name and more ("Häagen-Dazs & Cinnabon"). */
export function chainName(nameKey: string, chains: ReadonlySet<string>): boolean {
  const words = nameKey.split(" ");
  // Every leading run of words: "haagen dazs and cinnabon" tries "haagen", "haagen dazs", …
  for (let n = 1; n <= words.length; n++) if (chains.has(words.slice(0, n).join(" "))) return true;
  return false;
}

/**
 * A way to check first: a phone number, or a website that is the place's own (its name in the
 * domain). A card that says "check first" with nothing to check it by is no use.
 */
export function contactable(p: OverturePlace): boolean {
  const key = matchKey(p.name);
  return p.phones.some((x) => venuePhone(x) !== null) || p.websites.some((w) => {
    const site = venueWebsite(w);
    return site !== null && domainNamesVenue(new URL(site).hostname, key);
  });
}

/** Whether an unmatched place may become a venue, and which kind (see the header). `asOf`: when the read was taken. */
export function newPlaceGate(p: OverturePlace, chains: ReadonlySet<string> = KNOWN_CHAINS, asOf: Date | null = null): { category: Category } | { skip: NewPlaceSkip } {
  if (p.status !== "open") return { skip: "status" };
  if ((p.confidence ?? 0) < NEW_PLACE_CONFIDENCE) return { skip: "confidence" };
  if (!p.datasets.some((d) => !COMPANY_REGISTERS.has(d))) return { skip: "register" };
  let category = ownValue(NEW_PLACE_CATEGORY, p.category);
  if (!category) return { skip: "category" };
  const key = matchKey(p.name);
  if (!key || !mostlyLatin(p.name) || genericName(key) || ADDRESS_NAME.test(p.name.trim()) || NOT_A_DESTINATION.test(key) || COMPANY_NAME.test(p.name.trim()) || STREET_ONLY.test(key)) return { skip: "name" };
  if (category === "gallery" && STUDIO_NAME.test(key)) return { skip: "name" };
  if (chainName(key, chains)) return { skip: "chain" };
  const updated = p.updatedAt ? Date.parse(p.updatedAt) : Number.NaN;
  if (asOf && !(updated >= asOf.getTime() - NEW_PLACE_MAX_AGE_DAYS * 86_400_000)) return { skip: "stale" };
  if (!contactable(p)) return { skip: "contact" };
  // Overture files ice cream parlors and bakeries under "restaurant"; a card would time them as a sit-down meal.
  if (category === "restaurant" && DESSERT_NAME.test(key)) category = "dessert";
  else if (category === "restaurant" && CAFE_NAME.test(key)) category = "cafe";
  // And karaoke under "music_venue": it is something to book and do, as OSM files it, not a show to see.
  if ((category === "live_music" || category === "bar") && KARAOKE_NAME.test(key)) category = "activity";
  return { category };
}

const nameWords = (name: string): string[] => numbered(matchKey(name)).split(" ").filter(Boolean);

/**
 * Whether two names this far apart could be one place: the same name within 500 m (a second
 * location or a misplaced pin, either way not a new place to add), or within 100 m a distinctive
 * word in common with the shorter name's distinctive words ("Hunan 3" and "Hunan III Restaurant").
 */
export function namesake(a: string, b: string, metres: number): boolean {
  const wa = nameWords(a);
  const wb = nameWords(b);
  if (!wa.length || !wb.length) return false;
  if (wa.join("") === wb.join("")) return metres <= 500;
  if (metres > 100) return false;
  const da = new Set(wa.filter((w) => !GENERIC_WORDS.has(w)));
  const db = new Set(wb.filter((w) => !GENERIC_WORDS.has(w)));
  if (!da.size || !db.size) return false;
  let shared = 0;
  for (const w of da) if (db.has(w)) shared++;
  return shared / Math.min(da.size, db.size) >= 0.5;
}

/** Bare OSM tags for each kind a new place can be: what the OSM rules estimate for a place known only by its kind. */
const BARE_TAGS: Readonly<Partial<Record<Category, Record<string, string>>>> = {
  restaurant: { amenity: "restaurant" }, cafe: { amenity: "cafe" }, dessert: { amenity: "ice_cream" }, bar: { amenity: "bar" }, gallery: { tourism: "gallery" },
  live_music: { amenity: "music_venue" }, nightclub: { amenity: "nightclub" }, arcade: { leisure: "amusement_arcade" }, market: { amenity: "marketplace" },
  activity: { amenity: "karaoke_box" },
};

/**
 * The estimates any venue of this kind gets from what it is (walk-in for a café, free for a park,
 * usually 21+ for a bar that names no food): the OSM rules' own, for a record with nothing but its kind.
 */
export function kindEstimates(category: Category): { attribute: FactInput["attribute"]; value: unknown; confidence: number }[] {
  const tags = ownValue(BARE_TAGS, category);
  if (!tags) return [];
  const n = normalizeOsm({ externalId: "kind", point: { lat: 0, lon: 0 }, timezone: "UTC", tags: { name: "kind", ...tags }, sourceUpdatedAt: null });
  if (n.category !== category) throw new Error(`bare tags for ${category} read as ${n.category}`);
  return n.facts.filter((f) => f.evidenceClass === "estimate").map((f) => ({ attribute: f.attribute, value: f.value, confidence: f.confidence }));
}

/** A permanently closed match that may close the venue (see the header for the rule). */
function closes(venue: Pick<MatchVenue, "category">, m: OvertureMatch): boolean {
  const p = m.place;
  return (
    // Dated by the signal itself: an undated closure would read as new on every run (its fetch time)
    // and outrank a founder's later check; another field's date says nothing about the closure.
    p.status === "permanently_closed" && (p.statusSignal ?? 0) >= SIGNAL && p.statusUpdatedAt !== null &&
    m.name === "same" && m.metres <= CLOSURE_MATCH_M &&
    (ownValue(ACCEPTS, venue.category) ?? ACCEPTS.other).has(p.category) &&
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
      claims.push({ attribute: "business_status", value: { status: "closed_permanently" }, confidence: 0.65, evidence: `Overture place ${p.id} "${p.name}": permanently closed, by Overture's operating-status signal`, sourceUpdatedAt: date(p.statusUpdatedAt) });
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
  /** Add the places OSM lacks as venues (see the header). Default true. */
  newPlaces?: boolean;
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
  /** Places OSM lacks (see the header); null when not asked for. */
  newPlaces: NewPlacesSummary | null;
}

export interface NewPlacesSummary {
  /** Venues made from places this run, venues from earlier runs still in the read, and those it no longer supports. */
  added: number;
  kept: number;
  removed: number;
  /** Near a venue it could be: left out. */
  possibleDuplicates: number;
  /** Not a place to add, by the first rule it failed. */
  skipped: Record<NewPlaceSkip, number>;
  /** A few of the added, for the log: "Gotan (cafe)". */
  examples: string[];
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

/**
 * The box a live read covers: the area's venues that another source gave us (OSM, a founder), and a
 * margin. Never the venues made from Overture's own places: one added near the edge would widen the
 * next read, which could add another at its new edge, and so on out of the area. A replay reads
 * its capture's own box instead.
 */
export function liveReadBox(venues: readonly { id: string; lat: number; lon: number }[], madeFromPlaces: ReadonlySet<string>): Bbox {
  return bboxAround(venues.filter((v) => !madeFromPlaces.has(v.id)), OVERTURE_MATCH_M + 30);
}

/** The box the next live read of an area would cover (see liveReadBox). */
export async function overtureReadBox(q: Queryable, areaSlug: string): Promise<Bbox> {
  const area = await getArea(q, areaSlug);
  const known = await overtureVenues(q);
  return liveReadBox(await areaVenues(q, area.id), new Set([...known.values()].filter((v) => v.only).map((v) => v.venueId)));
}

/** A venue made from an Overture place OSM lacked, and whether Overture is still its only source. */
interface OvertureVenue {
  venueId: string;
  sourceEntityId: string;
  placeId: string;
  areaId: string | null;
  lat: number;
  lon: number;
  only: boolean;
}

/** Venues made from Overture places, by place id. */
async function overtureVenues(q: Queryable): Promise<Map<string, OvertureVenue>> {
  const r = await q.query<{ venue_id: string; source_entity_id: string; external_id: string; area_id: string | null; lat: number; lon: number; only: boolean }>(
    `select l.venue_id, se.id as source_entity_id, se.external_id, v.area_id, ST_Y(v.geom::geometry) as lat, ST_X(v.geom::geometry) as lon,
            not exists (select 1 from entity_links l2 join source_entities s2 on s2.id = l2.source_entity_id
                         where l2.venue_id = l.venue_id and l2.superseded_by is null and l2.decision <> 'rejected' and s2.source_id <> 'overture') as only
       from entity_links l join source_entities se on se.id = l.source_entity_id join venues v on v.id = l.venue_id
      where se.source_id = 'overture' and l.superseded_by is null and l.decision <> 'rejected' and v.publish_state <> 'merged'`,
  );
  return new Map(r.rows.map((x) => [x.external_id, { venueId: x.venue_id, sourceEntityId: x.source_entity_id, placeId: x.external_id, areaId: x.area_id, lat: x.lat, lon: x.lon, only: x.only }]));
}

/** Kinds that take each other's storefronts: a bar that becomes a music venue, a café that becomes a restaurant. */
const SPOT_FAMILY: Readonly<Partial<Record<Category, string>>> = {
  restaurant: "food", cafe: "food", dessert: "food", market: "food", bar: "drink", nightclub: "drink", live_music: "drink", gallery: "art", museum: "art", arts_centre: "art",
};
const familyOf = (c: Category): string => ownValue(SPOT_FAMILY, c) ?? c;
/**
 * Within this many metres of a venue of the same family, a new place is most likely that storefront's
 * earlier or later tenant ("Milk & Honey" where Attaboy is now), or the venue itself under another
 * name. Either way not a place to add. On the Lower East Side capture, places this close to a venue
 * under another name are mostly one address geocoded twice; from about 12 m they are mostly the shop
 * next door.
 */
export const SAME_SPOT_M = 10;

/** Venues' names, kinds and points on a grid of about 500 m cells: what a new place might already be. */
class NameIndex {
  private readonly cells = new Map<string, { name: string; category: Category; lat: number; lon: number }[]>();
  private static readonly CELL = 0.005;
  add(v: { name: string; category: Category; lat: number; lon: number }): void {
    const k = `${Math.floor(v.lat / NameIndex.CELL)}:${Math.floor(v.lon / NameIndex.CELL)}`;
    const list = this.cells.get(k) ?? [];
    list.push(v);
    this.cells.set(k, list);
  }
  /** Whether a venue could be this place: a namesake (see namesake), or one of its family on the same spot. */
  couldBe(p: { name: string; lat: number; lon: number }, category: Category): boolean {
    const i = Math.floor(p.lat / NameIndex.CELL);
    const j = Math.floor(p.lon / NameIndex.CELL);
    const family = familyOf(category);
    for (let di = -1; di <= 1; di++) {
      for (let dj = -1; dj <= 1; dj++) {
        for (const v of this.cells.get(`${i + di}:${j + dj}`) ?? []) {
          const metres = haversineMetres(p, v);
          if (namesake(p.name, v.name, metres) || (metres <= SAME_SPOT_M && familyOf(v.category) === family)) return true;
        }
      }
    }
    return false;
  }
}

/** Every venue in the read's box and 600 m around it (any area): all a place inside could be named like. */
async function nameIndex(q: Queryable, b: Bbox): Promise<NameIndex> {
  const dLat = 600 / 111_320;
  const dLon = 600 / (111_320 * Math.cos((((b.south + b.north) / 2) * Math.PI) / 180));
  const r = await q.query<{ name: string; category: Category; lat: number; lon: number }>(
    `select canonical_name as name, category, ST_Y(geom::geometry) as lat, ST_X(geom::geometry) as lon from venues
      where publish_state <> 'merged' and ST_Intersects(geom, ST_MakeEnvelope($1, $2, $3, $4, 4326)::geography)`,
    [b.west - dLon, b.south - dLat, b.east + dLon, b.north + dLat],
  );
  const index = new NameIndex();
  for (const v of r.rows) index.add(v);
  return index;
}

/** Chains: the known ones and every brand OSM tags anywhere we have ingested. */
async function chainNames(q: Queryable): Promise<Set<string>> {
  const r = await q.query<{ brand: string }>(`select distinct raw->'tags'->>'brand' as brand from source_entities where source_id = 'osm' and raw->'tags'->>'brand' is not null`);
  const out = new Set(KNOWN_CHAINS);
  for (const { brand } of r.rows) {
    const k = matchKey(brand);
    // A one-word brand shorter than 4 letters ("Joe") would take every name that starts with it.
    if (k.length >= 4 || k.includes(" ")) out.add(k);
  }
  return out;
}

/** The place as a source record (source_entities), for identity links: its id, and whether it is new. */
async function upsertPlace(q: Queryable, runId: string, p: OverturePlace, fetchedAt: Date): Promise<{ id: string; inserted: boolean }> {
  const r = await q.query<{ id: string; inserted: boolean }>(
    `insert into source_entities (source_id, external_id, kind, raw, content_hash, geom, first_seen_run_id, last_seen_run_id, source_updated_at, fetched_at)
     values ('overture', $1, 'venue', $2, $3, ST_SetSRID(ST_MakePoint($4, $5), 4326)::geography, $6, $6, $7, $8)
     on conflict (source_id, external_id) do update set raw = excluded.raw, content_hash = excluded.content_hash, geom = excluded.geom,
            last_seen_run_id = excluded.last_seen_run_id, source_updated_at = excluded.source_updated_at, fetched_at = excluded.fetched_at, deleted_at = null
     returning id, (xmax = 0) as inserted`,
    [p.id, JSON.stringify(p), contentHash(p), p.lon, p.lat, runId, date(p.updatedAt), fetchedAt],
  );
  return r.rows[0]!;
}

/** What a place says about the venue made from it: name, kind, status, contact details, and the estimates for its kind. */
export function placeFacts(venueId: string, p: OverturePlace, category: Category, runId: string | null, now: Date): FactInput[] {
  const claims = claimsFor({ nameKey: matchKey(p.name), category }, [{ place: p, metres: 0, name: "same" }], { website: false, phone: false });
  const base = { subjectKind: "venue", subjectId: venueId, sourceId: "overture", fetchedAt: now, lineageGroup: "overture", ingestionRunId: runId } as const;
  const updated = date(p.updatedAt);
  const stated: FactInput[] = [
    { ...base, attribute: "name", value: { value: p.name.trim() }, evidenceClass: "published", evidence: `Overture place ${p.id}: name`, sourceUpdatedAt: updated, confidence: 0.8 },
    { ...base, attribute: "category", value: { value: category }, evidenceClass: "published", evidence: `Overture place ${p.id}: ${p.category}`, sourceUpdatedAt: updated, confidence: 0.7 },
    ...claims.map((c): FactInput => ({ ...base, attribute: c.attribute, value: c.value, evidenceClass: "published", evidence: c.evidence, sourceUpdatedAt: c.sourceUpdatedAt, confidence: c.confidence })),
  ];
  // One claim per attribute: an estimate only where the place itself says nothing (never its status).
  const said = new Set(stated.map((f) => f.attribute));
  const estimates = kindEstimates(category).filter((e) => !said.has(e.attribute) && e.attribute !== "business_status");
  return [...stated, ...estimates.map((e): FactInput => ({ ...base, attribute: e.attribute, value: e.value, evidenceClass: "estimate", evidence: null, confidence: e.confidence }))];
}

/**
 * The places no venue matched, as venues of their own (see the header): new ones added, earlier
 * ones refreshed, and those the read no longer supports retracted. Returns the venues it changed.
 */
async function addNewPlaces(
  tx: Queryable,
  args: { area: { id: string; timezone: string }; capture: OvertureCapture; matched: ReadonlySet<string>; known: ReadonlyMap<string, OvertureVenue>; runId: string; now: Date; log: (line: string) => void },
): Promise<{ summary: NewPlacesSummary; changed: string[]; facts: { inserted: number; superseded: number; rejected: number } }> {
  const { area, capture, matched, known, runId, now, log } = args;
  const summary: NewPlacesSummary = { added: 0, kept: 0, removed: 0, possibleDuplicates: 0, skipped: { status: 0, confidence: 0, register: 0, category: 0, name: 0, chain: 0, stale: 0, contact: 0 }, examples: [] };
  const facts = { inserted: 0, superseded: 0, rejected: 0 };
  const changed: string[] = [];
  const refreshed = new Set<string>();
  const index = await nameIndex(tx, capture.bbox);
  const chains = await chainNames(tx);
  const write = async (venueId: string, p: OverturePlace, category: Category) => {
    const f = placeFacts(venueId, p, category, runId, now);
    const w = await writeFacts(tx, f);
    const retracted = await retractSourceFactsExcept(tx, "venue", venueId, "overture", f.map((x) => x.attribute));
    facts.inserted += w.inserted;
    facts.superseded += w.superseded + retracted;
    facts.rejected += w.rejected.length;
    for (const r of w.rejected) log(`  ${venueId}: ${r.attribute} rejected: ${r.reason}`);
    if (w.inserted || w.superseded || retracted) changed.push(venueId);
  };
  // In id order, so which of two near places is added first is the same on every run.
  for (const p of [...capture.places].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    // A venue from another source has this place: it speaks for that venue, not for a new one.
    if (matched.has(p.id)) continue;
    const gate = newPlaceGate(p, chains, new Date(capture.fetchedAt));
    const mine = known.get(p.id);
    if (mine) {
      // Made from this place on an earlier run (in any area): refreshed while it still qualifies.
      if (mine.only && "category" in gate) {
        await upsertPlace(tx, runId, p, now);
        await write(mine.venueId, p, gate.category);
        refreshed.add(p.id);
        summary.kept++;
      }
      continue;
    }
    if ("skip" in gate) {
      summary.skipped[gate.skip]++;
      continue;
    }
    if (index.couldBe(p, gate.category)) {
      summary.possibleDuplicates++;
      continue;
    }
    const se = await upsertPlace(tx, runId, p, now);
    const made = await createIfNew(tx, {
      sourceEntityId: se.id,
      record: {
        name: p.name.trim(),
        category: gate.category,
        point: { lat: p.lat, lon: p.lon },
        website: p.websites.map(venueWebsite).find((w): w is string => w !== null) ?? null,
        phone: p.phones.map(venuePhone).find((x): x is string => x !== null) ?? null,
        housenumber: null,
        street: null,
        brand: null,
      },
      areaId: area.id,
      timezone: area.timezone,
    });
    if ("skipped" in made) {
      summary.possibleDuplicates++;
      // Nothing links to a record left out, so it is not kept.
      if (se.inserted) await tx.query(`delete from source_entities where id = $1`, [se.id]);
      continue;
    }
    await write(made.venueId, p, gate.category);
    index.add({ name: p.name, category: gate.category, lat: p.lat, lon: p.lon });
    refreshed.add(p.id);
    summary.added++;
    if (summary.examples.length < 8) summary.examples.push(`${p.name.trim()} (${gate.category})`);
  }
  // This area's venues made from places the read no longer supports: gone from Overture, no longer
  // qualifying, or now matched by a venue from another source. Only inside the read's box: a smaller
  // read says nothing about the rest.
  for (const v of known.values()) {
    if (!v.only || v.areaId !== area.id || refreshed.has(v.placeId) || !inside(capture.bbox, v, 0)) continue;
    const retracted = await retractSourceFacts(tx, "venue", v.venueId, "overture");
    await tx.query(`update source_entities set deleted_at = coalesce(deleted_at, $2) where id = $1`, [v.sourceEntityId, now]);
    if (retracted) {
      facts.superseded += retracted;
      changed.push(v.venueId);
      summary.removed++;
    }
  }
  return { summary, changed, facts };
}

export async function ingestOverture(db: Db, opts: OvertureIngestOptions): Promise<OvertureIngestSummary> {
  const log = opts.log ?? (() => undefined);
  const area = await getArea(db, opts.areaSlug);
  await assertSourceAllowed(db, "overture", "derive");
  if (!opts.fromFile) await assertSourceAllowed(db, "overture", "fetch");
  // A place added as a venue is kept as a source record (source_entities), for its identity links.
  if (opts.newPlaces !== false) await assertSourceAllowed(db, "overture", "retain");
  const venues = await areaVenues(db, area.id);
  const known = await overtureVenues(db);
  const madeFromPlaces = new Set([...known.values()].filter((v) => v.only).map((v) => v.venueId));
  if (!venues.some((v) => !madeFromPlaces.has(v.id))) throw new Error(`${area.slug} has no venues yet: ingest it from OSM first (outrn ingest osm --area ${area.slug})`);

  let capture: OvertureCapture;
  let read: OvertureIngestSummary["read"] = null;
  if (opts.fromFile) {
    capture = await loadOvertureCapture(opts.fromFile);
    if (opts.release && opts.release !== capture.release) throw new Error(`${opts.fromFile} is release ${capture.release}, not ${opts.release}`);
  } else {
    const bbox = liveReadBox(venues, madeFromPlaces);
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
    // Venues the capture covers entirely; the rest keep whatever an earlier run said. A venue made from
    // an Overture place is the new-place step's: matching it to its own place would retract its name.
    const considered = venues.filter((v) => !madeFromPlaces.has(v.id) && inside(capture.bbox, v, OVERTURE_MATCH_M));
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
      newPlaces: null,
    };
    await withTx(db, async (tx) => {
      const changed: string[] = [];
      const matchedPlaces = new Set<string>();
      for (const v of considered) {
        const matches = matchVenue({ id: v.id, nameKey: v.name_key, category: v.category, lat: v.lat, lon: v.lon }, index);
        if (matches.length) summary.venues.matched++;
        for (const m of matches) matchedPlaces.add(m.place.id);
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
      if (opts.newPlaces !== false) {
        const np = await addNewPlaces(tx, { area, capture, matched: matchedPlaces, known, runId, now, log });
        summary.newPlaces = np.summary;
        summary.facts.inserted += np.facts.inserted;
        summary.facts.superseded += np.facts.superseded;
        summary.facts.rejected += np.facts.rejected;
        changed.push(...np.changed);
      }
      const mat = await materializeSubjects(tx, "venue", changed, now);
      summary.materialized = { subjects: mat.subjects, conflicts: mat.conflicts, tasks: mat.tasksCreated };
    });
    await finishRun(db, runId, {
      status: "succeeded",
      counts: {
        places: summary.places,
        venues_considered: summary.venues.considered,
        venues_matched: summary.venues.matched,
        ...Object.fromEntries(Object.entries(summary.claims).map(([k, n]) => [`claims_${k}`, n])),
        facts_inserted: summary.facts.inserted,
        facts_superseded: summary.facts.superseded,
        ...(summary.newPlaces
          ? { new_places_added: summary.newPlaces.added, new_places_kept: summary.newPlaces.kept, new_places_removed: summary.newPlaces.removed, new_places_possible_duplicates: summary.newPlaces.possibleDuplicates }
          : {}),
      },
    });
    return summary;
  } catch (e) {
    await finishRun(db, runId, { status: "failed", error: (e as Error).message });
    throw e;
  }
}
