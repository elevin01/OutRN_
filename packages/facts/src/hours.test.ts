import { describe, expect, it } from "vitest";
import { fromLocal } from "@outrn/core";
import { evaluateHours } from "./hours.js";

const TZ = "America/New_York";
const at = (d: string, h: number, m = 0) => fromLocal(d, h * 60 + m, TZ);

describe("opening hours evaluation", () => {
  it("resolves the interval containing the instant in the venue's timezone", () => {
    const ev = evaluateHours({ osm: "Mo-Fr 09:00-17:00; Sa-Su 10:00-16:00" }, at("2026-10-03", 12), TZ); // Saturday
    expect(ev.openNow).toBe(true);
    expect(ev.interval!.open.getTime()).toBe(at("2026-10-03", 10).getTime());
    expect(ev.interval!.close.getTime()).toBe(at("2026-10-03", 16).getTime());
  });

  it("overnight rules cross midnight correctly", () => {
    const ev = evaluateHours({ osm: "Mo-Su 20:00-04:00" }, at("2026-10-04", 1), TZ);
    expect(ev.openNow).toBe(true);
    expect(ev.interval!.close.getTime()).toBe(at("2026-10-04", 4).getTime());
  });

  it("when closed, returns the next opening", () => {
    const ev = evaluateHours({ osm: "Mo-Su 17:00-23:00" }, at("2026-10-03", 15), TZ);
    expect(ev.openNow).toBe(false);
    expect(ev.interval!.open.getTime()).toBe(at("2026-10-03", 17).getTime());
  });

  it("weekly interval shape (from JSON-LD) evaluates the same way, including endMin past midnight", () => {
    const weekly = [{ weekday: 6, startMin: 20 * 60, endMin: 26 * 60 }]; // Saturday 20:00–02:00
    const ev = evaluateHours({ weekly }, at("2026-10-04", 1), TZ); // Sunday 01:00, inside Saturday's overnight interval
    expect(ev.openNow).toBe(true);
    expect(ev.interval!.close.getTime()).toBe(at("2026-10-04", 2).getTime());
  });

  it("24/7 and off are handled without the parser", () => {
    expect(evaluateHours({ osm: "24/7" }, at("2026-10-03", 3), TZ).always).toBe(true);
    expect(evaluateHours({ osm: "off" }, at("2026-10-03", 12), TZ).openNow).toBe(false);
  });

  it("seasonal rules are flagged approximate but still evaluate", () => {
    const ev = evaluateHours({ osm: "Apr-Oct Mo-Su 08:00-19:00; Nov-Mar Mo-Su 08:00-17:00" }, at("2026-10-03", 18), TZ);
    expect(ev.openNow).toBe(true);
    const nov = evaluateHours({ osm: "Apr-Oct Mo-Su 08:00-19:00; Nov-Mar Mo-Su 08:00-17:00" }, at("2026-11-07", 18), TZ);
    expect(nov.openNow).toBe(false);
  });

  it("public holidays resolve for New York, and a PH rule is exact on an ordinary day", () => {
    const rule = { osm: "Mo-Su 09:00-17:00; PH off" };
    for (const day of ["2026-07-04", "2026-11-26", "2026-12-25"]) {
      // Independence Day, Thanksgiving, Christmas: closed, flagged approximate (venues read PH differently).
      const ev = evaluateHours(rule, at(day, 12), TZ);
      expect([ev.openNow, ev.approximate], day).toEqual([false, true]);
    }
    const ordinary = evaluateHours(rule, at("2026-11-19", 12), TZ);
    expect([ordinary.openNow, ordinary.approximate]).toEqual([true, false]);
    // The evening before a holiday is approximate too: a window can run into it.
    expect(evaluateHours(rule, at("2026-11-25", 12), TZ).approximate).toBe(true);
    // School holidays are not defined for New York: such a rule is unreadable (hours unknown), never a guess.
    expect(evaluateHours({ osm: "Mo-Fr 08:00-15:00; SH off" }, at("2026-11-19", 12), TZ).openNow).toBeNull();
  });

  it("garbage yields a parse error, never a state", () => {
    const ev = evaluateHours({ osm: "ask inside" }, at("2026-10-03", 12), TZ);
    expect(ev.openNow).toBeNull();
    expect(ev.parseError).toBeTruthy();
  });

  it("DST spring-forward: 02:30 does not exist on Mar 8 2026; evaluation still returns a coherent interval", () => {
    const ev = evaluateHours({ osm: "Mo-Su 22:00-03:00" }, at("2026-03-08", 1, 30), TZ);
    expect(ev.openNow).toBe(true);
    expect(ev.interval!.close.getTime()).toBeGreaterThan(at("2026-03-08", 1, 30).getTime());
  });
});
