import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildAreaQuery, loadAreaFromFile, normalizeElements, osmDataAgeDays } from "./overpass.js";
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

describe("parking", () => {
  it("is fetched named or not, and kept without a name; other nameless elements are still dropped", () => {
    expect(buildAreaQuery({ lat: 40.941, lon: -73.835 }, 1_000)).toContain(`nwr["amenity"="parking"](around:1000,40.94100,-73.83500);`);
    const { elements, dropped } = normalizeElements({
      elements: [
        { type: "node", id: 1, lat: 40.94, lon: -73.83, tags: { amenity: "parking", fee: "no" } },
        { type: "way", id: 2, center: { lat: 40.94, lon: -73.83 }, tags: { amenity: "parking", parking: "multi-storey", name: "Garage" } },
        { type: "node", id: 3, lat: 40.94, lon: -73.83, tags: { amenity: "restaurant" } },
      ],
    });
    expect(elements.map((e) => e.externalId)).toEqual(["node/1", "way/2"]);
    expect(dropped).toBe(1);
  });
});


describe("a saved capture's extent", () => {
  const saved = (extent: string) => {
    const path = join(mkdtempSync(join(tmpdir(), "outrn-")), "capture.json");
    // Written as text: JSON.parse reads 1e999 as Infinity.
    writeFileSync(path, `{"elements": [], "outrn_extent": ${extent}}`);
    return path;
  };

  it("is read back as the circle it was saved with", async () => {
    expect((await loadAreaFromFile(saved(`{"lat": 40.7185, "lon": -73.988, "radius_m": 1500}`))).extent).toEqual({ lat: 40.7185, lon: -73.988, radiusM: 1500 });
  });

  it("is refused when it could not be a circle on the map: an endless, empty or negative radius, a point off the globe", async () => {
    for (const extent of [
      `{"lat": 40.7185, "lon": -73.988, "radius_m": 1e999}`,
      `{"lat": 40.7185, "lon": -73.988, "radius_m": 0}`,
      `{"lat": 40.7185, "lon": -73.988, "radius_m": -1500}`,
      `{"lat": 140.7, "lon": -73.988, "radius_m": 1500}`,
      `{"lat": 40.7185, "lon": -273.9, "radius_m": 1500}`,
    ]) {
      await expect(loadAreaFromFile(saved(extent)), extent).rejects.toThrow();
    }
  });
});

describe("how old a mirror's data is", () => {
  const at = new Date("2026-10-18T00:43:00Z");
  it("is the time since its base, in days, and unknown when it doesn't say", () => {
    expect(osmDataAgeDays({ osm3s: { timestamp_osm_base: "2026-10-18T00:41:00Z" }, elements: [] }, at)).toBeCloseTo(2 / 1440, 6);
    // One of a public mirror's servers, answering in October with June's data.
    expect(Math.floor(osmDataAgeDays({ osm3s: { timestamp_osm_base: "2026-06-01T08:52:28Z" }, elements: [] }, at)!)).toBe(138);
    expect(osmDataAgeDays({ elements: [] }, at)).toBeNull();
    expect(osmDataAgeDays({ osm3s: { timestamp_osm_base: "yesterday" }, elements: [] }, at)).toBeNull();
  });
});
