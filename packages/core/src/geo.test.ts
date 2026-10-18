import { describe, expect, it } from "vitest";
import { acrossTheSound, crossesTheSound, estimateTravel, haversineMetres, maxReachMetres, parkingBufferAt, tripMetres, type LatLon, type ParkingRule } from "./geo.js";

const ORIGIN: LatLon = { lat: 40.941, lon: -73.835 };
/** A point `m` metres due north of the origin. */
const north = (m: number): LatLon => ({ lat: ORIGIN.lat + m / 111_195, lon: ORIGIN.lon });

const WESTCHESTER: ParkingRule = { defaultMinutes: 8, byHour: [{ from: 18, to: 6, minutes: 5 }] };

describe("travel estimates", () => {
  it("maxReachMetres is the inverse of estimateTravel at the best hour", () => {
    const reach = maxReachMetres("drive", 30);
    expect(estimateTravel(ORIGIN, north(reach - 20), "drive", { hourLocal: 23 }).minutes).toBeLessThanOrEqual(30);
    expect(estimateTravel(ORIGIN, north(reach + 200), "drive", { hourLocal: 23 }).minutes).toBeGreaterThan(30);
    // Within town distances too, where the drive never reaches road speed.
    const short = maxReachMetres("drive", 12);
    expect(estimateTravel(ORIGIN, north(short - 20), "drive", { hourLocal: 23 }).minutes).toBeLessThanOrEqual(12);
    expect(estimateTravel(ORIGIN, north(short + 100), "drive", { hourLocal: 23 }).minutes).toBeGreaterThan(12);
    const walk = maxReachMetres("walk", 25);
    expect(estimateTravel(ORIGIN, north(walk - 5), "walk").minutes).toBeLessThanOrEqual(25);
    expect(estimateTravel(ORIGIN, north(walk + 100), "walk").minutes).toBeGreaterThan(25);
  });

  it("a 30-minute drive reaches ~18.2 km at night with the default buffer, ~21 km with the Westchester evening rule (11.8 and 13.4 at town speed)", () => {
    expect(Math.round(maxReachMetres("drive", 30) / 100) * 100).toBe(18_200);
    expect(Math.round(maxReachMetres("drive", 30, { parkingBufferForHour: (h) => parkingBufferAt(WESTCHESTER, h) }) / 100) * 100).toBe(21_000);
    expect(Math.round(maxReachMetres("drive", 30, { townSpeed: true }) / 100) * 100).toBe(11_800);
    expect(Math.round(maxReachMetres("drive", 30, { parkingBufferForHour: (h) => parkingBufferAt(WESTCHESTER, h), townSpeed: true }) / 100) * 100).toBe(13_400);
  });

  it("drives beyond town at road speed: a 30-40 minute drive out of town is not an hour and more", () => {
    // Bronxville to Croton Point Park, 27.6 km as the crow flies: ~35-40 min on the parkways (75 at town speed).
    const croton = north(27_600);
    expect(estimateTravel(ORIGIN, croton, "drive", { hourLocal: 12 }).minutes).toBe(47);
    expect(estimateTravel(ORIGIN, croton, "drive", { hourLocal: 17 }).minutes).toBeGreaterThan(55); // rush hour
    // Around town nothing changes: 2 km is the same town drive as before.
    expect(estimateTravel(ORIGIN, north(2_000), "drive", { hourLocal: 12 }).minutes).toBe(13);
  });

  it("a trip across Long Island Sound goes round by the Throgs Neck Bridge: the north shore is an hour from Mamaroneck, not half that", () => {
    const mamaroneck: LatLon = { lat: 40.9384, lon: -73.7423 };
    const locustValley: LatLon = { lat: 40.8754, lon: -73.597 };
    const ryePlayland: LatLon = { lat: 40.968, lon: -73.672 };
    expect(acrossTheSound(locustValley)).toBe(true);
    expect(acrossTheSound(mamaroneck)).toBe(false);
    expect(acrossTheSound(ryePlayland)).toBe(false);
    // 13.6 km as the crow flies; ~34 km by the bridge.
    expect(Math.round(haversineMetres(mamaroneck, locustValley) / 1000)).toBe(14);
    expect(Math.round(tripMetres(mamaroneck, locustValley) / 1000)).toBe(34);
    expect(estimateTravel(mamaroneck, locustValley, "drive", { hourLocal: 12 }).minutes).toBeGreaterThanOrEqual(55);
    // Either way round, and the mainland is as before.
    expect(tripMetres(locustValley, mamaroneck)).toBe(tripMetres(mamaroneck, locustValley));
    expect(tripMetres(mamaroneck, ryePlayland)).toBe(haversineMetres(mamaroneck, ryePlayland));
    expect(estimateTravel(mamaroneck, ryePlayland, "drive", { hourLocal: 12 }).minutes).toBeLessThan(25);
    // Never shorter than the straight line, so a search radius from maxReachMetres still finds everything.
    expect(tripMetres(mamaroneck, locustValley)).toBeGreaterThan(haversineMetres(mamaroneck, locustValley));
  });

  it("only a trip whose straight line crosses the Sound goes round: one shore's own trips never do, near the water or in Queens (PR #56 review)", () => {
    // New Rochelle's center and the Davenport Avenue shore, 1.2 km apart on the mainland: the destinations
    // job's margin counts the shore as across, but the trip doesn't cross the water.
    const newRochelle: LatLon = { lat: 40.9115, lon: -73.783 };
    const davenport: LatLon = { lat: 40.905, lon: -73.772 };
    expect(acrossTheSound(davenport)).toBe(true);
    expect(crossesTheSound(newRochelle, davenport)).toBe(false);
    expect(tripMetres(newRochelle, davenport)).toBe(haversineMetres(newRochelle, davenport));
    expect(estimateTravel(newRochelle, davenport, "drive", { hourLocal: 12 }).minutes).toBeLessThanOrEqual(12);
    expect(estimateTravel(newRochelle, davenport, "walk").minutes).toBeLessThanOrEqual(20);
    // Two places in Queens on either side of where the Sound line starts: one island, a short walk.
    const bayside: LatLon = { lat: 40.76, lon: -73.78 };
    const nearby: LatLon = { lat: 40.76, lon: -73.77 };
    expect(crossesTheSound(bayside, nearby)).toBe(false);
    expect(estimateTravel(bayside, nearby, "walk").minutes).toBeLessThanOrEqual(15);
    // Across it, either way round; and a north shore trip from New Rochelle (Kings Point) too.
    const mamaroneck: LatLon = { lat: 40.9384, lon: -73.7423 };
    const locustValley: LatLon = { lat: 40.8754, lon: -73.597 };
    expect(crossesTheSound(mamaroneck, locustValley)).toBe(true);
    expect(crossesTheSound(locustValley, mamaroneck)).toBe(true);
    expect(crossesTheSound(newRochelle, { lat: 40.82, lon: -73.735 })).toBe(true);
    // Greenwich to Bayville, Connecticut to the north shore.
    expect(crossesTheSound({ lat: 41.03, lon: -73.62 }, { lat: 40.91, lon: -73.56 })).toBe(true);
  });

  it("a trip exactly through one of the line's vertices crosses it; one that only touches it does not (PR #56 re-review)", () => {
    // (-73.7, 40.9) is a vertex: due south through it, and on a slant through it, either way round.
    const north: LatLon = { lat: 40.95, lon: -73.7 };
    const south: LatLon = { lat: 40.85, lon: -73.7 };
    expect(crossesTheSound(north, south)).toBe(true);
    expect(crossesTheSound(south, north)).toBe(true);
    expect(tripMetres(north, south)).toBeGreaterThan(haversineMetres(north, south));
    expect(crossesTheSound({ lat: 40.95, lon: -73.75 }, { lat: 40.85, lon: -73.65 })).toBe(true);
    expect(crossesTheSound({ lat: 40.85, lon: -73.65 }, { lat: 40.95, lon: -73.75 })).toBe(true);
    // Ending on the vertex, or running along to it and back to the side it came from, is not crossing.
    expect(crossesTheSound(north, { lat: 40.9, lon: -73.7 })).toBe(false);
    expect(crossesTheSound({ lat: 40.95, lon: -73.75 }, { lat: 40.9, lon: -73.7 })).toBe(false);
  });

  it("from the Bronx shore east of the bridge the north shore is across too; the Bronx's own trips stay straight (PR #56 re-review)", () => {
    const cityIsland: LatLon = { lat: 40.8468, lon: -73.7868 };
    const pelhamBay: LatLon = { lat: 40.8672, lon: -73.8101 };
    const throggsNeck: LatLon = { lat: 40.8198, lon: -73.8166 };
    for (const [from, to] of [
      [cityIsland, { lat: 40.8198, lon: -73.7351 }], // Kings Point
      [cityIsland, { lat: 40.8518, lon: -73.7193 }], // Sands Point
      [pelhamBay, { lat: 40.8007, lon: -73.7285 }], // Great Neck
    ] as const) {
      expect(crossesTheSound(from, to)).toBe(true);
      expect(tripMetres(from, to)).toBeGreaterThan(haversineMetres(from, to));
    }
    for (const [from, to] of [
      [cityIsland, pelhamBay],
      [throggsNeck, cityIsland],
      [pelhamBay, { lat: 40.9115, lon: -73.783 }], // New Rochelle
    ] as const)
      expect(tripMetres(from, to)).toBe(haversineMetres(from, to));
    // The destinations job's filter is as it was: City Island is not across.
    expect(acrossTheSound(cityIsland)).toBe(false);
  });

  it("the parking rule applies by local hour, wrapping past midnight", () => {
    expect(parkingBufferAt(WESTCHESTER, 17)).toBe(8);
    expect(parkingBufferAt(WESTCHESTER, 18)).toBe(5);
    expect(parkingBufferAt(WESTCHESTER, 2)).toBe(5);
    expect(parkingBufferAt(WESTCHESTER, 6)).toBe(8);
    expect(parkingBufferAt(null, 21)).toBe(8);
    const p = north(3000);
    expect(estimateTravel(ORIGIN, p, "drive", { hourLocal: 19, parkingBufferMinutes: 5 }).minutes).toBe(estimateTravel(ORIGIN, p, "drive", { hourLocal: 19 }).minutes - 3);
  });
});
