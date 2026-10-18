import { describe, expect, it } from "vitest";
import { acrossTheSound, estimateTravel, haversineMetres, maxReachMetres, parkingBufferAt, tripMetres, type LatLon, type ParkingRule } from "./geo.js";

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
