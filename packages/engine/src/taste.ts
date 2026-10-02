import { interestsOf, type Interest, type InterestStrengths } from "@outrn/core";
import type { Candidate, Mood, RequestContext } from "./types.js";

/**
 * Taste: what this person likes doing, and what this search is in the mood for. The person's
 * profile (kept on their device, sent with each search) weighs interests from -1 (skip) to 1
 * (love); a mood adds what it is in the mood for at MOOD_WEIGHT, without undoing a skip. A place or
 * event matches by its interests (core/interests.ts): the like it meets best, less the skip it meets
 * worst. Ranking only, never a gate.
 */

/** What each mood is in the mood for. */
export const MOOD_INTERESTS: Readonly<Record<Mood, readonly Interest[]>> = {
  relaxed: ["cafes", "outdoors", "books", "markets"],
  active: ["outdoors", "games", "sports"],
  food: ["food", "cafes", "markets"],
  culture: ["art", "museums", "theatre", "film", "live_music", "comedy"],
};

export const TASTE = {
  /** How much a mood likes what it is in the mood for. */
  moodWeight: 0.6,
  /**
   * A taste score from here up is a love (a like of 0.7 or more): one such option is kept on the first
   * page (select.ts). A mild like ("good food", 0.5) or a mood (0.6) is not a love.
   */
  loved: 0.85,
  /** The like from the person's own taste that earns the TASTE_MATCH reason. */
  reasonFrom: 0.5,
  /** Merit with a taste: the match leads, then appeal, fit and novelty (score.ts merit). */
  merit: { taste: 0.4, appeal: 0.3, fit: 0.2, novelty: 0.1 },
} as const;

interface Weight {
  /** What the search ranks by: the person's weight, raised to the mood's where the mood likes it more. */
  weight: number;
  /** The person's own weight (0 when only the mood likes it): what TASTE_MATCH may claim. */
  own: number;
}

/** The weights a search ranks by, or null when it has neither a taste nor a mood. */
export function tasteWeights(ctx: Pick<RequestContext, "taste" | "mood">): ReadonlyMap<Interest, Weight> | null {
  const out = new Map<Interest, Weight>();
  for (const [interest, weight] of ctx.taste ?? []) {
    if (weight === 0 || !Number.isFinite(weight)) continue;
    const w = Math.max(-1, Math.min(1, weight));
    out.set(interest, { weight: w, own: w });
  }
  for (const interest of ctx.mood ? MOOD_INTERESTS[ctx.mood] : []) {
    const w = out.get(interest);
    // A mood never overrides a skip, and never lowers a stronger like.
    if (!w) out.set(interest, { weight: TASTE.moodWeight, own: 0 });
    else if (w.weight >= 0 && w.weight < TASTE.moodWeight) out.set(interest, { weight: TASTE.moodWeight, own: w.own });
  }
  return out.size ? out : null;
}

export function candidateInterests(c: Candidate): InterestStrengths {
  const subtype = (c.facts.subtype?.value as { value?: unknown } | undefined)?.value;
  return interestsOf({ category: c.category, subtype: typeof subtype === "string" ? subtype : null, title: c.kind === "occurrence" ? (c.occurrence?.title ?? c.name) : null });
}

export interface TasteMatch {
  /** 0.5 neutral; up to 1 for a love, down to 0 for a skip. */
  score: number;
  /** The interest from the person's own taste it matches best, when that like is strong enough to say so. */
  lead: Interest | null;
}

export function tasteMatch(c: Candidate, weights: ReadonlyMap<Interest, Weight>): TasteMatch {
  let like = 0;
  let skip = 0;
  let lead: Interest | null = null;
  let leadOwn = 0;
  for (const [interest, strength] of Object.entries(candidateInterests(c)) as [Interest, number][]) {
    const w = weights.get(interest);
    if (!w) continue;
    const v = w.weight * strength;
    if (v > 0) like = Math.max(like, v);
    else skip = Math.max(skip, -v);
    const own = w.own * strength;
    if (own > leadOwn) {
      leadOwn = own;
      lead = interest;
    }
  }
  const match = like - skip;
  return { score: +(0.5 + 0.5 * match).toFixed(3), lead: leadOwn >= TASTE.reasonFrom && match > 0 ? lead : null };
}
