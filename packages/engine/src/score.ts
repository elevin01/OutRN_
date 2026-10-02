import { isFreshConfirmation, localClock, minutesBetween, type Interest } from "@outrn/core";
import type { Candidate, CategoryPolicy, Evaluation, ReasonCode, RequestContext, Scores } from "./types.js";
import { waitFloorMinutes } from "./conditions.js";
import { isOutdoor, readWeather, WEATHER_LIMITS } from "./forecast.js";
import { dayPart, type DayPart } from "./daypart.js";
import { ageLimitOf, deadlineOf, minorInParty, type FeasibilityOutcome } from "./feasibility.js";
import { AMENITIES, KID_FACILITY_REASON, kidFacilitiesFor, restroomOf, youngestUnder } from "./amenities.js";
import { happyHourAt, OFFERS, outdoorSeatingWeather } from "./offers.js";
import { TASTE, tasteMatch, tasteWeights } from "./taste.js";

/**
 * Four separately inspectable scores. Feasibility is a gate, not a score; nothing here can
 * rescue a candidate that failed it, and Evidence is never traded against Appeal.
 */

/** What a 9pm+ window is for: bars and late food. */
const LATE_NIGHT = new Set(["bar", "nightclub", "restaurant"]);

/**
 * An event is pushed: it happens now and not tomorrow, and it is what someone out tonight is looking
 * for. It competes with places on one list (a strong boost, not a lane); one starting soon a little more.
 */
export const APPEAL_WEIGHTS = { chainPenalty: 0.15, lateNight: 0.1, hoursConfirmed: 0.1, primeTime: 0.05, offHours: 0.25, event: 0.25, eventStartsSoon: 0.05 } as const;
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

export function scoreCandidate(
  c: Candidate,
  ctx: RequestContext,
  f: FeasibilityOutcome,
  policy: CategoryPolicy,
  maxTravel: number,
  weights: ReturnType<typeof tasteWeights> = tasteWeights(ctx),
): { scores: Scores; extraReasons: ReasonCode[]; dayPart: DayPart | null; tasteLead: Interest | null } {
  const extra: ReasonCode[] = [];
  const t = f.timing!;

  // Fit: travel slack, time slack, who is going, weather. (A mood is taste: see below.)
  // Travel counts against the time the user has: a 15-minute walk is nothing in an evening, a lot in an hour.
  const windowMinutes = Math.max(1, minutesBetween(ctx.now, deadlineOf(ctx)));
  const reach = Math.min(maxTravel, Math.max(10, windowMinutes * 0.25));
  // And, with time to spare, against what it buys (worth the trip): the share of the outing spent
  // getting there and back. A long trip is for a place that takes a while (a museum, a market, a
  // long meal), not a 25-minute ice cream. It counts from 90 minutes and fully from four hours.
  const worth = 1 - (2 * t.travel.minutes) / (2 * t.travel.minutes + t.visit.typicalMinutes);
  const longWindow = Math.max(0, Math.min(1, (windowMinutes - WORTH_THE_TRIP.fromMinutes) / (WORTH_THE_TRIP.fullMinutes - WORTH_THE_TRIP.fromMinutes)));
  const travelScore = (1 - longWindow * WORTH_THE_TRIP.share) * Math.max(0, 1 - t.travel.minutes / reach) + longWindow * WORTH_THE_TRIP.share * worth;
  // Time spent waiting (for a table, in line) is not time there.
  const timeSlack = Math.max(0, Math.min(1, (t.usefulMinutes - waitFloorMinutes(t.conditions) - t.minUsefulMinutes) / Math.max(15, t.minUsefulMinutes)));
  let chips = 0.5;
  // Suitability before preference: a venue with an adult age limit (a casino inside "activity") never
  // gets the family bonus its category would otherwise earn when a minor is in the party, nor a lift
  // from their taste (below). Feasibility has already excluded published limits; this sinks estimated
  // ones. A bar with no known limit is still a bar: no family bonus, and it sinks like one with a limit.
  const adultForMinor = minorInParty(ctx) && ((ageLimitOf(c)?.minAge ?? 0) >= 18 || c.category === "bar" || c.category === "nightclub");
  if (ctx.company) {
    if (adultForMinor) chips -= 0.25;
    else if (COMPANY_CATEGORY_BONUS[ctx.company].includes(c.category)) chips += 0.25;
  }
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

  // Appeal: modest prior + permitted signals + distinct occurrences + overrides + context rules
  let appeal = 0.5;
  if (c.hasLandmarkId) {
    appeal += 0.1;
    extra.push("LANDMARK");
  }
  const completeness = ["website", "phone", "opening_hours"].filter((a) => c.facts[a as keyof typeof c.facts]).length / 3;
  appeal += 0.1 * completeness;
  if (c.kind === "occurrence") appeal += APPEAL_WEIGHTS.event + (f.reasons.includes("EVENT_STARTS_SOON") ? APPEAL_WEIGHTS.eventStartsSoon : 0);
  // A franchise is the same everywhere; prefer the local place unless the user asked for that kind of place.
  if (c.brand && !ctx.categories?.includes(c.category)) appeal -= APPEAL_WEIGHTS.chainPenalty;
  const arrivalHour = localClock(t.arrival, ctx.timezone).hour;
  if ((arrivalHour >= 21 || arrivalHour < 4) && LATE_NIGHT.has(c.category)) appeal += APPEAL_WEIGHTS.lateNight;
  // Open isn't the same as a good idea: a park after dark or a bar at 10am sinks, a café at 8am rises.
  // An event is its own time, so the kind of place it is held in doesn't judge it.
  const part = c.kind === "occurrence" ? null : dayPart(c.category, t.arrival, ctx.timezone, ctx.sunset);
  if (part === "prime") appeal += APPEAL_WEIGHTS.primeTime;
  else if (part === "off") appeal -= APPEAL_WEIGHTS.offHours;
  // "Confirmed" needs a recent verification (a founder check or an observation) and no dispute;
  // which source published the hours is not enough, and a fetch date is not a verification.
  const hours = c.kind === "venue" ? c.facts.opening_hours : undefined;
  if (hours && isFreshConfirmation(hours.verifiedAt, hours.conflict, ctx.now)) {
    appeal += APPEAL_WEIGHTS.hoursConfirmed;
    extra.push("HOURS_CONFIRMED");
  }
  if (ctx.sunset && outdoor && (c.category === "viewpoint" || c.category === "waterfront" || c.category === "park")) {
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
    appeal += AMENITIES.appeal;
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
  return { scores, extraReasons: extra, dayPart: part, tasteLead: taste?.lead ?? null };
}

/**
 * One number for how good an option is within its class: appeal, then fit, novelty least. With a
 * taste or a mood, how well it matches leads: what someone loves comes before what is merely near.
 */
export function merit(e: Evaluation): number {
  const s = e.scores;
  if (s.taste !== undefined) return s.taste * TASTE.merit.taste + s.appeal * TASTE.merit.appeal + s.fit * TASTE.merit.fit + s.novelty * TASTE.merit.novelty;
  return s.appeal * 0.5 + s.fit * 0.35 + s.novelty * 0.15;
}

/** Ordering within the eligible set: class, then merit. */
export function compareEvaluations(a: Evaluation, b: Evaluation): number {
  const rank = (e: Evaluation) => (e.class === "ready" ? 0 : e.class === "check_first" ? 1 : 2);
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
