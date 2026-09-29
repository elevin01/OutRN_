import { describe, expect, it } from "vitest";
import { fromLocal, type Attribute } from "@outrn/core";
import { evaluateAll, type Candidate, type CategoryPolicy, type RequestContext } from "@outrn/engine";
import { normalizeOsm } from "@outrn/ingest";

/**
 * From OSM tags to the engine's decision, without a database: what the normalizer infers from a
 * record has to survive into (or keep out of) recommendations. Policies as seeded (0002).
 */

const TZ = "America/New_York";
const POINT = { lat: 40.7295, lon: -73.9972 };
const POLICIES = new Map<string, CategoryPolicy>([["library", { category: "library", minUsefulMinutes: 45, admissionBufferMinutes: 5, kitchenCloseOffsetMinutes: null, lastEntryDefaultMinutes: null, activityType: "culture" }]]);
const NOW = fromLocal("2026-09-29", 14 * 60, TZ);

function candidate(tags: Record<string, string>): Candidate {
  const n = normalizeOsm({ externalId: "way/1", point: POINT, timezone: TZ, tags, sourceUpdatedAt: new Date("2026-08-01T00:00:00Z") }, NOW);
  const facts: Candidate["facts"] = {};
  for (const f of n.facts) facts[f.attribute as Attribute] = { value: f.value, confidence: f.confidence, evidenceClass: f.evidenceClass, validUntil: null, independentSources: 1, sources: ["osm"] };
  return { kind: "venue", id: "lib", venueId: "lib", name: n.name, category: n.category!, point: n.point, timezone: TZ, facts, boost: 0, excluded: false, hasLandmarkId: false, parentVenueId: null };
}

const ctx: RequestContext = { origin: { lat: 40.7285, lon: -73.9962 }, now: NOW, windowMinutes: 180, mode: "walk", timezone: TZ };
const decide = (tags: Record<string, string>) => evaluateAll([candidate(tags)], ctx, POLICIES)[0]!;

describe("a university library, from its tags to a recommendation", () => {
  const bobst = { name: "Elmer Holmes Bobst Library", amenity: "library", building: "university", operator: "New York University", opening_hours: "Mo-Su 09:00-22:00" };

  it("is members only when nothing says the public may use it", () => {
    expect(decide(bobst).excludedBy).toBe("MEMBERS_ONLY");
  });

  it("is an option when the record says the public may come in", () => {
    for (const access of ["yes", "permissive"]) {
      const e = decide({ ...bobst, access });
      expect(e.class, access).not.toBe("ineligible");
      expect(e.excludedBy, access).toBeNull();
    }
  });

  it("stays out when the record restricts it", () => {
    for (const access of ["private", "no", "members", "permit"]) expect(decide({ ...bobst, access }).excludedBy, access).toBe("MEMBERS_ONLY");
  });
});
