import { isFreshConfirmation, localClock, matchKey, minutesBetween, type Interest } from "@outrn/core";
import { destinationOf, openDawnToDusk, type DestinationView } from "./destination.js";
import type { Candidate, CategoryPolicy, Evaluation, ReasonCode, RequestContext, ResultClass, Scores } from "./types.js";
import { waitFloorMinutes } from "./conditions.js";
import { isOutdoor, readWeather, WEATHER_LIMITS } from "./forecast.js";
import { dayPartOf, subtypeOf, type DayPart } from "./daypart.js";
import { ageLimitOf, deadlineOf, minorInParty, type FeasibilityOutcome } from "./feasibility.js";
import { AMENITIES, KID_FACILITY_REASON, kidFacilitiesFor, restroomOf, youngestUnder } from "./amenities.js";
import { happyHourAt, OFFERS, outdoorSeatingWeather } from "./offers.js";
import { TASTE, tasteMatch, tasteWeights } from "./taste.js";
import { cuisinesOf } from "./cuisine.js";
import { LIKELY_OPEN } from "./likely.js";
import { drawOf, renownOf } from "./draw.js";

/**
 * Four separately inspectable scores. Feasibility is a gate, not a score: nothing here can rescue a
 * candidate that failed it. Among what passed, merit orders: what is worth going out for (appeal,
 * from draw.ts), how it fits the time (fit), and what is still to check, which costs by what it
 * risks (uncertaintyCost) and is never hidden from the card.
 */

/** What a 9pm+ window is for: bars and late food. */
const LATE_NIGHT = new Set(["bar", "nightclub", "restaurant"]);

/**
 * Appeal starts from draw (draw.ts): how much an option is something to go out for. `base` is a
 * place nobody would go out of their way for, and `base + draw` one an outing is built around, so
 * a famous deli and the branch library no longer start level. An event's draw is what it is (a
 * concert, not a fitness class); being on today and not tomorrow adds `event`, starting soon a
 * little more. Events and places compete on one list, not in lanes.
 */
export const APPEAL_WEIGHTS = { base: 0.3, draw: 0.5, completeness: 0.06, chainPenalty: 0.15, lateNight: 0.1, hoursConfirmed: 0.1, primeTime: 0.05, offHours: 0.25, event: 0.1, eventStartsSoon: 0.05, popularNow: 0.1, destination: 0.1, destinationLongWindow: 0.1, destinationNamed: 0.05, kidsEventForAdults: 0.35, kidsEventForFamily: 0.25, notForTheCompany: 0.15 } as const;
/**
 * An event is popular right now from this score up, as its source measures demand (0 to 1): a film
 * among TMDB's ten most popular, a SeatGeek event in its top band. Ranking only, never a gate.
 */
export const POPULAR_FROM = 0.7;
/** A trip up to this long costs nothing in fit: three minutes' walk or six, one is as near as the other. */
export const NEAR_ENOUGH_MINUTES: Readonly<Record<RequestContext["mode"], number>> = { walk: 6, transit: 8, drive: 8 };
/** How much of a trip's length a place's draw forgives, at most (`share`, at draw 1), and from what draw. */
export const WORTH_A_WALK = { share: 0.6, fromDraw: 0.6 } as const;
/** How much of the travel score is "worth the trip" (see scoreCandidate), by window length. */
export const WORTH_THE_TRIP = { fromMinutes: 90, fullMinutes: 240, share: 0.5 } as const;
/**
 * Weather, as the seeded context rules rain_indoor and cold_indoor (0002) describe it: rain likely
 * (50%+) sinks outdoor places and lifts indoor ones a little; cold (38°F or below) sinks outdoor ones.
 * In appeal, where it outweighs a short walk: a park 3 minutes away in a downpour is not the pick.
 */
