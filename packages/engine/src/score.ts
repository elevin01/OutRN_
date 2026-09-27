import { ACTIVITY_OF_CATEGORY, isFreshConfirmation, localClock, minutesBetween } from "@outrn/core";
import type { Candidate, CategoryPolicy, Evaluation, ReasonCode, RequestContext, Scores } from "./types.js";
import { ageLimitOf, partyYoungest, type FeasibilityOutcome } from "./feasibility.js";

/**
 * Four separately inspectable scores. Feasibility is a gate, not a score; nothing here can
 * rescue a candidate that failed it, and Evidence is never traded against Appeal.
 */

const OUTDOOR = new Set(["park", "garden", "waterfront", "viewpoint"]);
/** What a 9pm+ window is for: bars and late food. */
const LATE_NIGHT = new Set(["bar", "nightclub", "restaurant"]);

export const APPEAL_WEIGHTS = { chainPenalty: 0.15, lateNight: 0.1, hoursConfirmed: 0.1 } as const;
const MOOD_ACTIVITY: Record<NonNullable<RequestContext["mood"]>, string[]> = {
  relaxed: ["food", "outdoors", "browse"],
  active: ["outdoors", "entertainment"],
  food: ["food", "drink"],
  culture: ["culture", "entertainment"],
};
const COMPANY_CATEGORY_BONUS: Record<NonNullable<RequestContext["company"]>, string[]> = {
  alone: ["cafe", "bookshop", "library", "gallery", "museum", "park", "cinema"],
  date: ["restaurant", "bar", "viewpoint", "waterfront", "cinema", "live_music", "gallery", "bowling", "activity"],
  friends: ["bar", "restaurant", "live_music", "market", "park", "theatre", "bowling", "arcade", "nightclub", "activity"],
  family: ["park", "garden", "museum", "market", "dessert", "attraction", "library", "bowling", "arcade", "activity"],
};

export function scoreCandidate(c: Candidate, ctx: RequestContext, f: FeasibilityOutcome, policy: CategoryPolicy, maxTravel: number): { scores: Scores; extraReasons: ReasonCode[] } {
  const extra: ReasonCode[] = [];
  const t = f.timing!;
  const activity = ACTIVITY_OF_CATEGORY[c.category];

  // Fit: travel slack, time slack, chips, weather
  const travelScore = Math.max(0, 1 - t.travel.minutes / Math.max(1, maxTravel));
  const timeSlack = Math.max(0, Math.min(1, (t.usefulMinutes - t.minUsefulMinutes) / Math.max(15, t.minUsefulMinutes)));
  let chips = 0.5;
  if (ctx.mood) chips += MOOD_ACTIVITY[ctx.mood].includes(activity) ? 0.25 : -0.15;
  if (ctx.company) {
    // Suitability before preference: a venue with an adult age limit (a casino inside "activity") never
    // gets the family bonus its category would otherwise earn when a minor is in the party. Feasibility
    // has already excluded published limits; this sinks estimated ones.
    const youngest = partyYoungest(ctx);
    const minorPresent = youngest === "minor" || (typeof youngest === "number" && youngest < 18);
    const adultLimit = (ageLimitOf(c)?.minAge ?? 0) >= 18;
    if (minorPresent && adultLimit) chips -= 0.25;
    else if (COMPANY_CATEGORY_BONUS[ctx.company].includes(c.category)) chips += 0.25;
  }
  chips = Math.max(0, Math.min(1, chips));
  let weather = 0.5;
  const outdoor = OUTDOOR.has(c.category) || (c.facts["indoor_outdoor"]?.value as { value?: string } | undefined)?.value === "outdoor";
  if (ctx.weather) {
    const rainy = (ctx.weather.precipProbability ?? 0) >= 50;
    const cold = ctx.weather.temperatureF <= 38;
    if (outdoor) {
      weather = rainy || cold ? 0.1 : 0.9;
      if (!rainy && !cold) extra.push("WEATHER_SUITABLE");
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
  if (c.kind === "occurrence") appeal += 0.15;
  // A franchise is the same everywhere; prefer the local place unless the user asked for that kind of place.
  if (c.brand && !ctx.categories?.includes(c.category)) appeal -= APPEAL_WEIGHTS.chainPenalty;
  const arrivalHour = localClock(t.arrival, ctx.timezone).hour;
  if ((arrivalHour >= 21 || arrivalHour < 4) && LATE_NIGHT.has(c.category)) appeal += APPEAL_WEIGHTS.lateNight;
  // "Confirmed" needs a recent verification (a founder check or an observation) and no dispute;
  // which source published the hours is not enough, and a fetch date is not a verification.
  const hours = c.kind === "venue" ? c.facts.opening_hours : undefined;
  if (hours && isFreshConfirmation(hours.verifiedAt, hours.conflict, ctx.now)) {
    appeal += APPEAL_WEIGHTS.hoursConfirmed;
    extra.push("HOURS_CONFIRMED");
  }
  if (ctx.sunset && outdoor && (c.category === "viewpoint" || c.category === "waterfront" || c.category === "park")) {
    const m = minutesBetween(t.arrival, ctx.sunset);
    const clear = (ctx.weather?.precipProbability ?? 0) < 50;
    if (m >= -20 && m <= 60 && clear) {
      appeal += 0.15;
      extra.push("SUNSET_WINDOW");
    }
  }
  appeal += c.boost;
  appeal = Math.max(0, Math.min(1, appeal));

  // Novelty: recently shown or dismissed on this device
  let novelty = 1;
  if (ctx.seenIds?.includes(c.id)) novelty -= 0.6;
  if (ctx.seenIds?.includes(c.venueId) && c.kind === "occurrence") novelty -= 0.3;
  novelty = Math.max(0, novelty);

  void policy;
  return { scores: { evidence: +f.evidenceConfidence.toFixed(3), fit: +fit.toFixed(3), appeal: +appeal.toFixed(3), novelty: +novelty.toFixed(3) }, extraReasons: extra };
}

/** Ordering within the eligible set: class, then appeal, then fit, novelty as tiebreaker. */
export function compareEvaluations(a: Evaluation, b: Evaluation): number {
  const rank = (e: Evaluation) => (e.class === "ready" ? 0 : e.class === "check_first" ? 1 : 2);
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  const wa = a.scores.appeal * 0.5 + a.scores.fit * 0.35 + a.scores.novelty * 0.15;
  const wb = b.scores.appeal * 0.5 + b.scores.fit * 0.35 + b.scores.novelty * 0.15;
  return wb - wa;
}
