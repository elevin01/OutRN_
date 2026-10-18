import { DEFAULT_MAX_TRAVEL_MINUTES, WALK_DESTINATIONS, type DestinationKind } from "@outrn/core";
import { destinationOf, type DestinationView } from "./destination.js";
import { destinationAppeal, standing } from "./score.js";
import type { Evaluation, RequestContext } from "./types.js";

/**
 * A long window reaches farther for a destination (destinationMaxTravel: a 4-hour Saturday drives up
 * to an hour to a preserve), because a place worth the drive is worth it when nothing like it is
 * nearer. When one like it is within the everyday reach and Ready, the farther one's bonus for being
 * a destination fades over the minutes past that reach, gone `fadeMinutes` past it: from White
 * Plains, Inwood Hill Park is not the afternoon walk while Kensico Dam Plaza is twenty minutes away.
 * A farther place better on its own merits (a landmark, kid facilities, the curated list's note) can
 * still lead; one only as good does not. Ranking only: it stays an option, and its card is unchanged.
 */
export const DETOUR = { fadeMinutes: 20 } as const;

/** What stands in for a destination: any walk (a preserve, a park, gardens, a beach, a shore) for another; anything else only its own kind. */
function likeGroup(kind: DestinationKind): string {
  return WALK_DESTINATIONS.has(kind) ? "walk" : kind;
}

/** Mark the destinations past the everyday reach that one like them within it stands in for. */
export function markDetours(evals: Evaluation[], ctx: RequestContext): void {
  // A request's own travel limit is every place's reach: nothing is past it.
  if (ctx.maxTravelMinutes) return;
  const everyday = DEFAULT_MAX_TRAVEL_MINUTES[ctx.mode];
  const near = new Set<string>();
  const far: { e: Evaluation; group: string; dest: DestinationView }[] = [];
  for (const e of evals) {
    if (e.class === "ineligible" || !e.timing || e.candidate.kind !== "venue") continue;
    const dest = destinationOf(e.candidate);
    if (!dest) continue;
    const group = likeGroup(dest.kind);
    if (e.timing.travel.minutes > everyday) far.push({ e, group, dest });
    else if (standing(e) === "ready" && e.dayPart !== "off") near.add(group);
  }
  for (const { e, group, dest } of far) {
    if (!near.has(group)) continue;
    const minutes = e.timing!.travel.minutes - everyday;
    e.detour = { minutes, appeal: +(Math.min(1, minutes / DETOUR.fadeMinutes) * destinationAppeal(dest, ctx)).toFixed(3) };
  }
}
