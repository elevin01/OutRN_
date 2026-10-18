import { maxTravelFor } from "./destination.js";
import { markDetours } from "./detour.js";
import type { Candidate, CategoryPolicy, Evaluation, RequestContext, Shortlist } from "./types.js";
import { evaluateFeasibility } from "./feasibility.js";
import { markLikelyOpen, openShares } from "./likely.js";
import { ageDoubtIn, scoreCandidate } from "./score.js";
import { tasteWeights } from "./taste.js";
import { selectShortlist } from "./select.js";

/**
 * Pure orchestration: candidates in, shortlist out. No I/O, so the correctness suite runs on
 * fixtures and the backtest can replay thousands of contexts in-process.
 */

export function evaluateAll(candidates: Candidate[], ctx: RequestContext, policies: Map<string, CategoryPolicy>): Evaluation[] {
  const fallback: CategoryPolicy = { category: "other", minUsefulMinutes: 45, admissionBufferMinutes: 5, kitchenCloseOffsetMinutes: null, lastEntryDefaultMinutes: null, activityType: "browse" };
  const weights = tasteWeights(ctx);
  // Events only: places are not candidates at all, so nothing about them is weighed or logged.
  const pool = ctx.eventsOnly ? candidates.filter((c) => c.kind === "occurrence") : candidates;
  const evals: Evaluation[] = pool.map((c) => {
    const policy = policies.get(c.category) ?? fallback;
    const f = evaluateFeasibility(c, ctx, policy);
    // A nudge is not asked for, and shows no caveat it can be read by: it never offers an event that
    // may turn someone in the party away (a wine tasting to a family), which a search would only mark Check first.
    const ageDoubt = ctx.eventsOnly === true && ageDoubtIn(f.unresolved);
    if (f.class === "ineligible" || !f.timing || ageDoubt) {
      return { candidate: c, class: "ineligible", excludedBy: f.excludedBy ?? "AGE_RESTRICTED", reasons: f.reasons, unresolved: f.unresolved, timing: f.timing, scores: { evidence: 0, fit: 0, appeal: 0, novelty: 0 }, cta: null, price: f.price };
    }
    const { scores, extraReasons, dayPart, tasteLead } = scoreCandidate(c, ctx, f, policy, maxTravelFor(c, ctx), weights);
    return { candidate: c, class: f.class, excludedBy: null, reasons: [...f.reasons, ...extraReasons], unresolved: f.unresolved, timing: f.timing, scores, cta: f.cta, price: f.price, dayPart, tasteLead };
  });
  markLikelyOpen(evals, openShares(candidates, policies, fallback.minUsefulMinutes));
  markDetours(evals, ctx);
  return evals;
}

export function recommend(candidates: Candidate[], ctx: RequestContext, policies: Map<string, CategoryPolicy>, opts: { size?: number; offset?: number; maxOffset?: number } = {}): Shortlist {
  const all = evaluateAll(candidates, ctx, policies);
  return selectShortlist(all, ctx, opts);
}
