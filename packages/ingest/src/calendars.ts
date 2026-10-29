import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { haversineMetres, isDrinkTitle, matchKey, ownValue, type Interest, type LatLon } from "@outrn/core";
import { assertSourceAllowed, getArea, listAreas, loadParkingRule, type Db, type Queryable, type ServiceAreaRow } from "@outrn/db";
import { parseCalendarCapture, readCalendar, type CalendarCapture, type CalendarEvent, type CalendarFeedRef, type CalendarRead } from "@outrn/sources";
import type { RobotsPolicy } from "@outrn/sources";
import { EVENTS_FILE_MAX, ingestEvents, type EventInput, type EventsSummary } from "./events.js";
import { listedFree } from "./nyc-parks.js";
import { ingestExtentFor } from "./pipeline.js";

/**
 * Libraries', towns' and nature centers' own event calendars (`outrn ingest calendars`): storytimes,
 * concerts, book groups, nature walks, a town's parade. Each feed is one a survey of 104 calendars
 * around the launch areas found readable (robots.txt allows our agent) and useful; many are not
 * (LibraryMarket's calendars, Google Calendar's files and NYPL's site keep crawlers out), and those
 * are not here.
 *
 * A library's or a nature center's feed is all at that place: its events go to its venue. A town's
 * or the county's names a place for each event, matched by name to a venue near the town; an event
 * at an address alone, or at a place we don't have, is left out. What is not an outing is left out
 * too: meetings, closings, classes of service (tax help, computer help, ESL), anything online, and
 * an all-day entry with no time to plan by. Then the events are written by ingestEvents like any
 * other source's: title, times, link, kinds from its categories, for children when it says so,
 * registration first when it says so, and free only when it says so without condition.
 */

export interface CalendarFeed extends CalendarFeedRef {
  /** Whose calendar it is. */
  name: string;
  /** Every event is here: a library's or nature center's own calendar. Its record's names, near `at`. */
  venue?: { aliases: string[]; at: LatLon };
  /** Each event names its place: matched by name within `radiusM` of `at` (a town, the county). */
  places?: { at: LatLon; radiusM: number };
}

const libcal = (host: string, cid: number) => `https://${host}.libcal.com/ical_subscribe.php?src=p&cid=${cid}`;
const civicplus = (host: string) => `https://${host}/RSSFeed.aspx?ModID=58&CID=All-calendar.xml`;

