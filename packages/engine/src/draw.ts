import { isInterest, minutesBetween, ownValue, type Category, type Interest } from "@outrn/core";
import { subtypeOf } from "./daypart.js";
import { candidateInterests } from "./taste.js";
import type { Candidate, ReasonCode, RequestContext } from "./types.js";

/**
 * Draw: how much an option is something to go out for, 0 to 1, whoever is asking and whenever. "Open
 * and near" is not a reason to leave the house: a branch library, a pocket park and the fourth-nearest
 * café are all doable, and none of them is why anyone opens the app. What is: something happening
 * today, a place people know by name, one that just opened, a kind of place an outing is built around
 * (a museum, a market, bowling, a comedy room).
 *
 * It is a prior and a handful of signals from the records we hold, so it only ever ranks: it never
 * excludes, and nothing here is shown as a fact. What it says on a card is what the record says
 * ("here since 1938", "new on the map"), never a verdict of ours.
 */

/** How much each kind of place is an outing in itself, before anything is known of the place. */
export const KIND_DRAW: Readonly<Record<Category, number>> = {
  museum: 0.75,
  theatre: 0.7,
  live_music: 0.7,
  bowling: 0.7,
  activity: 0.7,
  cinema: 0.65,
  arcade: 0.65,
  market: 0.65,
  viewpoint: 0.6,
  waterfront: 0.6,
  nightclub: 0.55,
  gallery: 0.55,
  arts_centre: 0.55,
  restaurant: 0.5,
  bar: 0.5,
  event_site: 0.5,
  dessert: 0.45,
  bookshop: 0.45,
  park: 0.45,
  garden: 0.4,
  attraction: 0.4,
  cafe: 0.4,
  other: 0.3,
  // Useful, pleasant, and not an outing: they stay options, and stop leading.
  library: 0.25,
  community: 0.2,
};

/** Kinds within a category that say more than it does. */
const SUBTYPE_DRAW: Readonly<Record<string, number>> = {
  zoo: 0.85,
  aquarium: 0.85,
  theme_park: 0.85,
  amusement: 0.85,
  estate: 0.55,
  ice_rink: 0.75,
  escape_game: 0.75,
  comedy_club: 0.75,
  miniature_golf: 0.7,
  climbing: 0.7,
  karaoke_box: 0.65,
  arcade_bar: 0.65,
  comedy_bar: 0.65,
  cocktail_bar: 0.55,
  wine_bar: 0.55,
  brewery: 0.55,
  casino: 0.5,
};

/**
 * What an encyclopedia entry says of a place depends on its kind. A restaurant, a bar or a bookshop
 * with one is an institution (Katz's, McSorley's: two dozen of the Lower East Side's 1,500). Most
 * museums and theatres have one. Every city park, playground and branch library has one, so there it
 * says nothing, and only an article of its own says a little.
 */
const NOTABLE: Readonly<Partial<Record<Category, { id: number; article: number }>>> = {
  restaurant: { id: 0.2, article: 0.1 },
  cafe: { id: 0.2, article: 0.1 },
  dessert: { id: 0.2, article: 0.1 },
  bar: { id: 0.2, article: 0.1 },
  nightclub: { id: 0.2, article: 0.1 },
  bookshop: { id: 0.2, article: 0.1 },
  market: { id: 0.15, article: 0.1 },
  gallery: { id: 0.15, article: 0.1 },
  live_music: { id: 0.15, article: 0.1 },
  bowling: { id: 0.1, article: 0.1 },
  arcade: { id: 0.1, article: 0.1 },
  activity: { id: 0.1, article: 0.1 },
  museum: { id: 0.1, article: 0.05 },
  theatre: { id: 0.1, article: 0.05 },
  cinema: { id: 0.1, article: 0.05 },
  arts_centre: { id: 0.1, article: 0.05 },
  attraction: { id: 0.1, article: 0.1 },
  viewpoint: { id: 0.1, article: 0.05 },
  waterfront: { id: 0.1, article: 0.05 },
  park: { id: 0, article: 0.1 },
  garden: { id: 0, article: 0.1 },
};

export const DRAW = {
  /** Opened within the last year, as the place itself says. */
  newlyOpened: 0.2,
  /** First mapped within `newOnMapDays`, for a kind that opens and closes often. */
  newOnMap: 0.15,
  newOnMapDays: 240,
  newlyOpenedDays: 365,
  /** There for at least this many years, for a kind where that is rare. */
  longStanding: 0.1,
  longStandingYears: 40,
  /** A small green space named for what it is: a playground, a triangle, a sitting area. */
  pocketPark: 0.25,
  /** A playground, for a party with a child under twelve: exactly the outing. */
  playgroundWithKids: 0.6,
} as const;

