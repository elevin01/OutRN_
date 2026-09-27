import { describe, expect, it } from "vitest";
import { buildAreaQuery } from "./overpass.js";
import { OSM_CATEGORY_KEYS, OSM_QUALIFIED_TAGS, OSM_TAG_CATEGORIES } from "./osm-tags.js";

describe("Overpass area query", () => {
  it("fetches every tag value normalization maps (no drift between query and mapping)", () => {
    const q = buildAreaQuery({ lat: 40.941, lon: -73.835 }, 14_900);
    for (const key of OSM_CATEGORY_KEYS) {
      const clause = q.split("\n").find((l) => l.includes(`["${key}"~`));
      expect(clause, key).toBeDefined();
      for (const value of Object.keys(OSM_TAG_CATEGORIES[key])) expect(clause).toMatch(new RegExp(`[(|]${value}[|)]`));
    }
    for (const t of OSM_QUALIFIED_TAGS) expect(q).toContain(`["${t.key}"="${t.value}"]["${t.qualifierKey}"~"${t.qualifierPattern}"]`);
    expect(q).toContain("(around:14900,40.94100,-73.83500)");
    expect(q).toContain("[timeout:180]");
  });
});
