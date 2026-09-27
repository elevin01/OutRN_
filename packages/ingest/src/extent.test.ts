import { describe, expect, it } from "vitest";
import { ingestExtentFor } from "./pipeline.js";

describe("ingest extent", () => {
  it("a drive catchment ingests its origin radius plus the farthest a 30-minute drive can reach", () => {
    const westchester = { defaultMinutes: 8, byHour: [{ from: 18, to: 6, minutes: 5 }] };
    const e = ingestExtentFor({ radius_m: 1500, travel_mode: "drive" }, westchester);
    expect(e.reachM).toBeGreaterThan(13_000); // 45 km/h after 22:00, 5-min evening parking buffer
    expect(e.radiusM).toBe(14_900);
    // Without the parking rule the default 8-min buffer applies all day.
    expect(ingestExtentFor({ radius_m: 1500, travel_mode: "drive" }, null).radiusM).toBe(13_300);
  });

  it("a walk catchment ingests about one walk-reach past its edge", () => {
    expect(ingestExtentFor({ radius_m: 1500, travel_mode: "walk" }, null).radiusM).toBe(3_100);
  });
});
