import { DEFAULT_MAX_TRAVEL_MINUTES, destinationMaxTravel, isDestinationKind, minutesBetween, WALK_DESTINATIONS, type DestinationKind } from "@outrn/core";
import type { Candidate, RequestContext } from "./types.js";

/** What makes a place a destination, when it is one (its destination fact, see ingestDestinations). */
export interface DestinationView {
  kind: DestinationKind;
  /** Why it is worth the trip, in a line, lower case; null when only its kind is known. */
  note: string | null;
}

export function destinationOf(c: Candidate): DestinationView | null {
  const v = c.facts.destination?.value as { kind?: unknown; note?: unknown } | undefined;
  return v && isDestinationKind(v.kind) ? { kind: v.kind, note: typeof v.note === "string" ? v.note : null } : null;
}

/**
 * The farthest this candidate may be, one way: the request's own limit when it sets one, else a
 * destination's for the window (destinationMaxTravel), else the mode's everyday limit.
 */
export function maxTravelFor(c: Candidate, ctx: RequestContext): number {
  if (ctx.maxTravelMinutes) return ctx.maxTravelMinutes;
  if (!destinationOf(c)) return DEFAULT_MAX_TRAVEL_MINUTES[ctx.mode];
  return destinationMaxTravel(ctx.mode, ctx.endAt ? minutesBetween(ctx.now, ctx.endAt) : (ctx.windowMinutes ?? 180));
}

/**
 * Whether a place with no listed hours is usually open dawn to dusk: a park, and an outdoor
 * destination (a preserve, a beach, a waterfront, a lookout). Not gardens: a botanical garden keeps
 * posted hours, and a community garden opens on the days it posts.
 */
export function openDawnToDusk(c: Candidate): boolean {
  if (c.category === "park") return true;
  const d = destinationOf(c);
  return d !== null && d.kind !== "garden" && (WALK_DESTINATIONS.has(d.kind) || d.kind === "viewpoint");
}
