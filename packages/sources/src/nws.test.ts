import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseHourlyForecast, weatherAt } from "./nws.js";

const SAMPLE = readFileSync(resolve(__dirname, "../../../fixtures/nws/les-hourly-sample.json"), "utf8");
const FETCHED = new Date("2026-10-03T15:50:00Z");

describe("NWS hourly forecast", () => {
  it("reads each hour's temperature (°F), chance of rain and forecast, and when NWS issued it", () => {
    const f = parseHourlyForecast(SAMPLE, FETCHED);
    expect(f.sourceUpdatedAt).toEqual(new Date("2026-10-03T15:30:12Z"));
    expect(f.fetchedAt).toBe(FETCHED);
    expect(f.raw).toBe(SAMPLE);
    expect(f.hours).toHaveLength(8);
    expect(f.hours[0]).toEqual({ start: new Date("2026-10-03T16:00:00Z"), end: new Date("2026-10-03T17:00:00Z"), temperatureF: 58, precipProbability: 10, shortForecast: "Partly Sunny" });
    // A null chance of rain stays unknown, not zero.
    expect(f.hours[7]!.precipProbability).toBeNull();
    expect(weatherAt(f, new Date("2026-10-03T19:30:00Z"))?.precipProbability).toBe(80);
    expect(weatherAt(f, new Date("2026-10-04T01:00:00Z"))).toBeNull();
  });

  it("converts °C, puts hours in order, and drops an hour with no usable times", () => {
    const doc = JSON.parse(SAMPLE) as { properties: { periods: Record<string, unknown>[] } };
    const [a, b] = doc.properties.periods;
    doc.properties.periods = [{ ...b, temperature: 20, temperatureUnit: "C" }, a!, { ...a, startTime: "not a time" }, { ...a, endTime: a!["startTime"] }];
    const f = parseHourlyForecast(JSON.stringify(doc), FETCHED);
    expect(f.hours.map((h) => [h.start.toISOString(), h.temperatureF])).toEqual([
      ["2026-10-03T16:00:00.000Z", 58],
      ["2026-10-03T17:00:00.000Z", 68],
    ]);
  });

  it("refuses what is not a forecast", () => {
    expect(() => parseHourlyForecast("<html>", FETCHED)).toThrow();
    expect(() => parseHourlyForecast(JSON.stringify({ properties: {} }), FETCHED)).toThrow();
    expect(() => parseHourlyForecast(JSON.stringify({ properties: { periods: [{ startTime: "2026-10-03T12:00:00-04:00", endTime: "2026-10-03T13:00:00-04:00", temperature: "warm", temperatureUnit: "F" }] } }), FETCHED)).toThrow();
  });
});
