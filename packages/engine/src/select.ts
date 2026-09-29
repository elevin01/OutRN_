import { ACTIVITY_OF_CATEGORY } from "@outrn/core";
import type { Evaluation, Relaxation, RequestContext, ResultClass, Shortlist } from "./types.js";
import { compareEvaluations } from "./score.js";
import { ENGINE_VERSION, WEIGHTS_VERSION } from "./types.js";

/**
 * Diversity and the fewer-than-three rule.
 *
 * Class beats diversity: a Ready option is never displaced by a Check-first one just because it
 * would add a new activity type. Within a class, a broad request prefers distinct activity types
 * first, then fills from the same class ignoring diversity. Narrowed request (a category chip):
 * respect it — three bars is a valid answer to "bars". A child venue is not shown beside its parent.
 * Never fill a third slot by silently relaxing a constraint; name the relaxation instead.
 */

interface Pass {
  cls: Exclude<ResultClass, "ineligible"> | "any";
  diverse: boolean;
  /** Release children held back while their parent was eligible (the parent still must not be shown). */
  releaseChildren: boolean;
}

const PASSES: Pass[] = [
  { cls: "ready", diverse: true, releaseChildren: false },
  { cls: "ready", diverse: false, releaseChildren: false },
  { cls: "check_first", diverse: true, releaseChildren: false },
  { cls: "check_first", diverse: false, releaseChildren: false },
  { cls: "any", diverse: false, releaseChildren: true },
];

/** Every eligible candidate in display order. Pages ("More options") are slices of this. */
export function orderForDisplay(all: Evaluation[], ctx: RequestContext): Evaluation[] {
  const eligible = all.filter((e) => e.class !== "ineligible").sort(compareEvaluations);
  const narrowed = Boolean(ctx.categories?.length);
  const ordered: Evaluation[] = [];
  const taken = new Set<Evaluation>();
  const usedVenues = new Set<string>();
  const usedActivities = new Set<string>();
  // A museum café is not a destination while the museum itself qualifies: hold children back when their parent is eligible.
  const eligibleVenueIds = new Set(eligible.map((e) => e.candidate.venueId));

  for (const pass of PASSES) {
    if (narrowed && pass.diverse) continue;
    for (const e of eligible) {
      if ((pass.cls !== "any" && e.class !== pass.cls) || taken.has(e)) continue;
      const venueKey = e.candidate.venueId;
      const parent = e.candidate.parentVenueId;
      if (usedVenues.has(venueKey)) continue;
      if (parent && (usedVenues.has(parent) || (!pass.releaseChildren && eligibleVenueIds.has(parent)))) continue;
      const act = ACTIVITY_OF_CATEGORY[e.candidate.category];
      if (pass.diverse && usedActivities.has(act)) continue;
      // Variety never promotes a poor idea for the hour (a park after dark, a bar at 10am): it waits for its score.
      if (pass.diverse && e.dayPart === "off") continue;
      ordered.push(e);
      taken.add(e);
      usedVenues.add(venueKey);
      if (parent) usedVenues.add(parent);
      usedActivities.add(act);
    }
  }
  return ordered;
}

/**
 * Deepest page start served ("More options" 100 times). The engine owns this limit: it clamps the
 * requested offset to it and never offers a next page beyond it, so a caller that clamps to the same
 * constant can never be sent back to a page it has already shown.
 */
export const MAX_OFFSET = 300;

export function selectShortlist(all: Evaluation[], ctx: RequestContext, opts: { size?: number; offset?: number; maxOffset?: number } = {}): Shortlist {
  const size = opts.size ?? 3;
  const maxOffset = opts.maxOffset ?? MAX_OFFSET;
  const offset = Math.min(Math.max(0, Math.floor(opts.offset ?? 0)), maxOffset);
  const ordered = orderForDisplay(all, ctx);
  const items = ordered.slice(offset, offset + size);
  const fewer = items.length < size && offset === 0;
  const next = offset + items.length;
  const hasMore = items.length > 0 && ordered.length > next && next <= maxOffset;
  return {
    items,
    all,
    ordered: ordered.slice(0, maxOffset + size),
    offset,
    hasMore,
    nextOffset: hasMore ? next : null,
    fewerThanThree: fewer,
    relaxations: fewer ? relaxations(all, ctx) : [],
    engineVersion: ENGINE_VERSION,
    weightsVersion: WEIGHTS_VERSION,
  };
}

/** Which single change would admit the most currently-ineligible candidates? Offer that, specifically. */
export function relaxations(all: Evaluation[], ctx: RequestContext): Relaxation[] {
  const counts = new Map<string, number>();
  for (const e of all) {
    if (e.class !== "ineligible" || !e.excludedBy) continue;
    counts.set(e.excludedBy, (counts.get(e.excludedBy) ?? 0) + 1);
  }
  const out: Relaxation[] = [];
  const add = (exclusion: string | string[], code: string, text: string) => {
    const admits = [exclusion].flat().reduce((n, x) => n + (counts.get(x) ?? 0), 0);
    if (admits > 0) out.push({ code, text, admits });
  };
  add("TOO_FAR", "longer_travel", ctx.mode === "walk" ? "allow a longer walk" : ctx.mode === "drive" ? "allow a longer drive" : "allow a longer trip");
  add("NOT_ENOUGH_TIME", "more_time", "give it more time");
  add(["CLOSED_ON_ARRIVAL", "KITCHEN_CLOSED"], "different_time", "try a different time");
  add("OVER_BUDGET", "higher_budget", "raise the budget");
  add("NOT_FREE", "include_paid", "include paid options");
  add("NOT_REQUESTED", "more_categories", "widen the categories");
  add("TAKEOUT_ONLY", "takeout", "get food to go");
  add("NO_TAKEOUT", "dine_in", "sit down to eat");
  add("EVENT_ENDS_AFTER_DEADLINE", "stay_later", "stay out later");
  // Accessibility and dismissals are never offered as relaxations.
  return out.slice(0, 3);
}
