import { addMinutes } from "@outrn/core";
import { evaluateHours, isHoursValue, type HoursValue } from "@outrn/facts";
import type { Candidate, CategoryPolicy, Evaluation } from "./types.js";

/**
 * A place that lists no hours, when most places of its kind around here that do list theirs are open
 * when one would get there: a downtown restaurant at 7:30 on a Saturday. Most places list none (in
 * White Plains, nine in ten), so without this the few that do lead every list however far they are.
 *
 * It ranks with the Ready options and stays Check first: the card still says its hours are unknown,
 * and why it is offered anyway ("most places like it nearby are open then, 77 of 85 that list
 * hours"). Its merit pays for having to check (`checkCost`) and for the chance it is shut
 * (`missCost` for a sure miss, the cost of finding another place nearby): a likely-open place a short
 * drive away comes before a Ready one across the county, never before a Ready one about as good and
 * as near. Only when its hours are the one thing to check, a source says it still operates (a place
 * that lists no hours is often one no one has looked at in years), and on a sample big enough to
 * mean something.
 */
export const LIKELY_OPEN = { minListed: 8, minShare: 0.8, checkCost: 0.02, missCost: 0.25 } as const;

export interface OpenShare {
  /** Places of the kind that list hours and are open then. */
  open: number;
  /** Places of the kind that list hours (published, read exactly). */
  listed: number;
}

/** Arrivals are bucketed to this many minutes: places of a kind open or close on the hour or half hour. */
const SLOT_MINUTES = 15;

/**
 * Whether a place's hours say anything about its kind then: not one closed, temporarily or for good
 * (by any source, or a published closing date by the end of the visit), taken out by the founder, or
 * open only to members. Its hours would count it open when no one can go.
 */
function availablePeer(c: Candidate, at: Date): boolean {
  if (c.excluded) return false;
  const status = (c.facts.business_status?.value as { status?: unknown } | undefined)?.status;
  if (typeof status === "string" && status.startsWith("closed")) return false;
  const closure = c.facts.scheduled_closure;
  const closesAt = closure && closure.evidenceClass !== "estimate" ? (closure.value as { at?: unknown }).at : undefined;
  if (typeof closesAt === "string" && new Date(closesAt).getTime() <= at.getTime()) return false;
  return (c.facts.admission?.value as { requirement?: unknown } | undefined)?.requirement !== "members_only";
}

/**
 * For each kind of place, the share of those that list hours (published, not estimated, read exactly)
 * and are open for the kind's shortest useful visit from any arrival in the 15 minutes: open at the
 * slot's start and still open its shortest visit after the slot's end, so no arrival it stands for is
 * promised more than its peers give. Every loaded place counts, however far: they are the same town's
 * habits.
 */
export function openShares(candidates: readonly Candidate[], policies: Map<string, CategoryPolicy>, fallbackMinUseful: number): (category: string, arrival: Date) => OpenShare {
  const listed = new Map<string, Candidate[]>();
  for (const c of candidates) {
    if (c.kind === "occurrence") continue;
    const f = c.facts.opening_hours;
    if (!f || f.evidenceClass === "estimate" || !isHoursValue(f.value)) continue;
    const list = listed.get(c.category) ?? [];
    list.push(c);
    listed.set(c.category, list);
  }
  const memo = new Map<string, OpenShare>();
  return (category, arrival) => {
    const slot = new Date(Math.floor(arrival.getTime() / (SLOT_MINUTES * 60_000)) * SLOT_MINUTES * 60_000);
    const key = `${category}@${slot.getTime()}`;
    const hit = memo.get(key);
    if (hit) return hit;
    const until = addMinutes(slot, SLOT_MINUTES + (policies.get(category)?.minUsefulMinutes ?? fallbackMinUseful));
    const share: OpenShare = { open: 0, listed: 0 };
    for (const c of listed.get(category) ?? []) {
      if (!availablePeer(c, until)) continue;
      const hours = c.facts.opening_hours!.value as HoursValue;
      const at = evaluateHours(hours, slot, c.timezone, c.point);
      if (at.parseError || at.approximate) continue;
      share.listed++;
      if (at.always || (at.openNow && at.interval && at.interval.close >= until)) share.open++;
    }
    memo.set(key, share);
    return share;
  };
}

/** Mark the Check-first places whose hours are all there is to check, and whose kind is open then. */
export function markLikelyOpen(evals: Evaluation[], shareAt: (category: string, arrival: Date) => OpenShare): void {
  for (const e of evals) {
    if (e.class !== "check_first" || e.candidate.kind === "occurrence" || !e.timing) continue;
    if (e.unresolved.length !== 1 || e.unresolved[0] !== "HOURS_UNKNOWN") continue;
    const status = e.candidate.facts.business_status;
    if (!status || status.evidenceClass === "estimate" || (status.value as { status?: unknown } | null)?.status !== "operating") continue;
    const s = shareAt(e.candidate.category, e.timing.arrival);
    if (s.listed < LIKELY_OPEN.minListed || s.open < LIKELY_OPEN.minShare * s.listed) continue;
    e.likelyOpen = s;
    e.reasons.push("LIKELY_OPEN");
  }
}