/** Southern Westchester and Greenwich: the feeds within reach of the launch areas (survey of 18 Oct 2026). */
export const CALENDAR_FEEDS: readonly CalendarFeed[] = [
  { id: "greenburgh-library", name: "Greenburgh Public Library", format: "ical", url: libcal("greenburghlibrary", 7925), venue: { aliases: ["Greenburgh Public Library"], at: { lat: 41.0464, lon: -73.8068 } } },
  { id: "eastchester-library", name: "Eastchester Public Library", format: "ical", url: libcal("eastchesterlibrary", 19731), venue: { aliases: ["Eastchester Public Library"], at: { lat: 40.9572, lon: -73.8118 } } },
  { id: "tuckahoe-library", name: "Tuckahoe Public Library", format: "ical", url: libcal("tuckahoelibrary", 7699), venue: { aliases: ["Tuckahoe Public Library"], at: { lat: 40.9526, lon: -73.8258 } } },
  { id: "dobbs-ferry-library", name: "Dobbs Ferry Public Library", format: "ical", url: libcal("dobbsferrylibrary", 23241), venue: { aliases: ["Dobbs Ferry Public Library"], at: { lat: 41.0134, lon: -73.8769 } } },
  { id: "irvington-library", name: "Irvington Public Library", format: "ical", url: libcal("irvingtonlibrary", 19269), venue: { aliases: ["Irvington Public Library"], at: { lat: 41.0396, lon: -73.8727 } } },
  { id: "harrison-library", name: "Harrison Public Library", format: "ical", url: libcal("harrisonpl", 16067), venue: { aliases: ["Harrison Public Library"], at: { lat: 40.9709, lon: -73.7122 } } },
  { id: "mamaroneck-library", name: "Mamaroneck Public Library", format: "tec", url: "https://www.mamaronecklibrary.org/wp-json/tribe/events/v1/events", venue: { aliases: ["Mamaroneck Public Library"], at: { lat: 40.9495, lon: -73.7341 } } },
  { id: "briarcliff-library", name: "Briarcliff Manor Public Library", format: "tec", url: "https://briarcliffmanorlibrary.org/wp-json/tribe/events/v1/events", venue: { aliases: ["Briarcliff Manor Public Library"], at: { lat: 41.1465, lon: -73.8244 } } },
  { id: "sheldrake", name: "Sheldrake Environmental Center", format: "tec", url: "https://sheldrakecenter.org/wp-json/tribe/events/v1/events", venue: { aliases: ["Sheldrake Environmental Center"], at: { lat: 40.9509, lon: -73.7692 } } },
  { id: "read-sanctuary", name: "Friends of Read Wildlife Sanctuary", format: "ical", url: "https://friendsofreadwildlifesanctuary.org/events/?ical=1", venue: { aliases: ["Edith Read Wildlife Sanctuary", "Read Wildlife Sanctuary"], at: { lat: 40.9706, lon: -73.6645 } } },
  { id: "westchester-county-parks", name: "Westchester County Parks", format: "tec", url: "https://parksevents.westchestercountyny.gov/wp-json/tribe/events/v1/events", places: { at: { lat: 41.12, lon: -73.79 }, radiusM: 45_000 } },
  { id: "white-plains", name: "City of White Plains", format: "civicplus", url: civicplus("www.cityofwhiteplains.com"), places: { at: { lat: 41.034, lon: -73.763 }, radiusM: 6_000 } },
  { id: "town-of-mamaroneck", name: "Town of Mamaroneck", format: "civicplus", url: civicplus("www.townofmamaroneckny.gov"), places: { at: { lat: 40.94, lon: -73.75 }, radiusM: 5_000 } },
  { id: "greenburgh", name: "Town of Greenburgh", format: "civicplus", url: civicplus("www.greenburghny.com"), places: { at: { lat: 41.03, lon: -73.83 }, radiusM: 9_000 } },
  { id: "bronxville", name: "Village of Bronxville", format: "civicplus", url: civicplus("www.villageofbronxville.gov"), places: { at: { lat: 40.938, lon: -73.832 }, radiusM: 2_500 } },
  { id: "scarsdale", name: "Village of Scarsdale", format: "civicplus", url: civicplus("www.scarsdale.gov"), places: { at: { lat: 40.99, lon: -73.8 }, radiusM: 4_000 } },
  { id: "new-rochelle", name: "City of New Rochelle", format: "civicplus", url: civicplus("www.newrochelleny.gov"), places: { at: { lat: 40.911, lon: -73.783 }, radiusM: 6_000 } },
  { id: "hastings", name: "Village of Hastings-on-Hudson", format: "civicplus", url: civicplus("www.hohny.gov"), places: { at: { lat: 40.994, lon: -73.879 }, radiusM: 3_000 } },
  { id: "irvington", name: "Village of Irvington", format: "civicplus", url: civicplus("www.irvingtonny.gov"), places: { at: { lat: 41.039, lon: -73.868 }, radiusM: 3_000 } },
  { id: "greenwich", name: "Town of Greenwich", format: "civicplus", url: civicplus("www.greenwichct.gov"), places: { at: { lat: 41.03, lon: -73.62 }, radiusM: 10_000 } },
  { id: "rye-brook", name: "Village of Rye Brook", format: "ical", url: "https://ryebrookny.gov/events.ics", places: { at: { lat: 41.02, lon: -73.68 }, radiusM: 4_000 } },
];

/** How far ahead a run reads. */
export const CALENDAR_DAYS = 30;
/** An event's longest run (ingestEvents' own limit): a week-long fair, not a season's exhibit. */
const MAX_EVENT_DAYS = 14;
/** A feed's events are the place's when its venue is within this of where the list puts it. */
const VENUE_MATCH_M = 1_500;
/** How far from its own a library's event may be held at another place it names. */
export const OFF_SITE_M = 3_000;

