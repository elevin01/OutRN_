import { ACTIVITY_OF_CATEGORY, cuisineGroups, haversineMetres, matchKey, ownValue, type LatLon } from "@outrn/core";
import type { Evaluation, Relaxation, RequestContext, ResultClass, Shortlist } from "./types.js";
import { compareEvaluations, hasAgeDoubt, merit, standing } from "./score.js";
import { TASTE } from "./taste.js";
import { ENGINE_VERSION, WEIGHTS_VERSION } from "./types.js";

/**
 * Diversity and the fewer-than-three rule.
 *
 * Standing beats diversity: a Ready option (or a likely-open one, see standing) is never displaced
 * by a Check-first one just because it would add a new activity type. Within a standing, a broad
 * request prefers distinct activity types first, then fills from the same standing, where a repeat
 * of what was just shown (the same kind of place, the same cuisine) costs a little: a slightly
 * lower-scored Thai place comes before a third Italian one, but a much better Italian place still wins. Narrowed request (a category chip, or
 * a cuisine): respect it — three bars is a valid answer to "bars" — though cuisines still vary within it.
 * A child venue is not shown beside its parent. Never fill a third slot by silently relaxing a
 * constraint; name the relaxation instead.
 */

/**
 * What a repeat costs, in merit (see score.ts), against each of the last `window` places shown:
 * the same category, and the same kind within it (a cuisine group, or the subtype of an activity).
 * Merit gaps between neighbours are usually a few hundredths; a place that is better by more than
 * the penalty keeps its place.
 */
export const VARIETY = { window: 3, sameCategory: 0.03, sameKind: 0.05 } as const;

/** What makes two places of one category the same kind: their cuisine groups, or their subtype. */
function kindsOf(e: Evaluation): Set<string> {
  const f = e.candidate.facts;
  const cuisines = (f.cuisine?.value as { values?: unknown } | undefined)?.values;
  const kinds = Array.isArray(cuisines) ? cuisineGroups(cuisines.filter((x): x is string => typeof x === "string")) : new Set<string>();
  const subtype = (f.subtype?.value as { value?: unknown } | undefined)?.value;
  if (typeof subtype === "string") kinds.add(`${e.candidate.category}:${subtype}`);
  return kinds;
}

function repeatPenalty(e: Evaluation, kinds: Set<string>, recent: Evaluation[], kindCache: Map<Evaluation, Set<string>>): number {
  let p = 0;
  for (const r of recent) {
    if (r.candidate.category === e.candidate.category) p += VARIETY.sameCategory;
    const rk = kindCache.get(r)!;
    for (const k of kinds) {
      if (rk.has(k)) {
        p += VARIETY.sameKind;
        break;
      }
    }
  }
  return p;
}

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

/** Options on the first page, where a love is guaranteed a place (see keepLovedOnFirstPage). */
export const FIRST_PAGE = 3;

/**
 * Each thing this person loves is never left off the first page when there is one to show: for each
 * love the first page has nothing of (by what the option matches best), the best option of it takes
 * one of the page's last slots, the better of them the higher. Someone who loves comedy and games
 * sees a comedy club and the arcade bar, not three bars. The first slot stays the best option
 * overall, and a love already there keeps its slot. A promoted love keeps its class (Check first
 * stays Check first, with its caveat), and a poor idea for the hour is not promoted. The options it
 * displaces lead the next page; the rest keep their order.
 */
