import { describe, expect, it } from "vitest";
import { estimateTravel, maxReachMetres, parkingBufferAt, type LatLon, type ParkingRule } from "./geo.js";

const ORIGIN: LatLon = { lat: 40.941, lon: -73.835 };
/** A point `m` metres due north of the origin. */
const north = (m: number): LatLon => ({ lat: ORIGIN.lat + m / 111_195, lon: ORIGIN.lon });

const WESTCHESTER: ParkingRule = { defaultMinutes: 8, byHour: [{ from: 18, to: 6, minutes: 5 }] };

describe("travel estimates", () => {
  it("maxReachMetres is the inverse of estimateTravel at the best hour", () => {
    const reach = maxReachMetres("drive", 30);
    expect(estimateTravel(ORIGIN, north(reach - 20), "drive", { hourLocal: 23 }).minutes).toBeLessThanOrEqual(30);
    expect(estimateTravel(ORIGIN, north(reach + 200), "drive", { hourLocal: 23 }).minutes).toBeGreaterThan(30);
    const walk = maxReachMetres("walk", 25);
    expect(estimateTravel(ORIGIN, north(walk - 5), "walk").minutes).toBeLessThanOrEqual(25);
    expect(estimateTravel(ORIGIN, north(walk + 100), "walk").minutes).toBeGreaterThan(25);
  });

  it("a 30-minute drive reaches ~11.8 km at night with the default buffer, ~13.4 km with the Westchester evening rule", () => {
    expect(Math.round(maxReachMetres("drive", 30) / 100) * 100).toBe(11_800);
    expect(Math.round(maxReachMetres("drive", 30, { parkingBufferForHour: (h) => parkingBufferAt(WESTCHESTER, h) }) / 100) * 100).toBe(13_400);
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