/** Not something to go out to: a meeting, a closing, a service, a class of service, anything online. */
const NOT_AN_OUTING = /\b(boards?(?! games?)|meetings?(?! room)|commission|committee|hearings?|(?:common|town|city|village|senior) council|council meeting|closed|closings?|closures?|court|work session|budget|elections?|voting|deadline|office hours|collection|pick-?up|drop-?off|recycl\w*|tax(?:es)?|filing|applications?|blood drive|vaccin\w*|flu shots?|medicare|citizenship|esl|english (?:as a (?:second|new) language|class(?:es)?)|tutoring|homework|test prep|jobs?|careers?|resumes?|interview|notary|passports?|orientation|volunteer\w*|volunteen\w*|info(?:rmation)? session|postponed|tech help|computer help|(?:safe|defensive) driving)\b/i;
const NOT_AN_OUTING_CATEGORY = /^(closings?|holidays?|language learning|computers?(?: & technology)?|college prep|business & jobs|civic engagement|meetings?|government|public meetings?)$/i;
const ONLINE = /\b(online|virtual|zoom|webinar|live-?stream(?:ed)?)\b/i;
const CANCELLED = /^\W*(?:cancell?ed|canceled)\b/i;

/** Made for children, in its title, categories or room ("Children's Program Room", "Teenburgh"). */
const FOR_KIDS = /\b(story ?times?|toddlers?|bab(?:y|ies)|infants?|preschool(?:ers)?|pre-?k|kids?|children'?s?|tweens?|teens?|teenburgh|lego|homeschool(?:ers)?|young readers?|grades? [k\d]|family|families)\b/i;

/** A category's words as interests ("Concerts & Music", "Nature & Outdoor Programs"). */
const KIND_WORDS: readonly [RegExp, Interest][] = [
  [/\b(concerts?|music|musical|jazz)\b/i, "live_music"],
  [/\b(movies?|films?|cinema)\b/i, "film"],
  [/\b(arts?|crafts?|painting|drawing|exhibits?|exhibitions?)\b/i, "art"],
  [/\b(books?|authors?|writing|writers?|poetry|literary)\b/i, "books"],
  [/\b(games?|gaming|chess|trivia|puzzles?)\b/i, "games"],
  [/\b(history|historical|heritage|museums?)\b/i, "museums"],
  [/\b(nature|outdoors?|hikes?|hiking|birds?|birding|gardens?|gardening|wildlife|trails?)\b/i, "outdoors"],
  [/\b(theat(?:re|er)|dance|performances?)\b/i, "theatre"],
  [/\b(comedy|stand-?up|improv)\b/i, "comedy"],
  [/\b(festivals?|parades?|celebrations?)\b/i, "festivals"],
  [/\b(fitness|yoga|tai chi|exercise|sports?)\b/i, "sports"],
  [/\b(cooking|baking|tastings?)\b/i, "food"],
  [/\b(markets?)\b/i, "markets"],
];

const REGISTER_NOT_NEEDED = /\b(no registration|registration is not required|drop[- ]in)\b/i;
const REGISTER = /\b(registration (?:is )?(?:required|requested|needed|necessary)|please register|register (?:online|in advance|below|here|to attend)|rsvp|sign[- ]?up (?:is )?required|tickets? (?:are )?required|space is limited)\b/i;

/** A calendar's tag for how to attend, ahead of the title ("[IN-PERSON] Book Club", "[HYBRID] Talk"): says nothing on a card that only lists what you can go to. */
const IN_PERSON_TAG = /^\s*[[(]\s*(?:in[- ]?person|hybrid|on[- ]?site)\s*[\])]\s*[:\-–]?\s*/i;

/** Characters ingestEvents refuses in text: controls, and marks that change reading direction. */
const UNSAFE = /[\u0000-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/g;

function clip(s: string, max: number): string {
  const t = s.replace(UNSAFE, " ").replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), max / 2)).trimEnd()}…`;
}

/** A cost that is "Free" and nothing more ("Free admission", "Free event!", "Free and open to the public"). */
const JUST_FREE = /^\s*free(?:\s+(?:admission|entry|event|program|of charge))?(?:\s+(?:and|&)\s+open to (?:the public|all|everyone))?\s*[.!]?\s*$/i;

/**
 * "$5", "$10 - $15", "Free"; anything else says nothing. A "free" with anything more ("Free for
 * members", "Free with paid admission", "Free for kids; $15 adults") is free for some, not for
 * whoever is going: unknown. Every amount named is the range ("$10 members / $15 non-members").
 */
function statedPrice(cost: string): EventInput["price"] | undefined {
  if (/(?<![\w-])free\b(?!-)/i.test(cost)) return JUST_FREE.test(cost) ? { free: true } : undefined;
  const amounts = [...cost.matchAll(/\$\s?(\d{1,4}(?:\.\d{1,2})?)/g)].map((m) => Number(m[1]));
  if (!amounts.length) return undefined;
  const min = Math.min(...amounts);
  const max = Math.max(...amounts);
  return max > min ? { min, max, currency: "USD" } : { min, currency: "USD" };
}

export type CalendarSkip = "over" | "later" | "all_day" | "long" | "online" | "not_an_outing" | "no_place" | "elsewhere" | "duplicate";

/** One event as the events file has it, all but its place; or why it is left out. */
export function calendarEventInput(feed: Pick<CalendarFeed, "id" | "venue">, e: CalendarEvent, now: Date, until: Date): Omit<EventInput, "place"> | { skip: CalendarSkip } {
  const start = new Date(e.start);
  const end = e.end ? new Date(e.end) : null;
  if (Number.isNaN(start.getTime())) return { skip: "no_place" };
  if ((end ?? new Date(start.getTime() + 2 * 3_600_000)) < now) return { skip: "over" };
  if (start > until) return { skip: "later" };
  if (e.allDay) return { skip: "all_day" };
  if (end && end.getTime() - start.getTime() > MAX_EVENT_DAYS * 86_400_000) return { skip: "long" };
  if (ONLINE.test(e.title) || e.location.some((l) => ONLINE.test(l))) return { skip: "online" };
  const title = clip(e.title.replace(IN_PERSON_TAG, ""), 200);
  if (!title) return { skip: "not_an_outing" };
  if (NOT_AN_OUTING.test(title) || e.categories.some((c) => NOT_AN_OUTING_CATEGORY.test(c.trim()))) return { skip: "not_an_outing" };
  const about = [...e.categories, ...(feed.venue ? e.location : [])].join(" · ");
  const kinds = [...new Set(KIND_WORDS.filter(([re]) => re.test(e.categories.join(" · "))).map(([, k]) => k))].slice(0, 4);
  // An age it states counts only as a limit (18+, 21+). "All ages" or a child's range ("7-9") is who
  // it is typically for (schema.org's typicalAgeRange), not who the door admits: it never lifts its
  // venue's age rules (a bar's probable 21+, a club's stated one) for a party with a child.
  const minAge = e.minAge !== undefined && e.minAge >= 18 ? e.minAge : undefined;
  // A drink event is not for children, whatever its calendar files it under ("Family Beer Garden"),
  // nor one that states it admits only adults.
  const forKids = (FOR_KIDS.test(title) || FOR_KIDS.test(about)) && !isDrinkTitle(title) && !(minAge !== undefined && minAge >= 18);
  const words = `${title}. ${e.text}`;
  const admission = REGISTER_NOT_NEEDED.test(words) ? "walk_in" : REGISTER.test(words) ? "reservation" : undefined;
  // A feed's own cost field decides; only without one is its description read for "free".
  const price = e.cost?.trim() ? statedPrice(e.cost) : listedFree(words) ? { free: true as const } : undefined;
  const url = e.url && /^https:\/\//i.test(e.url) && e.url.length <= 2000 ? e.url : undefined;
  return {
    id: `${feed.id}/${createHash("sha256").update(`${e.uid}|${e.start}`).digest("hex").slice(0, 20)}`,
    title,
    start: start.toISOString(),
    end: end && end > start ? end.toISOString() : null,
    ...(e.cancelled || CANCELLED.test(title) ? { status: "cancelled" as const } : {}),
    ...(url ? { url } : {}),
    ...(kinds.length ? { kinds } : {}),
    ...(forKids ? { forKids: true as const } : {}),
    ...(minAge !== undefined ? { minAge } : {}),
    ...(admission ? { admission } : {}),
    ...(price ? { price } : {}),
  };
}

export interface Placed {
  venueId: string;
  area: string;
}

/** Words that name what kind of place, not which one: "Town Hall" or "Community Room" alone is no place. */
const GENERIC_WORDS = new Set(["the", "of", "and", "at", "on", "in", "town", "village", "city", "county", "hall", "room", "center", "centre", "community", "park", "library", "public", "main", "street", "avenue", "road", "school", "church", "building", "house", "field", "auditorium", "lobby", "gym", "theater", "theatre", "garden", "gardens", "north", "south", "east", "west", "new", "old"]);
const tokensOf = (key: string) => new Set(key.split(" ").filter((t) => t.length > 1));
const isSubset = (a: Set<string>, b: Set<string>) => [...a].every((t) => b.has(t));
/** Says which place, not only what kind: two words or more, one of them not a kind word. */
const distinctive = (t: Set<string>) => t.size >= 2 && [...t].some((w) => !GENERIC_WORDS.has(w));

const NEAR = `ST_DWithin(v.geom, ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography, $4)`;
const NEAREST = `order by ST_Distance(v.geom, ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography)`;
const VENUES = `select v.id, a.slug as area, v.name_key, v.category from venues v join service_areas a on a.id = v.area_id where v.publish_state <> 'merged' and v.category <> 'event_site' and ${NEAR}`;

/**
 * The venue a name means, nearest `at` within `radiusM`, and its area: the same name, or one whose
 * words hold the other's ("Lenoir Preserve" for "Westchester Lenoir Preserve", "Edith Read Wildlife
 * Sanctuary" for "Edith G. Read Wildlife Sanctuary"). Only a name that says which place: "Gazebo"
 * or "Town Hall" is not one.
 */
async function venueNamed(q: Queryable, names: string[], at: LatLon, radiusM: number): Promise<Placed | null> {
  for (const name of names) {
    const key = matchKey(name);
    const want = tokensOf(key);
    if (!distinctive(want)) continue;
    const exact = await q.query<{ id: string; area: string }>(`${VENUES} and v.name_key = $1 ${NEAREST} limit 1`, [key, at.lon, at.lat, radiusM]);
    if (exact.rows[0]) return { venueId: exact.rows[0].id, area: exact.rows[0].area };
    const longest = [...want].filter((w) => !GENERIC_WORDS.has(w)).sort((a, b) => b.length - a.length)[0]!;
    const near = await q.query<{ id: string; area: string; name_key: string }>(`${VENUES} and v.name_key like $1 ${NEAREST} limit 50`, [`%${longest}%`, at.lon, at.lat, radiusM]);
    for (const v of near.rows) {
      const have = tokensOf(v.name_key);
      const [small, big] = have.size <= want.size ? [have, want] : [want, have];
      if (distinctive(small) && isSubset(small, big)) return { venueId: v.id, area: v.area };
    }
  }
  return null;
}

const STREET_WORDS: Readonly<Record<string, string>> = { ave: "avenue", av: "avenue", st: "street", rd: "road", blvd: "boulevard", dr: "drive", pl: "place", ln: "lane", pkwy: "parkway", hwy: "highway", ter: "terrace", ct: "court", sq: "square", cir: "circle" };
/** "299 Greenwich Ave." → { number: "299", street: "greenwich avenue" }. */
function addressOf(line: string): { number: string; street: string } | null {
  const m = /^(\d{1,6}[a-z]?)\s+([A-Za-z0-9 .'-]{3,80})$/i.exec(line.split(",")[0]!.trim());
  if (!m) return null;
  const street = m[2]!.toLowerCase().replace(/\./g, "").split(/\s+/).map((w) => ownValue(STREET_WORDS, w) ?? w).join(" ").trim();
  return street ? { number: m[1]!.toLowerCase(), street } : null;
}
/** Kinds of place that hold events, preferred when an address holds more than one venue. */
const HOSTS = new Set(["library", "community", "arts_centre", "museum", "theatre", "live_music", "gallery", "park", "garden", "attraction"]);

/** The one venue at an address (as its OSM record gives it) near `at`, or the one place for events there. */
async function venueAt(q: Queryable, line: string, at: LatLon, radiusM: number): Promise<Placed | null> {
  const a = addressOf(line);
  if (!a) return null;
  const r = await q.query<{ id: string; area: string; category: string }>(
    `select distinct on (v.id) v.id, a.slug as area, v.category from venues v join service_areas a on a.id = v.area_id
       join entity_links l on l.venue_id = v.id and l.superseded_by is null and l.decision <> 'rejected'
       join source_entities s on s.id = l.source_entity_id and s.deleted_at is null and s.source_id = 'osm'
      where v.publish_state <> 'merged' and v.category <> 'event_site' and ${NEAR}
        and lower(s.raw->'tags'->>'addr:housenumber') = $1 and regexp_replace(lower(s.raw->'tags'->>'addr:street'), '\\.', '', 'g') = $5`,
    [a.number, at.lon, at.lat, radiusM, a.street],
  );
  const hosts = r.rows.filter((v) => HOSTS.has(v.category));
  const one = r.rows.length === 1 ? r.rows[0]! : hosts.length === 1 ? hosts[0]! : null;
  return one ? { venueId: one.id, area: one.area } : null;
}

/** A place line that could be a name: not an address ("255 Main Street"), a town line ("White Plains, NY 10601"), or a room. */
function placeLines(lines: string[]): string[] {
  return lines.filter((l) => !/^\d/.test(l) && !/\b[A-Z]{2}\s+\d{5}\b/.test(l) && !/\b(room|floor|suite|lobby|chambers)\b/i.test(l)).slice(0, 3);
}

/**
 * Whether an event's lines name a place of its own, apart from its venue: a name that says which
 * place (not a room or a floor), then a street or a town ("Bruce Museum | 1 Museum Drive | Greenwich"),
 * that is none of the venue's own names. A room or an exhibit in the venue gives no address
 * ("Rashkoff Room", "Inside Art"), and an address alone may be the venue's own.
 */
export function namesAnotherPlace(given: readonly string[], venueNames: readonly string[]): boolean {
  const lines = locationLines(given);
  const name = lines[0];
  // Then a street (a number), or a town and more ("Tarrytown, NY").
  const rest = lines.slice(1, 4);
  if (!name || !placeLines([name]).length || !(rest.some((l) => /\d/.test(l)) || rest.length >= 2)) return false;
  if (!distinctive(tokensOf(matchKey(name)))) return false;
  const which = (s: string) => new Set([...tokensOf(matchKey(s))].filter((w) => !GENERIC_WORDS.has(w)));
  const named = which(name);
  // The venue by a shorter name ("At the Society" for the Society of Illustrators), or by a longer one
  // that only says what kind of place it is ("Lyndhurst Mansion"); not another place that shares a
  // word of its name ("Greenwich Historical Society" is not the Greenwich Library).
  return !venueNames.some((v) => {
    const own = which(v);
    return own.size > 0 && (isSubset(named, own) || (isSubset(own, named) && [...named].every((w) => own.has(w) || PLACE_KINDS.has(w))));
  });
}

/** Words that say what kind of place a name is, beyond GENERIC_WORDS: "Lyndhurst Mansion" is Lyndhurst. */
const PLACE_KINDS = new Set(["mansion", "museum", "gallery", "playhouse", "estate", "campus", "stage", "arena", "amphitheater", "amphitheatre", "pavilion", "ballroom", "club", "cafe", "inn", "hotel", "farm", "preserve", "arts", "art"]);

/**
 * An event's location, a line for each part: a feed may give the place, its street and its town in one
 * string ("Bruce Museum, 1 Museum Drive, Greenwich", as a page's JSON-LD often does) or a line each.
 */
function locationLines(lines: readonly string[]): string[] {
  return lines.flatMap((l) => l.split(/[,\n]/)).map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 6);
}

/** Where an event is, by the place its lines name or, failing that, the address they give. */
export async function placeOf(q: Queryable, given: string[], at: LatLon, radiusM: number, memo: Map<string, Placed | null>): Promise<Placed | null> {
  // A place's name heads its line ("Bruce Museum, 1 Museum Drive"); the town after it names no place.
  for (const line of placeLines(given.map((l) => l.split(/[,\n]/)[0]!.replace(/\s+/g, " ").trim()).filter(Boolean))) {
    const key = `name:${matchKey(line)}`;
    if (!memo.has(key)) memo.set(key, await venueNamed(q, [line], at, radiusM));
    if (memo.get(key)) return memo.get(key)!;
  }
  for (const line of locationLines(given).slice(0, 3)) {
    if (!/^\d/.test(line)) continue;
    const key = `address:${line.toLowerCase()}`;
    if (!memo.has(key)) memo.set(key, await venueAt(q, line, at, radiusM));
    if (memo.get(key)) return memo.get(key)!;
  }
  return null;
}

export interface CalendarsIngestOptions {
  /** Only this area's events (default: every area). */
  areaSlug?: string;
  /** Replay a saved read (`--save`) instead of reading the feeds. */
  fromFile?: string;
  /** Save what each feed gave, for replay. */
  saveTo?: string;
  now?: Date;
  days?: number;
  /** The feeds (default: CALENDAR_FEEDS). */
  feeds?: readonly CalendarFeed[];
  /** For tests: what reads a feed (default: readCalendar). */
  read?: typeof readCalendar;
  log?: (line: string) => void;
}

export interface CalendarsIngestSummary {
  reads: { feed: string; status: CalendarRead["status"]; events: number; error?: string }[];
  skipped: Record<CalendarSkip, number>;
  areas: EventsSummary[];
}

interface AreaScope {
  area: ServiceAreaRow;
  center: LatLon;
  radiusM: number;
}

/** Whether a feed's events could land in an area: its place, or its town's, reaches into the area. */
function feedReaches(feed: CalendarFeed, s: AreaScope): boolean {
  const at = feed.venue?.at ?? feed.places!.at;
  return haversineMetres(at, s.center) <= s.radiusM + (feed.places?.radiusM ?? VENUE_MATCH_M);
}

export async function ingestCalendars(db: Db, opts: CalendarsIngestOptions = {}): Promise<CalendarsIngestSummary> {
  const log = opts.log ?? (() => undefined);
  await assertSourceAllowed(db, "calendars", "derive");
  if (!opts.fromFile) await assertSourceAllowed(db, "calendars", "fetch");
  const now = opts.now ?? new Date();
  const until = new Date(now.getTime() + (opts.days ?? CALENDAR_DAYS) * 86_400_000);
  const areas = opts.areaSlug ? [await getArea(db, opts.areaSlug)] : await listAreas(db);
  const scopes: AreaScope[] = [];
  for (const area of areas) scopes.push({ area, center: { lat: Number(area.lat), lon: Number(area.lon) }, radiusM: ingestExtentFor(area, await loadParkingRule(db, area.slug)).radiusM });
  const feeds = (opts.feeds ?? CALENDAR_FEEDS).filter((f) => scopes.some((s) => feedReaches(f, s)));
  const byId = new Map(feeds.map((f) => [f.id, f]));
  const timeZone = areas[0]?.timezone ?? "America/New_York";

  let capture: CalendarCapture;
  if (opts.fromFile) {
    let data: unknown;
    try {
      data = JSON.parse(await readFile(opts.fromFile, "utf8"));
    } catch (e) {
      throw new Error(`${opts.fromFile} is not a calendars capture (outrn ingest calendars --save): ${(e as Error).message}`);
    }
    capture = parseCalendarCapture(data, opts.fromFile);
  } else {
    const robots = new Map<string, RobotsPolicy>();
    const read = opts.read ?? readCalendar;
    const reads: CalendarRead[] = [];
    // Four feeds at a time; each host keeps its own pace (and CivicPlus towns one between them).
    const queue = [...feeds];
    await Promise.all(
      Array.from({ length: Math.min(4, queue.length) }, async () => {
        for (let f = queue.shift(); f; f = queue.shift()) {
          const r = await read(f, { timeZone, from: now, until, robots });
          log(`  ${f.name}: ${r.status === "ok" ? `${r.events.length} events${r.pages > 1 ? ` (${r.pages} pages)` : ""}` : `${r.status}${r.error ? `: ${r.error}` : ""}`}`);
          reads.push(r);
        }
      }),
    );
    reads.sort((a, b) => (a.feed < b.feed ? -1 : a.feed > b.feed ? 1 : 0));
    capture = { outrn_capture: "calendars", fetchedAt: now.toISOString(), reads };
    if (opts.saveTo) await writeFile(opts.saveTo, JSON.stringify(capture), "utf8");
  }

  const summary: CalendarsIngestSummary = { reads: [], skipped: { over: 0, later: 0, all_day: 0, long: 0, online: 0, not_an_outing: 0, no_place: 0, elsewhere: 0, duplicate: 0 }, areas: [] };
  const byArea = new Map<string, EventInput[]>();
  const seen = new Set<string>();
  const ok = new Set<string>();
  for (const r of capture.reads) {
    summary.reads.push({ feed: r.feed, status: r.status, events: r.events.length, ...(r.error ? { error: r.error } : {}) });
    const feed = byId.get(r.feed);
    if (!feed || r.status !== "ok") continue;
    // Its events are kept either way; only a read of the whole feed may say one is gone.
    if (r.complete === true) ok.add(feed.id);
    else log(`  ${feed.name}: not read to its end (${r.incomplete ?? "unknown"}); none of its events are withdrawn`);
    const own = feed.venue ? await venueNamed(db, feed.venue.aliases, feed.venue.at, VENUE_MATCH_M) : null;
    if (feed.venue && !own) log(`  ${feed.name}: no venue named ${feed.venue.aliases.join(" or ")} near where it is; its events are left out`);
    const memo = new Map<string, Placed | null>();
    for (const e of r.events) {
      const input = calendarEventInput(feed, e, now, until);
      if ("skip" in input) {
        summary.skipped[input.skip]++;
        continue;
      }
      // A town's event is where it says; a library's is at the library unless it names another
      // place we know nearby (an open mic at a restaurant), and left out when it names one we don't,
      // or one a loose match of names takes for the library itself (another branch of it).
      const placed = feed.places ? await placeOf(db, e.location, feed.places.at, feed.places.radiusM, memo) : own && (await placeOf(db, e.location, feed.venue!.at, OFF_SITE_M, memo));
      if (own && (!placed || placed.venueId === own.venueId) && namesAnotherPlace(e.location, feed.venue!.aliases)) {
        summary.skipped.elsewhere++;
        continue;
      }
      const place = feed.places ? placed : own && (placed ?? own);
      if (!place || !scopes.some((s) => s.area.slug === place!.area)) {
        summary.skipped.no_place++;
        continue;
      }
      // The same event in two calendars (the library's and the town's) is one event.
      const twin = `${place.venueId}|${matchKey(input.title)}|${input.start}`;
      if (seen.has(twin)) {
        summary.skipped.duplicate++;
        continue;
      }
      seen.add(twin);
      const list = byArea.get(place.area) ?? [];
      list.push({ ...input, place: { venue: place.venueId } });
      byArea.set(place.area, list);
    }
  }
  for (const s of scopes) {
    // The read is the area's whole listing when every feed that reaches it was read to its end: then
    // an event it no longer has is withdrawn (see ingestEvents). A feed that failed, or was read only
    // in part, says nothing of the events it did not give.
    const reaching = feeds.filter((f) => feedReaches(f, s));
    let complete = reaching.length > 0 && reaching.every((f) => ok.has(f.id));
    let events = byArea.get(s.area.slug) ?? [];
    // One file holds at most EVENTS_FILE_MAX: the soonest, and then the listing is not the whole of it.
    if (events.length > EVENTS_FILE_MAX) {
      log(`  ${s.area.slug}: ${events.length} events; the ${EVENTS_FILE_MAX} soonest are written and nothing is withdrawn`);
      events = [...events].sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0)).slice(0, EVENTS_FILE_MAX);
      complete = false;
    }
    if (!events.length && !complete) continue;
    summary.areas.push(await ingestEvents(db, { source: "calendars", events }, { areaSlug: s.area.slug, now, actor: "calendars", complete }));
  }
  return summary;
}
