import { describe, expect, it } from "vitest";
import type { OverturePlace } from "@outrn/sources";
import { curatedRecord, destinationGate, parseDestinationsCapture, placeWords, recordsRead, selectDestinations, tilesAround, type CuratedDestination } from "./destinations.js";

let n = 0;
function place(over: Partial<OverturePlace> = {}): OverturePlace {
  return {
    id: over.id ?? `p${++n}`,
    name: "Teatown Lake Reservation",
    lat: 41.211,
    lon: -73.827,
    category: "nature_reserve",
    status: "open",
    statusSignal: null,
    statusUpdatedAt: null,
    confidence: 0.97,
    websites: ["https://www.teatown.org/"],
    phones: [],
    updatedAt: "2026-08-01T00:00:00.000Z",
    datasets: ["meta"],
    licenses: ["CDLA-Permissive-2.0"],
    ...over,
  };
}

const UNTERMYER: CuratedDestination = { name: "Untermyer Gardens", aliases: ["untermyer gardens"], at: { lat: 40.966, lon: -73.89 }, kind: "garden", note: "a walled Persian garden and a temple above the Hudson" };

describe("destinations from places", () => {
  it("admits a record that says it is a preserve, sure of itself and with a website; not a ball field, a guess or a triangle", () => {
    expect(destinationGate(place())).toEqual({ kind: "nature" });
    expect(destinationGate(place({ category: "park", name: "Cranberry Lake Preserve" }))).toEqual({ kind: "nature" });
    // A park is a destination only when its name says what kind: "Glen Island Park" is for the list.
    expect(destinationGate(place({ category: "park", name: "Glen Island Park" }))).toEqual({ skip: "category" });
    expect(destinationGate(place({ confidence: 0.8 }))).toEqual({ skip: "confidence" });
    expect(destinationGate(place({ websites: [] }))).toEqual({ skip: "contact" });
    expect(destinationGate(place({ status: "permanently_closed" }))).toEqual({ skip: "status" });
    expect(destinationGate(place({ name: "Devanney Triangle Preserve" }))).toEqual({ skip: "name" });
    // Overture files plazas, fountains and village greens as nature reserves too: the name must say it.
    expect(destinationGate(place({ name: "Hamilton Fountain" }))).toEqual({ skip: "category" });
    expect(destinationGate(place({ name: "Bowling Green" }))).toEqual({ skip: "category" });
    // An organization, and a famous name filed far from where it is.
    expect(destinationGate(place({ name: "New Jersey Audubon Society" }))).toEqual({ skip: "name" });
    expect(destinationGate(place({ name: "Catskill Forest Preserve" }))).toEqual({ skip: "name" });
    expect(destinationGate(place({ name: "Saxon Woods Park Field 3", category: "park" }))).toEqual({ skip: "category" });
    expect(destinationGate(place({ name: "Teatown Preserve Parking" }))).toEqual({ skip: "name" });
    // Beaches come only from the list: Overture files some far away (and private ones) under local points.
    expect(destinationGate(place({ category: "beach", name: "South Beach Miami, Fl" }))).toEqual({ skip: "category" });
  });

  it("leaves out Long Island's north shore: close as the crow flies, an hour by road", () => {
    expect(destinationGate(place({ name: "Sands Point Preserve", lat: 40.857, lon: -73.699 }))).toEqual({ skip: "across" });
    // Pelham Bay and Glen Island are the mainland side of the Sound.
    expect(destinationGate(place({ name: "Hunter Island Sanctuary", lat: 40.877, lon: -73.792 }))).toEqual({ kind: "nature" });
  });

  it("finds a curated place by its name nearest where the list puts it, not a namesake misplaced a few km off", () => {
    const right = place({ id: "right", name: "Untermyer Gardens Conservancy", category: "park", lat: 40.9663, lon: -73.8878, confidence: 0.926 });
    const misplaced = place({ id: "misplaced", name: "Untermyer Gardens Conservancy", category: "park", lat: 40.9339, lon: -73.9003, confidence: 0.972 });
    const far = place({ id: "far", name: "Untermyer Gardens", lat: 41.2, lon: -73.9 });
    expect(curatedRecord(UNTERMYER, [misplaced, right, far])?.id).toBe("right");
    expect(curatedRecord(UNTERMYER, [far])).toBeNull();
    // Names compare as name keys: "The Met Cloisters" is filed as "met cloisters".
    const cloisters: CuratedDestination = { name: "The Met Cloisters", aliases: ["the met cloisters"], at: { lat: 40.865, lon: -73.932 }, kind: "estate", note: "medieval art" };
    expect(curatedRecord(cloisters, [place({ id: "c", name: "The Met Cloisters", category: "museum", lat: 40.8585, lon: -73.9296 })])?.id).toBe("c");
  });

  it("prefers the category the list expects over a namesake filed as something else", () => {
    const entry: CuratedDestination = { name: "Pelham Bay Park", aliases: ["pelham bay park"], at: { lat: 40.865, lon: -73.807 }, kind: "park", note: "the city's largest park", categories: ["park"] };
    const dogRun = place({ id: "dog", name: "Pelham Bay Park", category: "dog_park", lat: 40.866, lon: -73.807, confidence: 0.97 });
    const park = place({ id: "park", name: "Pelham Bay Park", category: "park", lat: 40.851, lon: -73.822, confidence: 0.83 });
    expect(curatedRecord(entry, [dogRun, park])?.id).toBe("park");
  });

  it("selects each place once: the curated one with its own name and note, and a record filed twice only once", () => {
    const curated = place({ id: "u", name: "Untermyer Gardens Conservancy", category: "park", lat: 40.9663, lon: -73.8878 });
    const teatown = place({ id: "t1", confidence: 0.97 });
    const teatownAgain = place({ id: "t2", name: "Teatown Lake Reservation Nature Center", lat: 41.215, confidence: 0.95 });
    const { destinations, missing } = selectDestinations([teatownAgain, curated, teatown], [UNTERMYER, { ...UNTERMYER, name: "Nowhere Gardens", aliases: ["nowhere gardens"] }]);
    expect(destinations.map((d) => [d.place.id, d.name, d.kind, d.curated])).toEqual([
      ["t1", "Teatown Lake Reservation", "nature", false],
      ["u", "Untermyer Gardens", "garden", true],
    ]);
    expect(destinations.find((d) => d.curated)!.note).toBe(UNTERMYER.note);
    expect(missing).toEqual(["Nowhere Gardens"]);
  });

  it("names a place by its own words, not its kind", () => {
    expect(placeWords("Croton Point Park")).toBe("croton point");
    expect(placeWords("Rockefeller State Park Preserve")).toBe("rockefeller");
    expect(placeWords("The Nature Center")).toBe("");
  });

  it("reads an area in tiles of at most half a degree, covering the whole circle", () => {
    const tiles = tilesAround({ lat: 40.941, lon: -73.835 }, 50_500);
    expect(tiles.length).toBe(6);
    for (const t of tiles) {
      expect(t.east - t.west).toBeLessThanOrEqual(0.5);
      expect(t.north - t.south).toBeLessThanOrEqual(0.5);
    }
    expect(Math.min(...tiles.map((t) => t.south))).toBeLessThan(40.941 - 50_500 / 111_320 + 1e-6);
    expect(Math.max(...tiles.map((t) => t.east))).toBeGreaterThan(-73.835 + 0.59);
  });

  it("refuses a capture that is not one, or mixes releases", () => {
    const tile = { outrn_capture: "overture", release: "2026-09-23.1", bbox: { west: -73.9, south: 40.9, east: -73.8, north: 41.0 }, fetchedAt: "2026-10-05T00:00:00.000Z", places: [place({ id: "a" })] };
    expect(parseDestinationsCapture({ outrn_capture: "overture-destinations", tiles: [tile] }, "c.json").tiles).toHaveLength(1);
    expect(() => parseDestinationsCapture(tile, "c.json")).toThrow(/not a destinations capture/);
    expect(() => parseDestinationsCapture({ outrn_capture: "overture-destinations", tiles: [tile, { ...tile, release: "2026-08-19.0", places: [] }] }, "c.json")).toThrow(/mixes Overture releases/);
  });
});

describe("a saved destinations read", () => {
  it("keeps only the records selection reads, and selects the same destinations from them", () => {
    const places = [
      place({ id: "u", name: "Untermyer Gardens Conservancy", category: "park", lat: 40.9663, lon: -73.8878 }),
      place({ id: "u-far", name: "Untermyer Gardens", category: "park", lat: 41.3, lon: -73.9 }),
      place({ id: "t" }),
      place({ id: "deli", name: "Bronx Zoo Hot Deli", category: "park", confidence: 0.99 }),
      place({ id: "field", name: "Saxon Woods Park Field 3", category: "park" }),
    ];
    const read = recordsRead(places, [UNTERMYER]);
    expect([...read].sort()).toEqual(["t", "u"]);
    const pick = (ps: OverturePlace[]) => selectDestinations(ps, [UNTERMYER]).destinations.map((d) => d.place.id);
    expect(pick(places.filter((p) => read.has(p.id)))).toEqual(pick(places));
  });
});
