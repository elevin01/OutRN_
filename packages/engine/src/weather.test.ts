import { describe, expect, it } from "vitest";
import { weatherFor, type ForecastHour } from "./weather.js";

const hour = (startIso: string, temperatureF: number, precipProbability: number | null): ForecastHour => {
  const start = new Date(startIso);
  return { start: start.toISOString(), end: new Date(start.getTime() + 3_600_000).toISOString(), temperatureF, precipProbability };
};
// Saturday afternoon in New York (UTC-4): clear at noon, rain from 2pm.
const HOURS = [hour("2026-10-03T16:00:00Z", 58, 10), hour("2026-10-03T17:00:00Z", 59, 15), hour("2026-10-03T18:00:00Z", 61, 55), hour("2026-10-03T19:00:00Z", 62, 80), hour("2026-10-03T20:00:00Z", 62, 85), hour("2026-10-03T21:00:00Z", 45, null)];
const ISSUED = new Date("2026-10-03T15:30:00Z");
const at = (iso: string) => new Date(iso);

describe("the weather a plan allows for", () => {
  it("the wettest chance of rain and the coldest hour over the first two hours of the window", () => {
    expect(weatherFor(HOURS, ISSUED, at("2026-10-03T16:00:00Z"), 60, at("2026-10-03T16:00:00Z"))).toEqual({ temperatureF: 58, precipProbability: 10 });
    // Two hours from 1pm reach the 2pm showers.
    expect(weatherFor(HOURS, ISSUED, at("2026-10-03T17:00:00Z"), 180, at("2026-10-03T17:00:00Z"))).toEqual({ temperatureF: 59, precipProbability: 55 });
    // Rain later than two hours out does not change a plan starting now.
    expect(weatherFor(HOURS, ISSUED, at("2026-10-03T16:00:00Z"), 240, at("2026-10-03T16:00:00Z"))?.precipProbability).toBe(15);
    // Hours with no chance given leave it to the others; none at all is unknown.
    expect(weatherFor(HOURS, ISSUED, at("2026-10-03T20:30:00Z"), 120, at("2026-10-03T20:30:00Z"))).toEqual({ temperatureF: 45, precipProbability: 85 });
    expect(weatherFor(HOURS, ISSUED, at("2026-10-03T21:00:00Z"), 60, at("2026-10-03T21:00:00Z"))).toEqual({ temperatureF: 45, precipProbability: null });
  });

  it("none when the forecast is over 12 hours old or does not cover the start", () => {
    expect(weatherFor(HOURS, ISSUED, at("2026-10-03T21:00:00Z"), 60, at("2026-10-04T03:31:00Z"))).toBeNull();
    expect(weatherFor(HOURS, ISSUED, at("2026-10-03T15:00:00Z"), 120, at("2026-10-03T15:00:00Z"))).toBeNull();
    expect(weatherFor(HOURS, ISSUED, at("2026-10-03T22:00:00Z"), 120, at("2026-10-03T21:00:00Z"))).toBeNull();
    expect(weatherFor([], ISSUED, at("2026-10-03T16:00:00Z"), 60, at("2026-10-03T16:00:00Z"))).toBeNull();
  });

  it("ignores hours it cannot read", () => {
    const junk = [{ start: "x", end: "y", temperatureF: 50, precipProbability: 90 }, { ...HOURS[0]!, temperatureF: Number.NaN }, HOURS[0]!] as ForecastHour[];
    expect(weatherFor(junk, ISSUED, at("2026-10-03T16:00:00Z"), 60, at("2026-10-03T16:00:00Z"))).toEqual({ temperatureF: 58, precipProbability: 10 });
  });
});