function keepLovedOnFirstPage(ordered: Evaluation[]): void {
  if (ordered.length <= FIRST_PAGE) return;
  const loved = (e: Evaluation) => (e.scores.taste ?? 0) >= TASTE.loved;
  const page = ordered.slice(0, FIRST_PAGE);
  // The page's slots a love may take, top down: never the first, never one a love already holds.
  const open = page.flatMap((e, i) => (i > 0 && !loved(e) ? [i] : []));
  const shown = new Set(page.filter(loved).map((e) => e.tasteLead ?? null));
  const promoted: Evaluation[] = [];
  for (const e of ordered.slice(FIRST_PAGE)) {
    if (promoted.length >= open.length) break;
    // Nor one the party may not be let into (a 16+ arcade, children's ages unknown): a love does not lift that.
    if (!loved(e) || e.dayPart === "off" || hasAgeDoubt(e) || shown.has(e.tasteLead ?? null)) continue;
    shown.add(e.tasteLead ?? null);
    promoted.push(e);
  }
  if (!promoted.length) return;
  // The lowest open slots, so a single love takes the last one as it always has.
  const slots = open.slice(open.length - promoted.length);
  const displaced = slots.map((i) => page[i]!);
  slots.forEach((i, k) => (page[i] = promoted[k]!));
  const moved = new Set(promoted);
  const rest = ordered.slice(FIRST_PAGE).filter((e) => !moved.has(e));
  ordered.splice(0, ordered.length, ...page, ...displaced, ...rest);
}

/**
 * Two places of one name this near are one place to whoever reads the list: OSM's point for a park
 * and its outline, two points for one shop, Overture's copy of a place OSM has under another
 * category, two branches of a chain across the street. The list shows it once. Grounds spread
 * wider: a preserve's parts, or its entrance and the middle of its outline, are a few hundred
 * metres apart (Marshlands Conservancy, Rockefeller State Park Preserve).
 */
export const SAME_PLACE_M = 150;
export const SAME_GROUNDS_M = 1000;
const GROUNDS: ReadonlySet<string> = new Set(["park", "garden", "waterfront", "attraction"]);
const sameWithin = (e: Evaluation) => (GROUNDS.has(e.candidate.category) ? SAME_GROUNDS_M : SAME_PLACE_M);

