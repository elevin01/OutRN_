import { describe, expect, it } from "vitest";
import { sunsetOn } from "./load.js";

describe("sunset for the request's local day", () => {
  const bronxville = { lat: 40.941, lon: -73.835 };
  it("uses the local calendar day, not the UTC one", () => {
    // 10pm on Saturday 3 October in New York is already 4 October in UTC.
    const late = sunsetOn(bronxville, new Date("2026-10-04T02:00:00Z"), "America/New_York")!;
    const early = sunsetOn(bronxville, new Date("2026-10-03T14:00:00Z"), "America/New_York")!;
    expect(late.toISOString()).toBe(early.toISOString());
    // Around 6:35pm EDT.
    expect(late.getTime()).toBeGreaterThan(Date.parse("2026-10-03T22:25:00Z"));
    expect(late.getTime()).toBeLessThan(Date.parse("2026-10-03T22:45:00Z"));
  });
});
