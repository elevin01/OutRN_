import { KID_FACILITIES, type KidFacilities, type KidFacility, type KidFacilityLevel, type Restroom } from "@outrn/core";
import { partyYoungest } from "./feasibility.js";
import type { Candidate, ReasonCode, RequestContext } from "./types.js";

/**
 * Restrooms and what a place has for children, weighed by who is going: an accessible restroom
 * matters to a wheelchair user, high chairs to a toddler, neither to anyone else. What matters lifts
 * appeal a little and gives the card a reason; no restroom sinks a place for young children a little.
 * None of it excludes. Policy, not fact. (An inaccessible restroom is a caveat: see feasibility.)
 */
export const AMENITIES = {
  /** A facility is worth saying when the youngest is under this age, or a family's ages are unknown. */
  kidFacilityUnder: { highchair: 5, changing_table: 3, kids_area: 12 } satisfies Record<KidFacility, number>,
  /** No restroom counts against a place when the youngest is under this age, or a family's ages are unknown. */
  restroomNeededUnder: 10,
  appeal: 0.05,
} as const;

/** The card's reason for each facility. */
export const KID_FACILITY_REASON: Readonly<Record<KidFacility, ReasonCode>> = { highchair: "HIGH_CHAIRS", changing_table: "CHANGING_TABLE", kids_area: "KIDS_AREA" };

const record = <T>(c: Candidate, a: "restroom" | "kid_facilities"): T => {
  const v = c.facts[a]?.value;
  return (v && typeof v === "object" && !Array.isArray(v) ? v : {}) as T;
};

/** Its restroom as its facts state it; empty when unknown. */
export const restroomOf = (c: Candidate): Restroom => record<Restroom>(c, "restroom");

/** Whether the youngest going is under `age`: a known age, or a family whose ages we don't know. */
export function youngestUnder(ctx: RequestContext, age: number): boolean {
  const youngest = partyYoungest(ctx);
  return youngest === "minor" || (typeof youngest === "number" && youngest < age);
}

/** What its record says it has for children; empty when unknown. */
export const kidFacilityLevels = (c: Candidate): KidFacilities => record<KidFacilities>(c, "kid_facilities");

/**
 * What its record says it has for children that matters to this party, in card order, and how much:
 * "limited" is somewhere to change a diaper that isn't a table, or a limited kids' area.
 */
export function kidFacilitiesFor(c: Candidate, ctx: RequestContext): { facility: KidFacility; level: KidFacilityLevel }[] {
  const has = kidFacilityLevels(c);
  return (Object.keys(KID_FACILITIES) as KidFacility[]).flatMap((facility) => {
    const level = has[facility];
    return (level === "yes" || level === "limited") && youngestUnder(ctx, AMENITIES.kidFacilityUnder[facility]) ? [{ facility, level }] : [];
  });
}
