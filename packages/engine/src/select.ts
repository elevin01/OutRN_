import { ACTIVITY_OF_CATEGORY, cuisineGroups, haversineMetres, matchKey, ownValue, type LatLon } from "@outrn/core";
import type { Evaluation, Relaxation, RequestContext, Shortlist } from "./types.js";
import { compareEvaluations, hasAgeDoubt, merit, tripAtRisk } from "./score.js";
import { TASTE } from "./taste.js";
import { ENGINE_VERSION, WEIGHTS_VERSION } from "./types.js";

/**
 * Diversity and the fewer-than-three rule.
 *
 * Options are ordered by merit (score.ts), which weighs what an option is worth going out for, how it
 * fits the time, and what there is to check first. A broad request then prefers distinct kinds of
 * outing first, among options about as good as the best (VARIETY.span): variety never promotes filler,
 * so a bookshop half an hour away is not the second card because it is the only bookshop. The rest
 * fill by merit, where a repeat of what was just shown (the same kind of place, the same cuisine)
 * costs a little: a slightly lower-scored Thai place comes before a third Italian one, but a much
 * better Italian place still wins. Narrowed request (a category chip, or a cuisine): respect it —
 * three bars is a valid answer to "bars" — though cuisines still vary within it.
 * A child venue is not shown beside its parent. Never fill a third slot by silently relaxing a
 * constraint; name the relaxation instead.
 */

/**
 * What a repeat costs, in merit (see score.ts), against each of the last `window` places shown:
 * the same category, and the same kind within it (a cuisine group, or the subtype of an activity).
 * Merit gaps between neighbours are usually a few hundredths; a place that is better by more than
 * the penalty keeps its place. `span`: how far below the best option one of another kind of outing
 * may be and still be shown ahead of the best's own kind; the second kind on the list may be farther
 * below (`secondKindSpan`), so that a page is not three of one thing (three preserves on a Saturday
 * afternoon, for someone who wanted lunch) while something else decent is there. `minDraw`: variety
 * is among outings, so it never promotes what is not one (a branch library, a pocket park: draw.ts).
 * `minFit`: nor a stretch (a tavern half an hour away because it is the only tavern), unless it is an
 * outing worth one (`worthAStretch`: a festival, a concert, a museum).
 */
export const VARIETY = { window: 3, sameCategory: 0.03, sameKind: 0.05, span: 0.1, secondKindSpan: 0.15, minDraw: 0.35, minFit: 0.6, worthAStretch: 0.7 } as const;

/**
 * What kind of outing an option is, for variety. Something happening is its own kind: tonight's
 * concert does not stand in for a place to eat, nor a museum for the talk held in it.
 */
function outingOf(e: Evaluation): string {
  return e.candidate.kind === "occurrence" ? "happening" : ACTIVITY_OF_CATEGORY[e.candidate.category];
}

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
  /** One of each kind of outing, among the options about as good as the best. */
  diverse: boolean;
  /** The leftovers: children held back while their parent was eligible (the parent still must not be shown), and options the party may not be let into. */
  leftovers: boolean;
}

const FILL: Pass = { diverse: false, leftovers: false };
const PASSES: Pass[] = [{ diverse: true, leftovers: false }, FILL, { diverse: false, leftovers: true }];

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
 * One option on the first page can be counted on: when none of its three is Ready, the best Ready
 * option takes its last slot, if it is nearly as good (`span`) as what it replaces. Everything else on
 * the page may be worth a check first (an event to book, a museum whose desk we know nothing of);
 * one card should need none. Never the first slot, never a love's (the slot above it instead), never
 * a poor idea for the hour or something this person skips. The option it replaces leads the next page.
 */
