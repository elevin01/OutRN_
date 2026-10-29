import { describe, expect, it } from "vitest";
import { aerialOf, inNewYork } from "./aerial.js";

describe("an aerial photo of a place's spot", () => {
  it("is for places in New York only: the state's imagery stops at its line", () => {
    const ny: [string, number, number][] = [
      ["Seward Park, Lower East Side", 40.7146, -73.989],
      ["New York Botanical Garden, the Bronx", 40.8623, -73.877],
      ["The Capitol Theatre, Port Chester", 41.0016, -73.6658],
      ["Columbus Park, Port Chester, by the Byram River", 40.99445, -73.6627],
      ["Monument Park, Port Chester", 40.99649, -73.65985],
      ["Yonkers waterfront", 40.9356, -73.9024],
      ["Tarrytown", 41.0762, -73.8587],
    ];
    const not: [string, number, number][] = [
      ["Greenwich Common, Connecticut", 41.02815, -73.6254],
      ["Byram Shubert Library, Greenwich", 41.001, -73.6553],
      ["Stamford, Connecticut", 41.0534, -73.5387],
      ["Fort Lee, New Jersey", 40.8509, -73.9701],
      ["Edgewater, New Jersey", 40.827, -73.9757],
      ["Albany: beyond the outline's region", 42.6526, -73.7562],
    ];
    for (const [name, lat, lon] of ny) expect(inNewYork({ lat, lon }), name).toBe(true);
    for (const [name, lat, lon] of not) expect(inNewYork({ lat, lon }), name).toBe(false);
    expect(inNewYork({ lat: Number.NaN, lon: -73.9 })).toBe(false);
  });

  it("is the state's own image of a box centred on the place, wider for a park, the same URL every time", () => {
    const theatre = aerialOf({ lat: 41.0016, lon: -73.6658 }, "theatre")!;
    expect(theatre).toMatchObject({ width: 800, height: 500, credit: "NYS ITS Geospatial Services orthoimagery", sourceUrl: "https://gis.ny.gov/orthoimagery" });
    const u = new URL(theatre.url);
    expect(`${u.protocol}//${u.host}${u.pathname}`).toBe("https://orthos.its.ny.gov/arcgis/rest/services/wms/Latest/MapServer/export");
    const box = (url: string) => new URL(url).searchParams.get("bbox")!.split(",").map(Number);
    const [x0, y0, x1, y1] = box(theatre.url);
    expect([x1! - x0!, y1! - y0!]).toEqual([160, 100]);
    const park = box(aerialOf({ lat: 41.0016, lon: -73.6658 }, "park")!.url);
    expect(park[2]! - park[0]!).toBe(400);
    expect(aerialOf({ lat: 41.0016, lon: -73.6658 }, "theatre")!.url).toBe(theatre.url);
    expect(aerialOf({ lat: 41.02815, lon: -73.6254 }, "park")).toBeNull();
  });
});
