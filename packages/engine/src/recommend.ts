import type { Candidate, CategoryPolicy, Evaluation, RequestContext, Shortlist } from "./types.js";
import { evaluateFeasibility } from "./feasibility.js";
import { scoreCandidate } from "./score.js";
import { selectShortlist } from "./select.js";

/**
 * Pure orchestration: candidates in, shortlist out. No I/O, so the correctness suite runs on
 * fixtures and the backtest can replay thousands of contexts in-process.
 */

const DEFAULT_MAX_TRAVEL: Record<RequestContext["mode"], number> = { walk: 25, drive: 30, transit: 35 };

export function evaluateAll(candidates: Candidate[], ctx: RequestContext, policies: Map<string, CategoryPolicy>): Evaluation[] {
  const maxTravel = ctx.maxTravelMinutes ?? DEFAULT_MAX_TRAVEL[ctx.mode];
  const fallback: CategoryPolicy = { category: "other", minUsefulMinutes: 45, admissionBufferMinutes: 5, kitchenCloseOffsetMinutes: null, lastEntryDefaultMinutes: null, activityType: "browse" };
  return candidates.map((c) => {
    const policy = policies.get(c.category) ?? fallback;
    const f = evaluateFeasibility(c, ctx, policy);
    if (f.class === "ineligible" || !f.timing) {
      return { candidate: c, class: "ineligible", excludedBy: f.excludedBy, reasons: f.reasons, unresolved: f.unresolved, timing: f.timing, scores: { evidence: 0, fit: 0, appeal: 0, novelty: 0 }, cta: null, price: f.price };
    }
    const { scores, extraReasons } = scoreCandidate(c, ctx, f, policy, maxTravel);
    return { candidate: c, class: f.class, excludedBy: null, reasons: [...f.reasons, ...extraReasons], unresolved: f.unresolved, timing: f.timing, scores, cta: f.cta, price: f.price };
  });
}

export function recommend(candidates: Candidate[], ctx: RequestContext, policies: Map<string, CategoryPolicy>, opts: { size?: number; offset?: number } = {}): Shortlist {
  const all = evaluateAll(candidates, ctx, policies);
  return selectShortlist(all, ctx, opts);
}