export const WEATHER_APPEAL = { rainOutdoor: -0.25, rainIndoor: 0.05, coldOutdoor: -0.15, rainChance: WEATHER_LIMITS.rainChance, coldF: WEATHER_LIMITS.coldF } as const;
const COMPANY_CATEGORY_BONUS: Record<NonNullable<RequestContext["company"]>, string[]> = {
  alone: ["cafe", "bookshop", "library", "gallery", "museum", "park", "cinema"],
  date: ["restaurant", "bar", "viewpoint", "waterfront", "cinema", "live_music", "gallery", "bowling", "activity"],
  friends: ["bar", "restaurant", "live_music", "market", "park", "theatre", "bowling", "arcade", "nightclub", "activity"],
  family: ["park", "garden", "museum", "market", "dessert", "attraction", "library", "bowling", "arcade", "activity"],
};

/** Food a quick, casual meal is made of: good for friends or family, not what a date is built around. */
const CASUAL_CUISINES: ReadonlySet<string> = new Set(["pizza", "burger", "fast_food", "chicken", "fried_chicken", "wings", "sandwich", "hot_dog", "bagel", "donut", "deli", "kebab", "fish_and_chips", "diner", "bubble_tea"]);
/** Bars an evening for two is not built around: the big screens, the pub crowd. */
const NOT_A_DATE_BAR: ReadonlySet<string> = new Set(["sports_bar", "pub"]);
/** Activities that are no date: a casino floor. */
const NOT_A_DATE_ACTIVITY: ReadonlySet<string> = new Set(["casino"]);

/**
 * Whether a place suits who is going: its category is one for that company, and, for a date, it is a
 * place an evening for two is built around. A restaurant whose every cuisine is casual (a pizza
 * counter, a burger joint), a pub or sports bar, and a casino are for friends, not a date. What a
 * place is not known to be stays as its category says.
 */
export function suitsCompany(c: Candidate, company: NonNullable<RequestContext["company"]>): boolean {
  if (!COMPANY_CATEGORY_BONUS[company].includes(c.category)) return false;
  if (company !== "date") return true;
  const subtype = subtypeOf(c);
  if (c.category === "bar") return !(subtype !== null && NOT_A_DATE_BAR.has(subtype));
  if (c.category === "activity") return !(subtype !== null && NOT_A_DATE_ACTIVITY.has(subtype));
  const cuisines = cuisinesOf(c);
  return !(cuisines.length > 0 && cuisines.every((x) => CASUAL_CUISINES.has(x)));
}

/** How far into a long window this search is: 0 up to 90 minutes, 1 from four hours (see WORTH_THE_TRIP). */
export function longWindowOf(ctx: RequestContext): number {
  const windowMinutes = Math.max(1, minutesBetween(ctx.now, deadlineOf(ctx)));
  return Math.max(0, Math.min(1, (windowMinutes - WORTH_THE_TRIP.fromMinutes) / (WORTH_THE_TRIP.fullMinutes - WORTH_THE_TRIP.fromMinutes)));
}

/** What being a destination adds to a place's appeal in this search (see scoreCandidate, and detour.ts). */
export function destinationAppeal(dest: DestinationView, ctx: RequestContext): number {
  return APPEAL_WEIGHTS.destination + longWindowOf(ctx) * APPEAL_WEIGHTS.destinationLongWindow + (dest.note ? APPEAL_WEIGHTS.destinationNamed : 0);
}