/** Kinds that open and close faster than mappers keep up: a first mapping this year is probably a new place. */
const FAST_CHANGING: ReadonlySet<Category> = new Set(["restaurant", "cafe", "dessert", "bar", "nightclub", "gallery", "bookshop", "market", "arcade", "bowling", "activity", "live_music", "cinema", "theatre", "museum"]);
/** Kinds where decades in business is worth saying: the luncheonette from 1938, not a park from 1871. */
const LONG_STANDING_KINDS: ReadonlySet<Category> = new Set(["restaurant", "cafe", "dessert", "bar", "bookshop", "market", "cinema", "theatre", "live_music", "nightclub", "bowling"]);

/** A park named for something small: "Vesuvio Playground", "Cooper Triangle", "Kimlau Square". Not "Washington Square Park". */
const POCKET_PARK = /\b(?:playground|triangle|square|plaza|malls?|circle|strip|sitting area|tot lot|dog run|greenstreet|memorial)\s*$/i;
const PLAYGROUND = /\bplayground|tot lot\b/i;

/** The year and, when given, month a place says it opened: "1938", "2026-05", "2004-12-01". */
export function parseSince(since: string | null | undefined): { year: number; month: number | null } | null {
  const m = typeof since === "string" ? /^(\d{4})(?:-(\d{2}))?(?:-\d{2})?$/.exec(since.trim()) : null;
  if (!m) return null;
  const year = Number(m[1]);
  const month = m[2] ? Number(m[2]) : null;
  if (year < 1600 || year > 2200 || (month !== null && (month < 1 || month > 12))) return null;
  return { year, month };
}

export interface Draw {
  /** 0 to 1. */
  score: number;
  /** What it may say for itself on the card, when a record says it. */
  reasons: ReasonCode[];
}

function youngestUnderTwelve(ctx: Pick<RequestContext, "youngestAge" | "company">): boolean {
  return typeof ctx.youngestAge === "number" ? ctx.youngestAge < 12 : ctx.company === "family";
}

/** A place's draw: its kind, then what its records say of it. */
function placeDraw(c: Candidate, ctx: Pick<RequestContext, "now" | "youngestAge" | "company">): Draw {
  const reasons: ReasonCode[] = [];
  const subtype = subtypeOf(c);
  // What kind of destination it is says more than a broad category does (the zoo is an "attraction").
  const destination = (c.facts.destination?.value as { kind?: unknown } | undefined)?.kind;
  let score = (subtype ? ownValue(SUBTYPE_DRAW, subtype) : undefined) ?? (typeof destination === "string" ? ownValue(SUBTYPE_DRAW, destination) : undefined) ?? KIND_DRAW[c.category];
  // A chain is the same everywhere: an encyclopedia entry is its brand's, an opening date its branch's.
  if (c.category === "park" && POCKET_PARK.test(c.name) && !c.facts.destination) {
    // A playground is the outing for a small child, and nobody else's.
    score = PLAYGROUND.test(c.name) && youngestUnderTwelve(ctx) ? DRAW.playgroundWithKids : DRAW.pocketPark;
  } else if (!c.brand) {
    const n = NOTABLE[c.category];
    const bonus = n ? (c.hasLandmarkId ? n.id : 0) + (c.hasWikipedia ? n.article : 0) : 0;
    if (bonus > 0) {
      score += bonus;
      reasons.push("LANDMARK");
    }
  }
  if (!c.brand) {
    const since = parseSince(c.since);
    if (since) {
      // A year alone is its first day: "2026" is new through the end of 2026, and never before it began.
      const opened = new Date(Date.UTC(since.year, (since.month ?? 1) - 1, 1));
      const days = minutesBetween(opened, ctx.now) / 1440;
      if (days >= 0 && days <= DRAW.newlyOpenedDays && FAST_CHANGING.has(c.category)) {
        score += DRAW.newlyOpened;
        reasons.push("NEWLY_OPENED");
      } else if (ctx.now.getUTCFullYear() - since.year >= DRAW.longStandingYears && LONG_STANDING_KINDS.has(c.category)) {
        score += DRAW.longStanding;
        reasons.push("LONG_STANDING");
      }
    }
    if (!reasons.includes("NEWLY_OPENED") && c.firstMappedAt && FAST_CHANGING.has(c.category)) {
      const days = minutesBetween(c.firstMappedAt, ctx.now) / 1440;
      if (days >= 0 && days <= DRAW.newOnMapDays) {
        score += DRAW.newOnMap;
        reasons.push("NEW_ON_MAP");
      }
    }
  }
  return { score: Math.max(0, Math.min(1, score)), reasons };
}

