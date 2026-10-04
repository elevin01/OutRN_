import type { TasteWeight } from "@outrn/contracts";

/**
 * What this person likes doing, kept on this device and sent with each search (`request.taste`).
 * Quick picks on first open set it; what they do with an option nudges it: going, saving, and turning
 * one down ("Not for me"), through the interests the card says it is (`item.interests`). The API
 * stores the sent weights in paging snapshots alongside each search's results. Expired snapshots
 * become eligible for cleanup after another 24 hours; cleanup runs on subsequent searches.
 * Nothing here records which options were seen or chosen.
 */
export interface Taste {
  /** Whether the quick picks were shown (answered or skipped), so they are offered once. */
  asked: boolean;
  /** Interest id → weight, -1 (skip) to 1 (love). No zeros. */
  weights: Readonly<Record<string, number>>;
}

export type Signal = "go" | "save" | "unsave" | "not_for_me";

export type Pick = "like" | "skip" | "none";

/** How far one action moves an interest's weight. Going says most; turning one down a little. */
export const NUDGE: Readonly<Record<Signal, number>> = {
  go: 0.2,
  save: 0.1,
  unsave: -0.1,
  not_for_me: -0.15,
};

/** A quick pick's weight: a like is a love (the first page keeps one), a skip sinks. */
export const PICK_WEIGHT = 0.8;

/** At most this many interests (the API's limits.maxTaste). */
export const MAX_TASTE = 32;

/** An option counts for at most its first two interests: what it is, not where it happens. */
const LEARN_FROM = 2;

const ID = /^[a-z][a-z_]{0,39}$/;

export const EMPTY_TASTE: Taste = { asked: false, weights: {} };

const clamp = (w: number) => Math.max(-1, Math.min(1, Math.round(w * 100) / 100));

function own(weights: Readonly<Record<string, number>>, id: string): number {
  return Object.prototype.hasOwnProperty.call(weights, id) ? weights[id]! : 0;
}

function withWeight(
  weights: Readonly<Record<string, number>>,
  id: string,
  weight: number,
): Record<string, number> {
  const out: Record<string, number> = Object.create(null);
  for (const [k, v] of Object.entries(weights)) if (k !== id) out[k] = v;
  const w = clamp(weight);
  if (w !== 0 && Object.keys(out).length < MAX_TASTE) out[id] = w;
  return out;
}

/** A stored profile, or the empty one when it is missing or unreadable. Never trusts its shape. */
export function parseTaste(raw: unknown): Taste {
  if (!raw || typeof raw !== "object") return EMPTY_TASTE;
  const r = raw as { asked?: unknown; weights?: unknown };
  const weights: Record<string, number> = Object.create(null);
  if (r.weights && typeof r.weights === "object" && !Array.isArray(r.weights)) {
    for (const [k, v] of Object.entries(r.weights)) {
      if (Object.keys(weights).length >= MAX_TASTE) break;
      if (!ID.test(k) || typeof v !== "number" || !Number.isFinite(v)) continue;
      const w = clamp(v);
      if (w !== 0) weights[k] = w;
    }
  }
  return { asked: r.asked === true, weights };
}

/** What a quick pick shows for an interest. */
export function pickOf(taste: Taste, id: string): Pick {
  const w = own(taste.weights, id);
  return w >= 0.5 ? "like" : w <= -0.5 ? "skip" : "none";
}

/** Tapping a quick pick: none → like → skip → none. */
export function nextPick(pick: Pick): Pick {
  return pick === "none" ? "like" : pick === "like" ? "skip" : "none";
}

export function setPick(taste: Taste, id: string, pick: Pick): Taste {
  if (!ID.test(id)) return taste;
  const weight = pick === "like" ? PICK_WEIGHT : pick === "skip" ? -PICK_WEIGHT : 0;
  return { ...taste, weights: withWeight(taste.weights, id, weight) };
}

/** One action on an option nudges the interests it is. */
export function learn(taste: Taste, interests: readonly string[], signal: Signal): Taste {
  let weights = taste.weights;
  for (const id of interests.filter((i) => ID.test(i)).slice(0, LEARN_FROM)) {
    weights = withWeight(weights, id, own(weights, id) + NUDGE[signal]);
  }
  return weights === taste.weights ? taste : { ...taste, weights };
}

/** The taste a search sends: offered interests only, strongest first, within the API's limit. */
export function requestTaste(taste: Taste, offered?: readonly string[]): TasteWeight[] {
  const allowed = offered ? new Set(offered) : null;
  return Object.entries(taste.weights)
    .filter(([id, w]) => w !== 0 && (!allowed || allowed.has(id)))
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]) || a[0].localeCompare(b[0]))
    .slice(0, MAX_TASTE)
    .map(([interest, weight]) => ({ interest, weight }));
}