export function scoreCandidate(
  c: Candidate,
  ctx: RequestContext,
  f: FeasibilityOutcome,
  policy: CategoryPolicy,
  maxTravel: number,
  weights: ReturnType<typeof tasteWeights> = tasteWeights(ctx),
): { scores: Scores; extraReasons: ReasonCode[]; dayPart: DayPart | null; tasteLead: Interest | null; draw: number; rotation: number } {
  const extra: ReasonCode[] = [];
  const t = f.timing!;
  // What it is worth going out for (draw.ts): the base of its appeal, and how far it is worth going.
  const draw = drawOf(c, ctx);

  // Fit: travel slack, time slack, who is going, weather. (A mood is taste: see below.)
  // Travel counts against the time the user has: a 15-minute walk is nothing in an evening, a lot in an hour.
  const windowMinutes = Math.max(1, minutesBetween(ctx.now, deadlineOf(ctx)));
  const reach = Math.min(maxTravel, Math.max(10, windowMinutes * 0.25));
  // And, with time to spare, against what it buys (worth the trip): the share of the outing spent
  // getting there and back. A long trip is for a place that takes a while (a museum, a market, a
  // long meal), not a 25-minute ice cream. It counts from 90 minutes and fully from four hours.
  const worth = 1 - (2 * t.travel.minutes) / (2 * t.travel.minutes + t.visit.typicalMinutes);
  const longWindow = longWindowOf(ctx);
  // A few minutes more or less is no difference: the nearest of several good places is not the best for it.
  const free = NEAR_ENOUGH_MINUTES[ctx.mode];
  const near = Math.max(0, 1 - Math.max(0, t.travel.minutes - free) / Math.max(1, reach - free));
  // And a place people cross the city for is worth a longer walk: the more of an outing it is in
  // itself (draw, from 0.6 up), the less of its distance counts against it. The nearest famous deli
  // is not the only famous deli.
  const stretch = WORTH_A_WALK.share * Math.max(0, Math.min(1, (draw.score - WORTH_A_WALK.fromDraw) / (1 - WORTH_A_WALK.fromDraw)));
  const nearness = near + (1 - near) * stretch;
  const travelScore = (1 - longWindow * WORTH_THE_TRIP.share) * nearness + longWindow * WORTH_THE_TRIP.share * worth;
  // Time spent waiting (for a table, in line) is not time there.
  const timeSlack = Math.max(0, Math.min(1, (t.usefulMinutes - waitFloorMinutes(t.conditions) - t.minUsefulMinutes) / Math.max(15, t.minUsefulMinutes)));
  let chips = 0.5;
  // Suitability before preference: a venue with an adult age limit (a casino inside "activity") never
  // gets the family bonus its category would otherwise earn when a minor is in the party, nor a lift
  // from their taste (below). Feasibility has already excluded published limits; this sinks estimated
  // ones. A bar with no known limit is still a bar: no family bonus, and it sinks like one with a limit.
  const adultForMinor = minorInParty(ctx) && ((ageLimitOf(c)?.minAge ?? 0) >= 18 || c.category === "bar" || c.category === "nightclub");
  // An event made for children (its source says so) is a family's: the family bonus with a minor
  // along, and it sinks in appeal (below) for grown-ups out on their own.
  // Never for one that is probably for adults (a wine tasting tagged for kids): what the source says
  // of its audience does not lift an age doubt.
  const forKids = c.kind === "occurrence" && (c.facts.audience?.value as { kids?: unknown } | undefined)?.kids === true && !adultForMinor;
  if (ctx.company) {
    if (adultForMinor) chips -= 0.25;
    else if (suitsCompany(c, ctx.company)) chips += 0.25;
  }
  if (forKids && minorInParty(ctx)) chips += 0.25;
  chips = Math.max(0, Math.min(1, chips));
  let weather = 0.5;
  const outdoor = isOutdoor(c);
  // A forecast hour with no chance of rain given says nothing about rain: neither wet nor dry.
  const { rainy, dry, cold, hot } = readWeather(ctx.weather);
  if (ctx.weather) {
    if (outdoor) {
      // Heat is not a reason against going, but it is no longer good weather for it.
      weather = rainy || cold ? 0.1 : hot ? 0.5 : dry ? 0.9 : 0.5;
      if (dry && !cold && !hot) extra.push("WEATHER_SUITABLE");
    } else weather = rainy || cold ? 0.7 : 0.5;
  }
  let fit = 0.4 * travelScore + 0.3 * timeSlack + 0.15 * chips + 0.15 * weather;
  if (f.reasons.includes("CLOSES_SOON")) fit -= 0.1;
  fit = Math.max(0, Math.min(1, fit));

  // Appeal: how much it is something to go out for (its kind, what its records say of it: draw.ts),
  // then what suits the moment and the party, overrides and context rules.
  let appeal = APPEAL_WEIGHTS.base + APPEAL_WEIGHTS.draw * draw.score;
  extra.push(...draw.reasons);
  const completeness = ["website", "phone", "opening_hours"].filter((a) => c.facts[a as keyof typeof c.facts]).length / 3;
  appeal += APPEAL_WEIGHTS.completeness * completeness;
  if (c.kind === "occurrence") appeal += APPEAL_WEIGHTS.event + (f.reasons.includes("EVENT_STARTS_SOON") ? APPEAL_WEIGHTS.eventStartsSoon : 0);
  // What people are going to now: a popular film's screening, a show in demand. Like taste, never a
  // lift or a claim for an adult place or an adult-limited event with a minor along.
  const popularity = c.kind === "occurrence" ? (c.facts.popularity?.value as { score?: unknown } | undefined)?.score : undefined;
  if (typeof popularity === "number" && popularity >= POPULAR_FROM && !adultForMinor) {
    appeal += APPEAL_WEIGHTS.popularNow;
    extra.push("POPULAR_NOW");
  }
  // A place worth going out of the way for (a preserve, gardens, a lookout): more so with the time to
  // go out of the way, where it outweighs the longer trip that fit holds against it, and a little more
  // when it is one anyone local would name (the curated list, which says why).
  const dest = c.kind === "venue" ? destinationOf(c) : null;
  if (dest) {
    appeal += destinationAppeal(dest, ctx);
    extra.push("DESTINATION");
  }
  // Made for children: with a child along it is the outing, whatever kind of event it is; without one it sinks.
  if (forKids) appeal += minorInParty(ctx) ? APPEAL_WEIGHTS.kidsEventForFamily : -APPEAL_WEIGHTS.kidsEventForAdults;
  // A place of the company's kind that is no place for it (a pub, a casino floor, a pizza counter on a
  // date) sinks, so the wine bar and the dinner come first.
  if (ctx.company && COMPANY_CATEGORY_BONUS[ctx.company].includes(c.category) && !suitsCompany(c, ctx.company)) appeal -= APPEAL_WEIGHTS.notForTheCompany;
  // A franchise is the same everywhere; prefer the local place unless the user asked for that kind of place.
  if (c.brand && !ctx.categories?.includes(c.category)) appeal -= APPEAL_WEIGHTS.chainPenalty;
  const arrivalHour = localClock(t.arrival, ctx.timezone).hour;
  if ((arrivalHour >= 21 || arrivalHour < 4) && LATE_NIGHT.has(c.category)) appeal += APPEAL_WEIGHTS.lateNight;
  // Open isn't the same as a good idea: a park after dark or a bar at 10am sinks, a café at 8am rises.
  // An event is its own time, so the kind of place it is held in doesn't judge it.
  let part = c.kind === "occurrence" ? null : dayPartOf(c, t.arrival, ctx.timezone, ctx.sunset);
  // A lookout keeps the city lights; one in a preserve, taken to be open dawn to dusk for want of
  // hours of its own (openDawnToDusk), is a dark trailhead after sunset.
  if (part !== null && c.kind === "venue" && !c.facts.opening_hours && ctx.sunset && t.arrival > ctx.sunset && openDawnToDusk(c)) part = "off";
  if (part === "prime") appeal += APPEAL_WEIGHTS.primeTime;
  else if (part === "off") appeal -= APPEAL_WEIGHTS.offHours;
  // "Confirmed" needs a recent verification (a founder check or an observation) and no dispute;
  // which source published the hours is not enough, and a fetch date is not a verification.
  const hours = c.kind === "venue" ? c.facts.opening_hours : undefined;
  if (hours && isFreshConfirmation(hours.verifiedAt, hours.conflict, ctx.now)) {
    appeal += APPEAL_WEIGHTS.hoursConfirmed;
    extra.push("HOURS_CONFIRMED");
  }
  // Not once the place is dark for the day ("off": a park or waterfront after sunset), which the window would contradict.
  if (ctx.sunset && outdoor && part !== "off" && (c.category === "viewpoint" || c.category === "waterfront" || c.category === "park")) {
    const m = minutesBetween(t.arrival, ctx.sunset);
    // No forecast keeps the window as before; a forecast must say it is dry, not merely not say rain.
    const clear = !ctx.weather || dry;
    if (m >= -20 && m <= 60 && clear) {
      appeal += 0.15;
      extra.push("SUNSET_WINDOW");
    }
  }
  // What the place offers at this hour: happy hour (never offered to a party with a minor), and tables
  // outside when the weather suits them.
  if (!minorInParty(ctx) && happyHourAt(c, t.arrival, t.latestFinish)) {
    appeal += OFFERS.appeal;
    extra.push("HAPPY_HOUR");
  }
  if (outdoorSeatingWeather(c, ctx)) {
    appeal += OFFERS.appeal;
    extra.push("OUTDOOR_SEATING");
  }
  // What it has for who is going: an accessible restroom for a wheelchair user, high chairs for a
  // toddler (one lift, however many); no restroom counts against it with young children.
  const restroom = restroomOf(c);
  if (ctx.requireWheelchair && restroom.wheelchair === "yes") {
    appeal += AMENITIES.accessibleRestroom;
    extra.push("ACCESSIBLE_RESTROOM");
  }
  const kids = kidFacilitiesFor(c, ctx);
  if (kids.length) {
    appeal += AMENITIES.appeal;
    extra.push(...kids.map((k) => KID_FACILITY_REASON[k.facility]));
  }
  if (restroom.available === "no" && youngestUnder(ctx, AMENITIES.restroomNeededUnder)) appeal -= AMENITIES.appeal;
  if (outdoor) appeal += (rainy ? WEATHER_APPEAL.rainOutdoor : 0) + (cold ? WEATHER_APPEAL.coldOutdoor : 0);
  else if (rainy) appeal += WEATHER_APPEAL.rainIndoor;
  appeal += c.boost;
  appeal = Math.max(0, Math.min(1, appeal));

  // Novelty: recently shown or dismissed on this device
  let novelty = 1;
  if (ctx.seenIds?.includes(c.id)) novelty -= 0.6;
  if (ctx.seenIds?.includes(c.venueId) && c.kind === "occurrence") novelty -= 0.3;
  novelty = Math.max(0, novelty);

  // Taste: what this person likes, and what this search is in the mood for (taste.ts). A love does
  // not lift a poor idea for the hour: a park after dark is no better for someone who loves parks.
  const taste = weights ? tasteMatch(c, weights) : null;
  if (taste && part === "off") taste.score = Math.min(taste.score, 0.5);
  // Nor is an adult place lifted, claimed as their taste, or kept on the first page for a party with a minor.
  if (taste && adultForMinor) {
    taste.score = Math.min(taste.score, 0.5);
    taste.lead = null;
  }
  if (taste?.lead) extra.unshift("TASTE_MATCH");

  void policy;
  const scores: Scores = { evidence: +f.evidenceConfidence.toFixed(3), fit: +fit.toFixed(3), appeal: +appeal.toFixed(3), novelty: +novelty.toFixed(3) };
  if (taste) scores.taste = taste.score;
  return { scores, extraReasons: extra, dayPart: part, tasteLead: taste?.lead ?? null, draw: draw.score, rotation: rotationOf(c, ctx) };
}

