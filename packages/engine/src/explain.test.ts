import { describe, expect, it } from "vitest";
import { caveatNotes, explain, reasonNotes } from "./explain.js";
import type { Evaluation, ReasonCode } from "./types.js";

const at = new Date("2026-10-03T22:30:00Z");
function evaluation(reasons: ReasonCode[], unresolved: string[]): Evaluation {
  return {
    candidate: { kind: "venue", id: "v", venueId: "v", name: "Bar", category: "bar", point: { lat: 40.72, lon: -73.99 }, timezone: "America/New_York", facts: { age_limit: { value: { minAge: 21 }, confidence: 0.5, evidenceClass: "estimate", validUntil: null, independentSources: 1 } }, boost: 0, excluded: false, hasLandmarkId: false },
    class: unresolved.length ? "check_first" : "ready",
    excludedBy: null,
    reasons,
    unresolved: unresolved as ReasonCode[],
    timing: { travel: { minutes: 8, mode: "walk", isEstimate: true, basis: "~8 min walk" }, departAt: at, arrival: new Date(at.getTime() + 8 * 60_000), latestArrival: null, latestArrivalIsEstimate: false, latestArrivalKind: null, latestFinish: new Date(at.getTime() + 120 * 60_000), usefulMinutes: 112, minUsefulMinutes: 45, minUsefulIsEstimate: true, closesAt: null, deadline: new Date(at.getTime() + 120 * 60_000), returnTravel: null, parkingMinutes: null, parking: null, visit: { style: "visit", minMinutes: 45, typicalMinutes: 60, isEstimate: true }, conditions: [] },
    scores: { evidence: 0.5, fit: 0.5, appeal: 0.5, novelty: 1 },
    cta: unresolved.length ? "check" : "go",
    price: { text: "price unknown", isEstimate: false, unknown: true },
  };
}

describe("reason and caveat notes", () => {
  it("the card sentence is built from the reason notes, in their order", () => {
    const e = evaluation(["ENOUGH_TIME", "SHORT_TRAVEL", "FREE", "FITS_BUDGET"], []);
    expect(reasonNotes(e, "America/New_York").map((n) => n.code)).toEqual(["SHORT_TRAVEL", "ENOUGH_TIME", "FREE"]);
    expect(explain(e, "America/New_York").sentence).toBe("A short walk, plenty of time, free.");
  });

  it("an estimated free reads 'usually free', as its fact line does; a published one reads 'free'", () => {
    const e = (isEstimate: boolean): Evaluation => ({ ...evaluation(["SHORT_TRAVEL", "FREE"], []), price: { text: "free", isEstimate, unknown: false } });
    expect(explain(e(true), "America/New_York").sentence).toBe("A short walk, usually free.");
    expect(explain(e(false), "America/New_York").sentence).toBe("A short walk, free.");
  });

  it("never drops a caveat: an unknown code still appears, by name", () => {
    const e = evaluation([], ["AGE_LIMIT_LIKELY", "SOMETHING_NEW"]);
    expect(caveatNotes(e)).toEqual([
      { code: "AGE_LIMIT_LIKELY", text: "probably 21+ only", params: { minAge: 21 } },
      { code: "SOMETHING_NEW", text: "something new", params: {} },
    ]);
    expect(explain(e, "America/New_York").caveat).toBe("Check first: probably 21+ only; something new");
  });
});