/** Every eligible candidate in display order. Pages ("More options") are slices of this. */
export function orderForDisplay(all: Evaluation[], ctx: RequestContext): Evaluation[] {
  const eligible = all.filter((e) => e.class !== "ineligible").sort(compareEvaluations);
  const narrowed = Boolean(ctx.categories?.length || ctx.cuisines?.length || ctx.diets?.length);
  const ordered: Evaluation[] = [];
  const taken = new Set<Evaluation>();
  const usedVenues = new Set<string>();
  const usedActivities = new Set<string>();
  // Where each name already shown is (places, not events: an event's title is not a place's name).
  const shownNames = new Map<string, { point: LatLon; within: number }[]>();
  const nameKeys = new Map<Evaluation, string>();
  const nameKey = (e: Evaluation) => {
    let k = nameKeys.get(e);
    if (k === undefined) nameKeys.set(e, (k = e.candidate.kind === "venue" ? matchKey(e.candidate.name) : ""));
    return k;
  };
  const shownAlready = (e: Evaluation) => {
    const key = nameKey(e);
    return key !== "" && (shownNames.get(key)?.some((p) => haversineMetres(p.point, e.candidate.point) <= Math.max(p.within, sameWithin(e))) ?? false);
  };
  // A museum café is not a destination while the museum itself qualifies: hold children back when their parent is eligible.
  const eligibleVenueIds = new Set(eligible.map((e) => e.candidate.venueId));

  const kindCache = new Map<Evaluation, Set<string>>();
  const kinds = (e: Evaluation) => {
    let k = kindCache.get(e);
    if (!k) kindCache.set(e, (k = kindsOf(e)));
    return k;
  };
  // With a taste, variety is among what this person likes: one of each kind of outing they like
  // first, then the rest by merit (which weighs the match). Without a like in that class, variety
  // is across everything they don't skip, as without a taste.
  const likes = (e: Evaluation) => (e.scores.taste ?? 0.5) > 0.5;
  const likedIn = new Set(eligible.filter(likes).map(standing));
  const admissible = (e: Evaluation, pass: Pass): boolean => {
    if ((pass.cls !== "any" && standing(e) !== pass.cls) || taken.has(e)) return false;
    // A doubt the party may go in at all (a bar with a child along) waits for the last pass: no
    // variety, no class pass, no demotion of the rest puts it before what they can surely do.
    if (pass.cls !== "any" && hasAgeDoubt(e)) return false;
    const parent = e.candidate.parentVenueId;
    if (usedVenues.has(e.candidate.venueId) || shownAlready(e)) return false;
    if (parent && (usedVenues.has(parent) || (!pass.releaseChildren && eligibleVenueIds.has(parent)))) return false;
    if (pass.diverse && usedActivities.has(ACTIVITY_OF_CATEGORY[e.candidate.category])) return false;
    // Variety never promotes a poor idea for the hour (a park after dark, a bar at 10am), or what this
    // person skips: it waits for its score.
    if (pass.diverse && e.dayPart === "off") return false;
    if (pass.diverse && (e.scores.taste ?? 0.5) < 0.5) return false;
    if (pass.diverse && likedIn.has(standing(e)) && !likes(e)) return false;
    return true;
  };
  const take = (e: Evaluation) => {
    ordered.push(e);
    taken.add(e);
    usedVenues.add(e.candidate.venueId);
    if (e.candidate.parentVenueId) usedVenues.add(e.candidate.parentVenueId);
    usedActivities.add(ACTIVITY_OF_CATEGORY[e.candidate.category]);
    const key = nameKey(e);
    if (key !== "") shownNames.set(key, [...(shownNames.get(key) ?? []), { point: e.candidate.point, within: sameWithin(e) }]);
  };

  for (const pass of PASSES) {
    if (narrowed && pass.diverse) continue;
    // One of each activity, best first; and the leftovers, in merit order.
    if (pass.diverse || pass.cls === "any") {
      for (const e of eligible) if (admissible(e, pass)) take(e);
      continue;
    }
    // Filling within a class: the best place once a repeat of the last few shown is paid for.
    // Within a class `eligible` is in merit order and the penalty is never negative, so the scan
    // stops at the first place whose merit alone can't beat the best found.
    // Every place a page can show (MAX_OFFSET + a page) is ordered this way; the rest follow in merit order.
    while (ordered.length < MAX_OFFSET + 3) {
      const recent = ordered.slice(-VARIETY.window);
      for (const r of recent) kinds(r);
      let best: Evaluation | null = null;
      let bestScore = Number.NEGATIVE_INFINITY;
      for (const e of eligible) {
        if (standing(e) !== pass.cls) continue;
        const m = merit(e);
        if (m <= bestScore) break;
        if (!admissible(e, pass)) continue;
        const score = m - repeatPenalty(e, kinds(e), recent, kindCache);
        if (score > bestScore) {
          best = e;
          bestScore = score;
        }
      }
      if (!best) break;
      take(best);
    }
    for (const e of eligible) if (admissible(e, pass)) take(e);
  }
  keepLovedOnFirstPage(ordered);
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

/** Must-haves in a relaxation's words: "without outdoor seating or Wi-Fi". */
const FEATURE_WORDS: Readonly<Record<string, string>> = { outdoor_seating: "outdoor seating", wifi: "Wi-Fi" };

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
  // A cuisine or diet search without categories asked for food: widening means any cuisine, not other kinds of place.
  if (ctx.categories?.length || !(ctx.cuisines?.length || ctx.diets?.length)) add("NOT_REQUESTED", "more_categories", "widen the categories");
  add("OTHER_CUISINE", "any_cuisine", "try any cuisine");
  // A must-have the user can live without; a diet is a need, and is never offered.
  const optional = (ctx.features ?? []).map((f) => ownValue(FEATURE_WORDS, f)).filter((w): w is string => Boolean(w));
  if (optional.length) add("FEATURE_NOT_KNOWN", "without_features", `without ${optional.join(" or ")}`);
  add("TAKEOUT_ONLY", "takeout", "get food to go");
  add("NO_TAKEOUT", "dine_in", "sit down to eat");
  add("EVENT_ENDS_AFTER_DEADLINE", "stay_later", "stay out later");
  // Accessibility, diets and dismissals are never offered as relaxations.
  return out.slice(0, 3);
}
