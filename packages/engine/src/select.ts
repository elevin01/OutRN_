import { ACTIVITY_OF_CATEGORY } from "@outrn/core";
import type { Evaluation, RequestContext, Shortlist } from "./types.js";
import { compareEvaluations } from "./score.js";
import { ENGINE_VERSION, WEIGHTS_VERSION } from "./types.js";

/**
 * Diversity and the fewer-than-three rule.
 *
 * Broad request: three cards should be different ways to spend the window (distinct activity
 * types, distinct venues). Narrowed request (a category chip): respect it — three bars is a
 * valid answer to "bars". A child venue is not shown beside its parent.
 * Never fill a third slot by silently relaxing a constraint; name the relaxation instead.
 */

export function selectShortlist(all: Evaluation[], ctx: RequestContext, opts: { size?: number; offset?: number } = {}): Shortlist {
  const size = opts.size ?? 3;
  const offset = opts.offset ?? 0;
  const eligible = all.filter((e) => e.class !== "ineligible").sort(compareEvaluations);
  const narrowed = Boolean(ctx.categories?.length);
  const picked: Evaluation[] = [];
  const skippedForDiversity: Evaluation[] = [];
  const usedVenues = new Set<string>();
  const usedActivities = new Set<string>();
  // A museum café is not a destination while the museum itself qualifies: hold children back when their parent is eligible.
  const eligibleVenueIds = new Set(eligible.map((e) => e.candidate.venueId));

  for (const e of eligible) {
    if (picked.length >= size + offset) break;
    const venueKey = e.candidate.venueId;
    const parent = e.candidate.parentVenueId;
    if (usedVenues.has(venueKey) || (parent && (usedVenues.has(parent) || eligibleVenueIds.has(parent)))) {
      skippedForDiversity.push(e);
      continue;
    }
    const act = ACTIVITY_OF_CATEGORY[e.candidate.category];
    if (!narrowed && usedActivities.has(act)) {
      skippedForDiversity.push(e);
      continue;
    }
    picked.push(e);
    usedVenues.add(venueKey);
    if (parent) usedVenues.add(parent);
    usedActivities.add(act);
  }
  // Relax activity diversity (never venue uniqueness) if we came up short.
  for (const e of skippedForDiversity) {
    if (picked.length >= size + offset) break;
    const venueKey = e.candidate.venueId;
    const parent = e.candidate.parentVenueId;
    if (usedVenues.has(venueKey) || (parent && usedVenues.has(parent))) continue;
    picked.push(e);
    usedVenues.add(venueKey);
    if (parent) usedVenues.add(parent);
  }

  const items = picked.slice(offset, offset + size);
  const fewer = items.length < size && offset === 0;
  return { items, all, fewerThanThree: fewer, relaxations: fewer ? relaxations(all, ctx) : [], engineVersion: ENGINE_VERSION, weightsVersion: WEIGHTS_VERSION };
}

/** Which single change would admit the most currently-ineligible candidates? Offer that, specifically. */
export function relaxations(all: Evaluation[], ctx: RequestContext): string[] {
  const counts = new Map<string, number>();
  for (const e of all) {
    if (e.class !== "ineligible" || !e.excludedBy) continue;
    counts.set(e.excludedBy, (counts.get(e.excludedBy) ?? 0) + 1);
  }
  const out: string[] = [];
  const add = (code: string, text: string) => {
    if ((counts.get(code) ?? 0) > 0) out.push(`${text} (+${counts.get(code)})`);
  };
  add("TOO_FAR", ctx.mode === "walk" ? "allow a longer walk" : "allow a longer drive");
  add("NOT_ENOUGH_TIME", "give it more time");
  add("CLOSED_ON_ARRIVAL", "try a different time");
  add("OVER_BUDGET", "raise the budget");
  add("NOT_FREE", "include paid options");
  add("NOT_REQUESTED", "widen the categories");
  add("EVENT_ENDS_AFTER_DEADLINE", "stay out later");
  // Accessibility and dismissals are never offered as relaxations.
  return out.slice(0, 3);
}
