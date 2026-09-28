import { describe, expect, it } from "vitest";
import { fromLocal } from "@outrn/core";
import { isPublicHolidayOn } from "@outrn/facts";
import { typicalCrowd } from "./conditions.js";

const TZ = "America/New_York";
const at = (date: string, hm: string) => {
  const [h, m] = hm.split(":").map(Number) as [number, number];
  return fromLocal(date, h * 60 + m, TZ);
};

describe("typical crowds: the kind of place, the day and the hour", () => {
  it("restaurants: busy Friday and Saturday dinner and weekend brunch, fairly busy weekday lunch, quiet mid-afternoon", () => {
    expect(typicalCrowd("restaurant", at("2026-10-02", "19:30"), TZ)).toEqual({ level: "busy", when: "Friday evenings" });
    expect(typicalCrowd("restaurant", at("2026-10-04", "11:00"), TZ)).toEqual({ level: "busy", when: "Sunday mornings" });
    expect(typicalCrowd("restaurant", at("2026-09-29", "12:30"), TZ)).toEqual({ level: "moderate", when: "Tuesday afternoons" });
    expect(typicalCrowd("restaurant", at("2026-09-29", "15:30"), TZ)).toEqual({ level: "quiet", when: "Tuesday afternoons" });
    expect(typicalCrowd("restaurant", at("2026-09-30", "19:00"), TZ)).toEqual({ level: "moderate", when: "Wednesday evenings" });
  });

  it("after midnight is still the night before: a bar at 12:30am Saturday is a busy Friday night", () => {
    expect(typicalCrowd("bar", at("2026-10-03", "00:30"), TZ)).toEqual({ level: "busy", when: "Friday nights" });
    expect(typicalCrowd("bar", at("2026-10-03", "03:00"), TZ)).toEqual({ level: "quiet", when: "Friday nights" });
    expect(typicalCrowd("bar", at("2026-10-02", "00:30"), TZ)).toEqual({ level: "busy", when: "Thursday nights" });
    expect(typicalCrowd("bar", at("2026-10-02", "01:30"), TZ)).toEqual({ level: "quiet", when: "Thursday nights" });
    expect(typicalCrowd("bar", at("2026-10-03", "18:30"), TZ)).toEqual({ level: "moderate", when: "Saturday evenings" });
    expect(typicalCrowd("bar", at("2026-09-28", "00:30"), TZ)).toEqual({ level: "quiet", when: "Sunday nights" });
    expect(typicalCrowd("nightclub", at("2026-10-04", "02:00"), TZ)).toEqual({ level: "busy", when: "Saturday nights" });
  });

  it("public holidays follow Sunday: a museum on Thanksgiving afternoon is busy, on an ordinary Thursday fairly busy", () => {
    expect(isPublicHolidayOn("2026-11-26")).toBe(true);
    expect(isPublicHolidayOn("2026-11-19")).toBe(false);
    expect(typicalCrowd("museum", at("2026-11-26", "13:00"), TZ)).toEqual({ level: "busy", when: "holiday afternoons" });
    expect(typicalCrowd("museum", at("2026-11-19", "13:00"), TZ)).toEqual({ level: "moderate", when: "Thursday afternoons" });
  });

  it("no pattern where the programme is the crowd, or where a guess would be noise", () => {
    for (const category of ["cinema", "theatre", "live_music", "community", "other"] as const) expect(typicalCrowd(category, at("2026-10-03", "19:00"), TZ)).toBeNull();
  });
});
