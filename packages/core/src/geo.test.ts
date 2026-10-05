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