export const SURE_THING = { span: 0.15 } as const;
function keepASureThing(ordered: Evaluation[], meritOf: (e: Evaluation) => number): void {
  if (ordered.length <= FIRST_PAGE) return;
  const page = ordered.slice(0, FIRST_PAGE);
  if (page.some((e) => e.class === "ready")) return;
  const loved = (e: Evaluation) => (e.scores.taste ?? 0) >= TASTE.loved;
  const slot = [FIRST_PAGE - 1, FIRST_PAGE - 2].find((i) => i > 0 && !loved(page[i]!));
  if (slot === undefined) return;
  const floor = meritOf(page[slot]!) - SURE_THING.span;
  const at = ordered.findIndex((e, i) => i >= FIRST_PAGE && e.class === "ready" && e.dayPart !== "off" && !hasAgeDoubt(e) && (e.scores.taste ?? 0.5) >= 0.5 && meritOf(e) >= floor);
  if (at < 0) return;
  const [sure] = ordered.splice(at, 1);
  const displaced = ordered[slot]!;
  ordered[slot] = sure!;
  ordered.splice(FIRST_PAGE, 0, displaced);
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
  // Merit is read many times below; it does not change while the list is ordered.
  const merits = new Map<Evaluation, number>();
  const meritOf = (e: Evaluation): number => {
    let m = merits.get(e);
    if (m === undefined) merits.set(e, (m = merit(e)));
    return m;
  };
  const narrowed = Boolean(ctx.categories?.length || ctx.cuisines?.length || ctx.diets?.length);
  const ordered: Evaluation[] = [];
  const taken = new Set<Evaluation>();
  const usedVenues = new Set<string>();
  const usedOutings = new Set<string>();
  // Where each name already shown is (places, not events: an event's title is not a place's name).
  const shownNames = new Map<string, { point: LatLon; within: number; ageDoubt: boolean }[]>();
  const nameKeys = new Map<Evaluation, string>();
  const nameKey = (e: Evaluation) => {
    let k = nameKeys.get(e);
    if (k === undefined) nameKeys.set(e, (k = e.candidate.kind === "venue" ? matchKey(e.candidate.name) : ""));
    return k;
  };
  // A record that warns the party of an age limit is never held back behind one of its name that does
  // not: the warning is what this party most needs to see (a brewpub OSM files as a bar and Overture as a restaurant).
  const shownAlready = (e: Evaluation) => {
    const key = nameKey(e);
    const doubt = hasAgeDoubt(e);
    return key !== "" && (shownNames.get(key)?.some((p) => (p.ageDoubt || !doubt) && haversineMetres(p.point, e.candidate.point) <= Math.max(p.within, sameWithin(e))) ?? false);
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
  // first, then the rest by merit (which weighs the match). Without a like, variety is across
  // everything they don't skip, as without a taste.
  const likes = (e: Evaluation) => (e.scores.taste ?? 0.5) > 0.5;
  const anyLiked = eligible.some((e) => likes(e) && !hasAgeDoubt(e));
  const admissible = (e: Evaluation, pass: Pass): boolean => {
    if (taken.has(e)) return false;
    // A doubt the party may go in at all (a bar with a child along) waits for the last pass: no
    // variety and no merit puts it before what they can surely do.
    if (!pass.leftovers && hasAgeDoubt(e)) return false;
    const parent = e.candidate.parentVenueId;
    if (usedVenues.has(e.candidate.venueId) || shownAlready(e)) return false;
    if (parent && (usedVenues.has(parent) || (!pass.leftovers && eligibleVenueIds.has(parent)))) return false;
    return !(pass.diverse && usedOutings.has(outingOf(e)));
  };
  /**
   * Whether variety may move an option ahead of better ones of a kind already shown. Never a poor
   * idea for the hour (a park after dark, a bar at 10am), a trip that could be for nothing (no hours
   * listed, nothing on its stage), what is no outing in itself, a chain's branch, a stretch to get to
   * or to fit in (unless it is worth one), or what this person skips; and among what they like when
   * they like anything. Such an option waits for its score.
   */
  const promotable = (e: Evaluation): boolean => {
    const draw = e.draw ?? 1;
    if (e.dayPart === "off" || tripAtRisk(e) || draw < VARIETY.minDraw || (e.scores.fit < VARIETY.minFit && draw < VARIETY.worthAStretch)) return false;
    // A chain's branch is the same everywhere: an option when it is asked for or the best left, never the page's variety.
    if (e.candidate.brand && !ctx.categories?.includes(e.candidate.category)) return false;
    if ((e.scores.taste ?? 0.5) < 0.5) return false;
    return !(anyLiked && !likes(e));
  };
  const take = (e: Evaluation) => {
    ordered.push(e);
    taken.add(e);
    usedVenues.add(e.candidate.venueId);
    if (e.candidate.parentVenueId) usedVenues.add(e.candidate.parentVenueId);
    usedOutings.add(outingOf(e));
    const key = nameKey(e);
    if (key !== "") shownNames.set(key, [...(shownNames.get(key) ?? []), { point: e.candidate.point, within: sameWithin(e), ageDoubt: hasAgeDoubt(e) }]);
  };

  for (const pass of PASSES) {
    if (pass.diverse) {
      if (narrowed) continue;
      // One of each kind of outing, down the merit order (`eligible`; an age doubt is last and not
      // admissible here). The head of the list is taken as it comes. Once a better option has been
      // passed over for being of a kind already shown, the next kind jumps the queue only if variety
      // may promote it, and only while it is about as good as the best.
      let best: number | null = null;
      let passedOver = false;
      let kinds = 0;
      for (const e of eligible) {
        // Not an option in any pass yet (a second record of a place shown, a museum's café): nothing is passed over.
        if (hasAgeDoubt(e) || !admissible(e, FILL)) continue;
        if (!admissible(e, pass)) {
          passedOver = true;
          continue;
        }
        const m = meritOf(e);
        if (best === null) best = m;
        if (passedOver) {
          if (m < best - (kinds === 1 ? VARIETY.secondKindSpan : VARIETY.span)) break;
          if (!promotable(e)) continue;
        }
        take(e);
        kinds++;
      }
      continue;
    }
    if (pass.leftovers) {
      for (const e of eligible) if (admissible(e, pass)) take(e);
      continue;
    }
    // Filling: the best place once a repeat of the last few shown is paid for. `eligible` is in merit
    // order and the penalty is never negative, so the scan stops at the first place whose merit alone
    // can't beat the best found. Every place a page can show (MAX_OFFSET + a page) is ordered this
    // way; the rest follow in merit order.
    while (ordered.length < MAX_OFFSET + 3) {
      const recent = ordered.slice(-VARIETY.window);
      for (const r of recent) kinds(r);
      let best: Evaluation | null = null;
      let bestScore = Number.NEGATIVE_INFINITY;
      let head = true;
      for (const e of eligible) {
        if (hasAgeDoubt(e)) break;
        const m = meritOf(e);
        if (m <= bestScore) break;
        if (!admissible(e, pass)) continue;
        // A repeat's cost breaks near-ties among options variety may promote. One it may not (a trip
        // that could be for nothing, a poor idea for the hour) is taken when it is the best left.
        if (!head && !promotable(e)) continue;
        head = false;
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
  keepASureThing(ordered, meritOf);
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
