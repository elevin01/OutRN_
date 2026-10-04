import { describe, expect, it } from "vitest";
import { RecommendationItem } from "@outrn/contracts";
import { evaluateAll, type Candidate, type CategoryPolicy, type RequestContext } from "@outrn/engine";
import { toItem } from "./item.js";

const TZ = "America/New_York";
const AT = { lat: 40.7185, lon: -73.988 };
const POLICIES = new Map<string, CategoryPolicy>([["park", { category: "park", minUsefulMinutes: 45, admissionBufferMinutes: 5, kitchenCloseOffsetMinutes: null, lastEntryDefaultMinutes: null, activityType: "outdoors" }]]);

/** A park with no listed hours, as OSM usually has it. */
function park(closure?: string): Candidate {
  const facts: Candidate["facts"] = {
    name: { value: { value: "Corner Park" }, confidence: 0.9, evidenceClass: "published", validUntil: null, independentSources: 1 },
    business_status: { value: { status: "operating" }, confidence: 0.8, evidenceClass: "published", validUntil: null, independentSources: 1 },
    admission: { value: { requirement: "walk_in" }, confidence: 0.8, evidenceClass: "published", validUntil: null, independentSources: 1 },
  };
  if (closure) facts.scheduled_closure = { value: { at: closure }, confidence: 0.9, evidenceClass: "published", validUntil: null, independentSources: 1 };
  return { kind: "venue", id: "p", venueId: "p", name: "Corner Park", category: "park", point: AT, timezone: TZ, facts, boost: 0, excluded: false, hasLandmarkId: false, parentVenueId: null, brand: null };
}

const ctx = (now: string): RequestContext => ({ origin: AT, now: new Date(now), windowMinutes: 180, mode: "walk", timezone: TZ });
const item = (c: Candidate, x: RequestContext) => RecommendationItem.parse(toItem(evaluateAll([c], x, POLICIES)[0]!, x));
const step = (i: RecommendationItem, kind: string) => i.plan.find((s) => s.kind === kind)!;

describe("a park's inferred dawn-to-dusk hours on the public item", () => {
  it("keeps dusk an estimate: no published closing time, a required note, an estimated wrap-up", () => {
    const i = item(park(), ctx("2026-10-03T21:00:00Z")); // 5pm; sunset ~6:36pm
    const dusk = new Date(i.timing.finishBy);
    expect(dusk.getTime()).toBeGreaterThan(Date.parse("2026-10-03T22:20:00Z"));
    expect(dusk.getTime()).toBeLessThan(Date.parse("2026-10-03T22:50:00Z"));
    // Existing clients render timing.closesAt as "Closes 6:36pm": a guess must not reach it.
    expect(i.timing.closesAt).toBeNull();
    const note = i.reasons.find((r) => r.code === "DAWN_TO_DUSK")!;
    expect(note.required).toBe(true);
    expect(note.params).toMatchObject({ duskAt: dusk.toISOString(), isEstimate: true });
    expect(i.copy.summary).toMatch(/until dusk \(~6:\d\dpm\)/);
    const wrap = step(i, "wrap_up");
    expect(wrap.at).toBe(i.timing.finishBy);
    expect(wrap.isEstimate).toBe(true);
    expect(wrap.text).toMatch(/^Wrap up by 6:\d\dpm, around dusk$/);
    expect(i.plan.map((s) => s.text).join(" ")).not.toMatch(/when it closes/);
  });

  it("says an opening at sunrise is an estimate too", () => {
    const i = item(park(), ctx("2026-10-03T10:00:00Z")); // 6am; sunrise ~6:55am
    const opens = i.reasons.find((r) => r.code === "WAIT_FOR_OPENING")!;
    expect(opens.text).toMatch(/^opens around sunrise \(~6:\d\dam\)$/);
    expect(opens.params).toMatchObject({ opensAt: i.timing.arriveAt, isEstimate: true });
    const arrive = step(i, "arrive");
    expect(arrive.isEstimate).toBe(true);
    expect(arrive.text).toMatch(/^Arrive around sunrise, 6:\d\dam$/);
    expect(i.plan.map((s) => s.text).join(" ")).not.toMatch(/as it opens/);
  });

  it("closes at a published closure before dusk, and timing, summary and plan agree", () => {
    const sixPm = "2026-10-03T22:00:00.000Z";
    const i = item(park(sixPm), ctx("2026-10-03T21:00:00Z"));
    expect(i.timing.finishBy).toBe(sixPm);
    expect(i.timing.closesAt).toBe(sixPm);
    expect(i.copy.summary).toMatch(/until 6pm/);
    expect(i.copy.summary).not.toMatch(/dusk/);
    const wrap = step(i, "wrap_up");
    expect(wrap).toMatchObject({ at: sixPm, isEstimate: false, text: "Wrap up by 6pm, when it closes" });
  });
});
