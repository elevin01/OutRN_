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
    expect(weatherFor(HOURS, ISSUED, at("2026-10-03T16:00:00Z"), 60, at("2026-10-03T16:00:00Z"))).toMatchObject({ temperatureF: 58, precipProbability: 10 });
    // Two hours from 1pm reach the 2pm showers.
    expect(weatherFor(HOURS, ISSUED, at("2026-10-03T17:00:00Z"), 180, at("2026-10-03T17:00:00Z"))).toMatchObject({ temperatureF: 59, precipProbability: 55 });
    // Rain later than two hours out does not change a plan starting now.
    expect(weatherFor(HOURS, ISSUED, at("2026-10-03T16:00:00Z"), 240, at("2026-10-03T16:00:00Z"))?.precipProbability).toBe(15);
    // A wet hour is wet whatever the others say; with no chance given at all, it is unknown.
    expect(weatherFor(HOURS, ISSUED, at("2026-10-03T20:30:00Z"), 120, at("2026-10-03T20:30:00Z"))).toMatchObject({ temperatureF: 45, precipProbability: 85 });
    expect(weatherFor(HOURS, ISSUED, at("2026-10-03T21:00:00Z"), 60, at("2026-10-03T21:00:00Z"))).toMatchObject({ temperatureF: 45, precipProbability: null });
  });

  it("none when the forecast is over 12 hours old or does not cover the start", () => {
    expect(weatherFor(HOURS, ISSUED, at("2026-10-03T21:00:00Z"), 60, at("2026-10-04T03:31:00Z"))).toBeNull();
    expect(weatherFor(HOURS, ISSUED, at("2026-10-03T15:00:00Z"), 120, at("2026-10-03T15:00:00Z"))).toBeNull();
    expect(weatherFor(HOURS, ISSUED, at("2026-10-03T22:00:00Z"), 120, at("2026-10-03T21:00:00Z"))).toBeNull();
    expect(weatherFor([], ISSUED, at("2026-10-03T16:00:00Z"), 60, at("2026-10-03T16:00:00Z"))).toBeNull();
  });

  it("also gives the warmest hour and the span it read, for the words on a card", () => {
    // 1pm for two hours: the 1pm and 2pm hours (59°F and 61°F), read from 1pm to 3pm.
    expect(weatherFor(HOURS, ISSUED, at("2026-10-03T17:00:00Z"), 180, at("2026-10-03T17:00:00Z"))).toEqual({
      temperatureF: 59,
      precipProbability: 55,
      highF: 61,
      from: at("2026-10-03T17:00:00Z"),
      until: at("2026-10-03T19:00:00Z"),
    });
    // A shorter window is read whole: 45 minutes from noon.
    expect(weatherFor(HOURS, ISSUED, at("2026-10-03T16:00:00Z"), 45, at("2026-10-03T16:00:00Z"))).toMatchObject({ highF: 58, until: at("2026-10-03T16:45:00Z") });
  });

  it("ignores hours it cannot read", () => {
    const junk = [{ start: "x", end: "y", temperatureF: 50, precipProbability: 90 }, { ...HOURS[0]!, temperatureF: Number.NaN }, HOURS[0]!] as ForecastHour[];
    expect(weatherFor(junk, ISSUED, at("2026-10-03T16:00:00Z"), 60, at("2026-10-03T16:00:00Z"))).toMatchObject({ temperatureF: 58, precipProbability: 10 });
  });

  it("dry only when every minute of the span has a chance of rain: a missing hour, a gap or the forecast's end is unknown", () => {
    const now = at("2026-10-03T16:00:00Z");
    const twoHours = (hours: ForecastHour[]) => weatherFor(hours, ISSUED, now, 120, now);
    expect(twoHours([hour("2026-10-03T16:00:00Z", 64, 10), hour("2026-10-03T17:00:00Z", 60, null)])).toMatchObject({ temperatureF: 60, precipProbability: null });
    expect(twoHours([hour("2026-10-03T16:00:00Z", 64, 10)])).toMatchObject({ temperatureF: 64, precipProbability: null });
    const late = hour("2026-10-03T17:30:00Z", 60, 10);
    expect(twoHours([hour("2026-10-03T16:00:00Z", 64, 10), late])?.precipProbability).toBeNull();
    // An unreadable hour is dropped, so the hour it covered is unknown, not dry.
    expect(twoHours([hour("2026-10-03T16:00:00Z", 64, 10), { ...hour("2026-10-03T17:00:00Z", 60, 90), temperatureF: Number.NaN }])?.precipProbability).toBeNull();
    // A wet hour still counts, and a fully covered span is as dry as it says.
    expect(twoHours([hour("2026-10-03T16:00:00Z", 64, 80), hour("2026-10-03T17:00:00Z", 60, null)])?.precipProbability).toBe(80);
    expect(twoHours([hour("2026-10-03T16:00:00Z", 64, 10), hour("2026-10-03T17:00:00Z", 60, 20)])).toMatchObject({ temperatureF: 60, precipProbability: 20 });
  });

  it("none from a forecast issued after the request (beyond a few minutes of clock skew)", () => {
    const now = at("2026-10-03T16:00:00Z");
    expect(weatherFor(HOURS, at("2026-10-03T17:00:00Z"), now, 60, now)).toBeNull();
    expect(weatherFor(HOURS, at("2099-01-01T00:00:00Z"), now, 60, now)).toBeNull();
    expect(weatherFor(HOURS, at("2026-10-03T16:03:00Z"), now, 60, now)).toMatchObject({ temperatureF: 58, precipProbability: 10 });
  });

  it("reads a forecast of any length without running out of stack, and skips entries that are not hours", () => {
    const many = Array.from({ length: 250_000 }, () => hour("2026-10-03T16:00:00Z", 58, 10));
    const now = at("2026-10-03T16:00:00Z");
    expect(weatherFor(many, ISSUED, now, 60, now)).toMatchObject({ temperatureF: 58, precipProbability: 10 });
    expect(weatherFor([null, HOURS[0]!] as unknown as ForecastHour[], ISSUED, now, 60, now)).toMatchObject({ temperatureF: 58, precipProbability: 10 });
  });
});