/**
 * Today's turn. Among options about as good as each other (three hundred restaurants a few minutes
 * away, none known to be better), which comes first was the alphabet's choice, the same every day:
 * the same three cards on every open. Each option's merit now shifts by up to half of `span` either
 * way, by a number fixed for the day: most of it the option's own, the rest (`kindShare`) shared by
 * its kind of place, so that near-equals take turns from day to day, and so do the kinds of outing
 * that lead (a market day, a museum day). A search repeated the same day gives the same order, and
 * an option better than another by more than `span` always comes first.
 */
export const ROTATION = { span: 0.08, kindShare: 0.35 } as const;

/**
 * FNV-1a, then a finishing mix: a stable spread of a short string, not a secret. Without the mix a
 * change in the last characters (the day of the month) barely moves the high bits, and tomorrow's
 * order would be today's.
 */
function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** The local date of a search, read once: every candidate of a search asks for the same one. */
let lastDate: { at: number; timeZone: string; date: string } | null = null;
function localDate(at: Date, timeZone: string): string {
  if (!lastDate || lastDate.at !== at.getTime() || lastDate.timeZone !== timeZone) lastDate = { at: at.getTime(), timeZone, date: localClock(at, timeZone).date };
  return lastDate.date;
}

/** By what the option is and where (ids differ between databases; a place does not), and the local date. */
export function rotationOf(c: Candidate, ctx: Pick<RequestContext, "now" | "timezone" | "steady">): number {
  if (ctx.steady) return 0;
  const date = localDate(ctx.now, ctx.timezone);
  const unit = (key: string) => hash32(key) / 0x1_0000_0000 - 0.5;
  const own = unit(`${date}|${matchKey(c.name)}|${c.point.lat.toFixed(4)}|${c.point.lon.toFixed(4)}|${c.occurrence ? c.occurrence.start.toISOString() : ""}`);
  const kind = unit(`${date}|${c.kind === "occurrence" ? "happening" : c.category}`);
  return +(ROTATION.span * ((1 - ROTATION.kindShare) * own + ROTATION.kindShare * kind)).toFixed(4);
}

