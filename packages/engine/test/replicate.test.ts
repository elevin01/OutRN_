import { describe, expect, it } from "vitest";
import type { Candidate } from "../src/index.js";
import { replicate } from "../scripts/replicate.js";

const candidate = (id: string): Candidate => ({ kind: "venue", id, venueId: id, name: id, category: "cafe", point: { lat: 40.94, lon: -73.83 }, timezone: "America/New_York", facts: {}, boost: 0, excluded: false, hasLandmarkId: false });

describe("benchmark replication", () => {
  it("refuses an empty base instead of looping forever", () => {
    expect(() => replicate([], 1_000)).toThrow(/no candidates/);
  });

  it("makes exactly the target number of distinct candidates", () => {
    const out = replicate([candidate("a"), candidate("b"), candidate("c")], 10);
    expect(out).toHaveLength(10);
    expect(new Set(out.map((c) => c.id)).size).toBe(10);
    expect(replicate([candidate("a")], 0)).toEqual([]);
  });
});