/** How much an event of each kind is worth going out for. */
const EVENT_DRAW: Readonly<Record<Interest, number>> = {
  festivals: 0.9,
  live_music: 0.85,
  comedy: 0.85,
  theatre: 0.8,
  film: 0.75,
  markets: 0.75,
  art: 0.7,
  food: 0.7,
  drinks: 0.7,
  nightlife: 0.7,
  museums: 0.65,
  outdoors: 0.6,
  games: 0.6,
  books: 0.55,
  cafes: 0.5,
  sports: 0.45,
};
/** An event whose listing says nothing of what it is. */
const EVENT_UNKNOWN = 0.5;

/**
 * What a listing's title says an event is not: a show. A public calendar is mostly the week's
 * routine (a parks department's is fitness classes and volunteer days, a library's is clubs and help
 * desks). They are real and some people want them, so they stay options and a taste can still lift
 * them; they are not what "something is on tonight" means. Whole words, plain alternations: linear.
 * The lowest that matches decides, whatever kinds the listing gives ("Zumba" is filed under dance).
 */
const ROUTINE_EVENTS: readonly [RegExp, number][] = [
  // Not an outing: a service, a meeting, a sign-up.
  [/\b(meetings?|committee|hearing|office hours|help desk|tech help|tax (?:help|prep)|esl|esol|citizenship|resume|job search|homework help|tutoring|blood drive|vaccin\w*|flu shots?|support group|drop-?in hours|registration (?:opens|closes)|orientation|info(?:rmation)? session)\b/i, 0.15],
  // Work, kindly given: a park cleanup is a good morning, and not a night out.
  [/\b(volunteers?|volunteering|stewardship|work ?days?|clean-?ups?|restoration|beautification|(?:tree )?planting|service project|trail (?:work|care|maintenance)|mulch\w*|weeding|it'?s my park)\b/i, 0.25],
  // For one age group that is not everyone: a seniors' class.
  [/\b(seniors?|older adults?|(?:55|60|65)\s*\+)/i, 0.3],
  // The weekly class.
  [/\b(yoga|zumba|pilates|fitness|aerobics?|circuit|boot ?camp|workout|tai chi|qi ?gong|meditation|stretch(?:ing)?|cardio|training|(?:walking|running) (?:group|club)|run club|open run|clinic|bodyweight|strength|barre)\b/i, 0.3],
  // A standing group or a course: a book club, a drawing class. (Not "world-class", not a supper club.)
  [/\b((?:book|chess|lego|knitting|crochet|sewing|writing|garden(?:ing)?|run(?:ning)?|walking|hiking|homework|coding|anime|manga|games?|gaming|teen|kids|crafts?|drama|math|science|language|conversation|spanish|french|photography|bridge|mah ?jongg?|scrabble|puzzle) clubs?|(?:knitting|sewing|crochet|writing|reading) (?:circle|group)|meetup|lessons?|(?<!-)class(?:es)?|programming|practice|rehearsal|open (?:gym|play|swim))\b/i, 0.4],
];

/** An event's draw: what its listing and title say it is, less what its title says it is not. */
function eventDraw(c: Candidate): Draw {
  let score = 0;
  const interests = candidateInterests(c);
  // Filed under sport and dance both, it is a dance class (a parks department's "Dance Fusion"), not a performance.
  const exercise = (interests.sports ?? 0) >= 1;
  for (const [interest, strength] of Object.entries(interests)) {
    if (strength >= 1 && isInterest(interest) && !(exercise && interest === "theatre")) score = Math.max(score, EVENT_DRAW[interest]);
  }
  if (score === 0) score = EVENT_UNKNOWN;
  const title = (c.occurrence?.title ?? c.name).slice(0, 200);
  for (const [re, cap] of ROUTINE_EVENTS) {
    if (re.test(title)) {
      score = Math.min(score, cap);
      break;
    }
  }
  return { score, reasons: [] };
}

export function drawOf(c: Candidate, ctx: Pick<RequestContext, "now" | "youngestAge" | "company">): Draw {
  return c.kind === "occurrence" ? eventDraw(c) : placeDraw(c, ctx);
}