/**
 * What each thing to check first costs an option in merit. Being Ready used to come before
 * everything: a museum three minutes away with its hours listed ranked below every café, because
 * nothing says whether one walks in or buys a ticket at the desk, and no event ever led, because an
 * event needs a ticket. Now what is unknown is weighed by what it risks: a wasted trip (no hours
 * listed) costs a lot, a question the door answers costs little. The card still says Check first, and
 * what to check. Rain is already in appeal; a doubt the party may go in at all is not a cost but a
 * rank of its own (hasAgeDoubt).
 */
export const UNCERTAINTY: Readonly<Record<string, number>> = {
  HOURS_UNKNOWN: 0.08,
  HOURS_DOUBTFUL: 0.08,
  PROGRAMME_UNLISTED: 0.08,
  LATE_ENTRY_UNCERTAIN: 0.08,
  TOUR_ONLY: 0.08,
  WAIT_MAY_NOT_FIT: 0.06,
  DIET_FROM_NAME: 0.05,
  HOURS_UNVERIFIED: 0.04,
  ADMISSION_UNCONFIRMED: 0.04,
  PRICE_UNKNOWN: 0.03,
  ACCESS_LIMITED: 0.03,
  RESTROOM_NOT_ACCESSIBLE: 0.03,
  RESTROOM_ACCESS_LIMITED: 0.02,
  ADMISSION_UNKNOWN: 0.02,
  HOURS_APPROXIMATE: 0.02,
  RAIN_LIKELY: 0,
  AGE_LIMIT_LIKELY: 0,
  AGE_LIMIT_UNCERTAIN: 0,
  KIDS_UNCERTAIN: 0,
};
/**
 * A wasted trip costs by its length: finding a door shut three minutes away is a shrug, half an hour
 * away it is the evening. Added to HOURS_UNKNOWN per minute of travel, one way.
 */
