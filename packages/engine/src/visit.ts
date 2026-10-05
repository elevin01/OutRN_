import { localClock, minutesBetween, WALK_DESTINATIONS, type Category, type DestinationKind } from "@outrn/core";
import { destinationOf } from "./destination.js";
import type { Candidate, RequestContext, TimingBase, Visit } from "./types.js";

/**
 * What a visit takes: its style (a sit-down meal, counter service, takeout, a visit, an event), the
 * minimum the engine requires for it to be worthwhile, and how long people typically spend. The
 * minimum is what feasibility enforces; the typical length is what the card says ("takes about
 * 1h15"). The user's own time stays theirs: neither is a cap on how long they stay.
 */

/** Food categories, whose visit style depends on dine-in or takeout. */
export const FOOD_CATEGORIES: ReadonlySet<Category> = new Set(["restaurant", "cafe", "dessert"]);

/** Minutes to order and collect food to go. */
export const TAKEOUT_MINUTES = 15;
const TAKEOUT_TYPICAL_MINUTES = 20;

/** How long people typically spend, by category, when nothing more specific is known. Policy, not fact. */
const TYPICAL_MINUTES: Record<Category, number> = {
  restaurant: 60, // a sit-down meal outside dinner hours; see restaurantTypical
  cafe: 35,
  dessert: 25,
  bar: 60,
  museum: 120,
  gallery: 45,
  theatre: 120,
  cinema: 120,
  live_music: 120,
  arts_centre: 75,
  community: 60,
  market: 45,
  park: 60,
  garden: 60,
  waterfront: 45,
  viewpoint: 25,
  attraction: 90,
  library: 45,
  bookshop: 30,
  bowling: 75,
  arcade: 45,
  nightclub: 120,
  activity: 75,
  event_site: 90, // a pop-up with no end given: a street fair, a set in the park
  other: 45,
};

/** How long people typically spend at a destination of each kind: a walk in a preserve, an afternoon at the zoo. */
const DESTINATION_TYPICAL_MINUTES: Record<DestinationKind, number> = {
  nature: 90,
  park: 75,
  garden: 90,
  beach: 90,
  waterfront: 60,
  viewpoint: 30,
  estate: 120,
  zoo: 180,
};

/** A sit-down dinner runs longer than lunch or a late bite. */
function restaurantTypical(hourLocal: number): number {
  return hourLocal >= 17 && hourLocal < 22 ? 80 : TYPICAL_MINUTES.restaurant;
}

/** What the venue says about food to go (OSM takeaway): "only" has no seats, "no" does not do it. */
export function takeoutOf(c: Candidate): "yes" | "no" | "only" | null {
  const f = c.facts.takeout;
  const v = (f?.value as { value?: unknown } | undefined)?.value;
  return f && f.evidenceClass !== "estimate" && (v === "yes" || v === "no" || v === "only") ? v : null;
}

/** True when this visit is food to go: asked for, or the only way the place serves. */
export function isTakeout(c: Candidate, ctx: RequestContext): boolean {
  return FOOD_CATEGORIES.has(c.category) && (ctx.visitStyle === "takeout" || takeoutOf(c) === "only");
}

/** The visit for an evaluated timing: its style, the minimum used, and the typical length. */
export function visitFor(c: Candidate, ctx: RequestContext, t: TimingBase): Visit {
  const min = t.minUsefulMinutes;
  if (c.kind === "occurrence" && c.occurrence) {
    const o = c.occurrence;
    const length = o.end ? minutesBetween(o.start, o.end) : TYPICAL_MINUTES[c.category];
    return { style: "event", minMinutes: min, typicalMinutes: Math.max(min, length), isEstimate: !o.end };
  }
  if (isTakeout(c, ctx)) return { style: "takeout", minMinutes: min, typicalMinutes: Math.max(min, TAKEOUT_TYPICAL_MINUTES), isEstimate: true };
  // A destination's visit is what it is for: a walk on its trails, an afternoon at the zoo.
  const dest = destinationOf(c);
  if (dest) return { style: WALK_DESTINATIONS.has(dest.kind) ? "walk" : "visit", minMinutes: min, typicalMinutes: Math.max(min, DESTINATION_TYPICAL_MINUTES[dest.kind]), isEstimate: true };
  const hour = localClock(t.arrival, ctx.timezone).hour;
  const typical = c.category === "restaurant" ? restaurantTypical(hour) : TYPICAL_MINUTES[c.category];
  const style = c.category === "restaurant" ? "dine_in" : c.category === "cafe" || c.category === "dessert" ? "counter" : "visit";
  return { style, minMinutes: min, typicalMinutes: Math.max(min, typical), isEstimate: true };
}
