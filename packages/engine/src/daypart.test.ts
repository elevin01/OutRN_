import { describe, expect, it } from "vitest";
import { fromLocal } from "@outrn/core";
import { dayPart } from "./daypart.js";

const TZ = "America/New_York";
const at = (date: string, hm: string) => fromLocal(date, Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3)), TZ);

describe("time of day: when each kind of place is a good idea", () => {
  it("cafés for breakfast, bars at night, museums by day", () => {
    expect(dayPart("cafe", at("2026-09-29", "08:00"), TZ)).toBe("prime");
    expect(dayPart("cafe", at("2026-09-29", "15:00"), TZ)).toBe("fair");
    expect(dayPart("cafe", at("2026-09-29", "21:00"), TZ)).toBe("off");
    expect(dayPart("bar", at("2026-09-29", "10:00"), TZ)).toBe("off");
    expect(dayPart("bar", at("2026-09-29", "15:00"), TZ)).toBe("off"); // "a bar at 3pm"
    expect(dayPart("bar", at("2026-09-29", "16:30"), TZ)).toBe("fair");
    expect(dayPart("bar", at("2026-09-29", "23:00"), TZ)).toBe("prime");
    expect(dayPart("bar", at("2026-09-30", "01:30"), TZ)).toBe("prime"); // past midnight is still the night
    expect(dayPart("museum", at("2026-09-29", "13:00"), TZ)).toBe("prime");
    expect(dayPart("museum", at("2026-09-29", "22:00"), TZ)).toBe("off");
  });

  it("weekend brunch is prime for restaurants and cafés; a weekday 10am restaurant is only fair", () => {
    expect(dayPart("restaurant", at("2026-10-04", "10:30"), TZ)).toBe("prime");
    expect(dayPart("restaurant", at("2026-09-29", "10:30"), TZ)).toBe("fair");
    expect(dayPart("cafe", at("2026-10-03", "13:00"), TZ)).toBe("prime");
    expect(dayPart("cafe", at("2026-09-29", "13:00"), TZ)).toBe("fair");
  });

  it("parks and gardens end with the light: fair in the last 45 minutes before sunset, off after it", () => {
    const sunset = at("2026-10-03", "18:35");
    expect(dayPart("park", at("2026-10-03", "17:30"), TZ, sunset)).toBe("prime");
    expect(dayPart("park", at("2026-10-03", "18:20"), TZ, sunset)).toBe("fair");
    expect(dayPart("park", at("2026-10-03", "18:40"), TZ, sunset)).toBe("off");
    expect(dayPart("park", at("2026-10-03", "22:30"), TZ, sunset)).toBe("off");
    expect(dayPart("park", at("2026-10-03", "14:00"), TZ, sunset)).toBe("prime");
    // A viewpoint after dark is still fair: city lights.
    expect(dayPart("viewpoint", at("2026-10-03", "21:30"), TZ, sunset)).toBe("fair");
  });

  it("no rule where the kind is too varied", () => {
    for (const c of ["community", "other"] as const) expect(dayPart(c, at("2026-10-03", "22:00"), TZ)).toBeNull();
  });
});

describe("time of day for a cinema, theatre or music venue with nothing listed", () => {
  const at = (d: string, hm: string) => fromLocal(d, Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3)), "America/New_York");
  it("an evening is its time; a weekday morning is not; a weekend afternoon is a matinee", () => {
    expect(dayPart("cinema", at("2026-09-29", "19:30"), "America/New_York")).toBe("prime");
    expect(dayPart("cinema", at("2026-09-29", "09:30"), "America/New_York")).toBe("off");
    expect(dayPart("cinema", at("2026-10-03", "13:00"), "America/New_York")).toBe("prime");
    expect(dayPart("theatre", at("2026-09-29", "19:00"), "America/New_York")).toBe("prime");
    expect(dayPart("theatre", at("2026-10-04", "14:00"), "America/New_York")).toBe("prime");
    expect(dayPart("live_music", at("2026-10-03", "23:30"), "America/New_York")).toBe("prime");
    expect(dayPart("live_music", at("2026-10-03", "11:00"), "America/New_York")).toBe("off");
  });
});