export const WASTED_TRIP_PER_MINUTE = 0.004;
/** A caveat with no cost of its own yet, and the most a card's caveats cost together. */
export const UNCERTAINTY_DEFAULT = 0.05;
export const UNCERTAINTY_MAX = 0.2;

/** What an option's caveats cost it (0 for a Ready one). */
export function uncertaintyCost(e: Evaluation): number {
  let cost = 0;
  // A stage with nothing listed has no hours but its shows': what's on is the one thing to check.
  const programme = e.unresolved.includes("PROGRAMME_UNLISTED");
  for (const code of e.unresolved) {
    if (code === "HOURS_UNKNOWN") {
      if (programme) continue;
      // Likely open, not known to be: the cost of checking, and of the times places like it are shut then.
      if (e.likelyOpen) cost += LIKELY_OPEN.checkCost + (1 - e.likelyOpen.open / e.likelyOpen.listed) * LIKELY_OPEN.missCost;
      else if (knownAtItsHour(e)) cost += KNOWN_AT_ITS_HOUR;
      else cost += UNCERTAINTY.HOURS_UNKNOWN! + WASTED_TRIP_PER_MINUTE * (e.timing?.travel.minutes ?? 0);
    } else cost += UNCERTAINTY[code] ?? UNCERTAINTY_DEFAULT;
  }
  return Math.min(UNCERTAINTY_MAX, cost);
}

/** Caveats that risk the trip itself: it may be shut, full, or not on. */
const TRIP_AT_RISK: ReadonlySet<string> = new Set(["HOURS_UNKNOWN", "HOURS_DOUBTFUL", "PROGRAMME_UNLISTED", "LATE_ENTRY_UNCERTAIN", "TOUR_ONLY", "WAIT_MAY_NOT_FIT"]);

/**
 * Whether going could be for nothing: its hours are unknown (and places like it are not known to be
 * open then), nothing is listed on its stage, the last entry may have passed. Variety never promotes
 * such an option (select.ts): it is offered where its merit puts it, with what to check.
 */
export function tripAtRisk(e: Evaluation): boolean {
  return e.unresolved.some((code) => TRIP_AT_RISK.has(code) && !(code === "HOURS_UNKNOWN" && (e.likelyOpen || (knownAtItsHour(e) && widelyKnown(e.candidate)))));
}

/**
 * Known well enough that variety may show it with its hours unlisted: an encyclopedia entry on its
 * record, or recognised by Claude as a destination. A place it merely finds notable pays less for
 * its unlisted hours at its hour (knownAtItsHour) and still waits for its merit.
 */
function widelyKnown(c: Candidate): boolean {
  return c.hasLandmarkId || c.hasWikipedia === true || renownOf(c) === "destination";
}

/**
 * No hours listed, for a place known by name (an encyclopedia entry, or Claude recognising it:
 * LANDMARK) at the time of day its kind of place is for: the zoo at one on a Saturday, the pizzeria
 * everyone names at lunch. What "no hours listed" mostly risks is a record nobody has looked at in
 * years and a door that is shut at that hour; a place this known is neither, most days. It stays
 * Check first with "hours not listed" on its card. It pays for the check, not for a wasted trip, and
 * variety may show it when it is widely known. At any other hour (the zoo at eight in the evening)
 * it is as any other.
 */
export const KNOWN_AT_ITS_HOUR = 0.03;
export function knownAtItsHour(e: Evaluation): boolean {
  return e.dayPart === "prime" && e.reasons.includes("LANDMARK") && !SEASONAL.has(seasonOf(e.candidate));
}

/**
 * Kinds that shut for months whatever the hour: an amusement park's rides run in season only, so its
 * time of day says nothing in October. They pay for their unlisted hours in full.
 */
const SEASONAL: ReadonlySet<string> = new Set(["amusement", "theme_park", "ice_rink", "miniature_golf"]);
function seasonOf(c: Candidate): string {
  return destinationOf(c)?.kind === "amusement" ? "amusement" : (subtypeOf(c) ?? "");
}

/** Merit without a taste or a mood: what is worth going for first, then how well it fits the time, then novelty. */
export const MERIT = { appeal: 0.55, fit: 0.3, novelty: 0.15 } as const;

/**
 * One number for how good an option is: appeal, then fit, novelty least; with a taste or a mood, how
 * well it matches leads with appeal. Less what its caveats cost (uncertaintyCost), plus today's turn
 * (ROTATION).
 */
export function merit(e: Evaluation): number {
  const s = e.scores;
  // A destination past the everyday reach with one like it nearer pays back its bonus (detour.ts).
  const appeal = s.appeal - (e.detour?.appeal ?? 0);
  const m = s.taste !== undefined ? s.taste * TASTE.merit.taste + appeal * TASTE.merit.appeal + s.fit * TASTE.merit.fit + s.novelty * TASTE.merit.novelty : appeal * MERIT.appeal + s.fit * MERIT.fit + s.novelty * MERIT.novelty;
  return m - uncertaintyCost(e) + (e.rotation ?? 0);
}

/**
 * Whether an option can be counted on to be open: Ready, or Check first on its hours alone where
 * places like it are likely open then (LIKELY_OPEN). Not a place outdoors in the dark (a park open
 * all night at 10:30pm: dayPart "off"): being open is not what it lacks. Its class (the card's label)
 * is its own. Ranking is by merit, which already weighs what there is to check (uncertaintyCost);
 * this is for the rules that ask for a sure thing (a nearer stand-in for a far destination, one
 * sure option on the first page).
 */
export function standing(e: Evaluation): ResultClass {
  const s = e.class === "check_first" && e.likelyOpen ? "ready" : e.class;
  // Likely open or known to be, a dark lawn is no better for it.
  return s === "ready" && e.dayPart === "off" && isOutdoor(e.candidate) ? "check_first" : s;
}

/**
 * A doubt the party may go in at all: a bar with a child along, a place likely 21+. These come only
 * with an age in the request (feasibility), and such a place ranks after every other option: nothing
 * that moves the rest (a dark lawn's demotion, a taste, an appeal) lifts it onto a family's first page.
 */
const AGE_DOUBTS: ReadonlySet<string> = new Set(["AGE_LIMIT_LIKELY", "AGE_LIMIT_UNCERTAIN", "KIDS_UNCERTAIN"]);
export function ageDoubtIn(unresolved: readonly string[]): boolean {
  return unresolved.some((c) => AGE_DOUBTS.has(c));
}
export function hasAgeDoubt(e: Evaluation): boolean {
  return ageDoubtIn(e.unresolved);
}

/** Ordering within the eligible set: by merit; an age doubt for the party last. */
export function compareEvaluations(a: Evaluation, b: Evaluation): number {
  const rank = (e: Evaluation) => (hasAgeDoubt(e) ? 1 : 0);
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  const wa = merit(a);
  const wb = merit(b);
  if (wb !== wa) return wb - wa;
  // Equal on merit: the better evidenced, then the nearer, then by name. The same search always gives
  // the same order, whatever order the places were loaded in (ids are random).
  if (b.scores.evidence !== a.scores.evidence) return b.scores.evidence - a.scores.evidence;
  const ta = a.timing?.travel.minutes ?? Number.POSITIVE_INFINITY;
  const tb = b.timing?.travel.minutes ?? Number.POSITIVE_INFINITY;
  if (ta !== tb) return ta - tb;
  return a.candidate.name.localeCompare(b.candidate.name, "en") || (a.candidate.id < b.candidate.id ? -1 : a.candidate.id > b.candidate.id ? 1 : 0);
}
