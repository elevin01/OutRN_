import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import opening_hours from "opening_hours";
import { describe, expect, it } from "vitest";
import { fromLocal, localClock } from "@outrn/core";
import { clearHoursCaches, evaluateHours, withSunTimes } from "./hours.js";

/**
 * The cached evaluation must match evaluating from scratch, exactly. The reference below is the
 * uncached algorithm (a fresh parse and a narrow getOpenIntervals window per call).
 */

function reference(rule: string, at: Date, timeZone: string, lat: number, lon: number) {
  const parse = (r: string) => new opening_hours(r, { lat, lon, address: { country_code: "us", state: "New York" } }, { mode: 0, tag_key: "opening_hours", map_value: undefined, warnings_severity: undefined, locale: undefined });
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const p = Object.fromEntries(fmt.formatToParts(at).map((x) => [x.type, x.value]));
  const shifted = new Date(+p["year"]!, +p["month"]! - 1, +p["day"]!, +p["hour"]!, +p["minute"]!, +p["second"]!);
  const ymd = (w: Date) => `${w.getFullYear()}-${String(w.getMonth() + 1).padStart(2, "0")}-${String(w.getDate()).padStart(2, "0")}`;
  const back = (w: Date) => fromLocal(ymd(w), w.getHours() * 60 + w.getMinutes(), timeZone).toISOString();
  const from = new Date(shifted.getTime() - 24 * 3_600_000);
  const to = new Date(shifted.getTime() + 36 * 3_600_000);
  let oh: opening_hours;
  let its: [Date, Date, boolean, string | undefined][];
  try {
    if (/sunrise|sunset|dawn|dusk/.test(rule)) {
      // A sun-relative rule: each local day read with that day's sun times where the place is (see
      // withSunTimes), a fresh parse per day, joined at midnight.
      oh = parse(withSunTimes(rule, localClock(at, timeZone).date, timeZone, lat, lon)!);
      its = [];
      for (let start = from; start < to; ) {
        const midnight = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1);
        const end = midnight < to ? midnight : to;
        for (const [f, t, unknown, comment] of parse(withSunTimes(rule, ymd(start), timeZone, lat, lon)!).getOpenIntervals(start, end)) {
          const last = its[its.length - 1];
          if (last && f.getTime() === start.getTime() && last[1].getTime() === f.getTime() && last[2] === unknown && last[3] === comment) last[1] = t;
          else its.push([f, t, unknown, comment]);
        }
        start = midnight;
      }
    } else {
      oh = parse(rule);
      its = oh.getOpenIntervals(from, to);
    }
  } catch {
    return { openNow: null, interval: null };
  }
  const current = its.find(([f, t]) => f <= shifted && shifted < t);
  const next = current ?? its.find(([f]) => f > shifted);
  return { openNow: oh.getState(shifted), interval: next ? { open: back(next[0]), close: back(next[1]) } : null };
}

function rulesFrom(file: string): string[] {
  const data = JSON.parse(readFileSync(resolve(__dirname, "../../../fixtures/osm", file), "utf8")) as { elements: { tags?: Record<string, string> }[] };
  return data.elements.map((e) => e.tags?.["opening_hours"]).filter((r): r is string => Boolean(r));
}

const RULES = [
  ...new Set([
    ...rulesFrom("les-synthetic.json"),
    ...rulesFrom("bronxville-synthetic.json"),
    "Mo-Fr 09:00-17:00; Sa 10:00-14:00",
    "Mo-Su 16:00-04:00",
    "Mo-Th 17:00-01:00; Fr-Sa 17:00-03:00; Su off",
    "Mo-Fr 08:00-12:00,13:00-18:00; PH off",
    "Mo-Su sunrise-sunset",
    "sunset-sunrise",
    "Mo-Fr (sunrise+00:30)-(sunset-01:00); Sa,Su dawn-dusk",
    "Mo-Su 10:00-22:00; Tu off \"closed for private events\"",
    "Mo-Su 12:00-24:00",
    "Jun-Aug Mo-Su 10:00-20:00; Sep-May Sa,Su 11:00-17:00",
    "Mo-Fr 11:00-15:00 unknown; Sa 12:00-20:00",
  ]),
];

// Hourly-ish probes over two weeks spanning the Nov 1 2026 fall-back, plus the Mar 8 2026 spring-forward.
const TIMES: Date[] = [];
for (let t = Date.parse("2026-10-26T00:07:00Z"); t < Date.parse("2026-11-09T00:00:00Z"); t += 97 * 60_000) TIMES.push(new Date(t));
for (let t = Date.parse("2026-03-07T00:11:00Z"); t < Date.parse("2026-03-10T00:00:00Z"); t += 71 * 60_000) TIMES.push(new Date(t));

describe("cached opening-hours evaluation", () => {
  it(`matches the uncached algorithm for ${RULES.length} rules at ${TIMES.length} instants, cold and warm`, () => {
    const tz = "America/New_York";
    const geo = { lat: 40.94, lon: -73.83 };
    const view = (rule: string, at: Date) => {
      const got = evaluateHours({ osm: rule }, at, tz, geo);
      return got.parseError ? null : { openNow: got.openNow, interval: got.interval ? { open: got.interval.open.toISOString(), close: got.interval.close.toISOString() } : null };
    };
    clearHoursCaches();
    let compared = 0;
    for (const rule of RULES) {
      for (const at of TIMES) {
        const cold = view(rule, at);
        if (!cold) continue;
        const want = reference(rule, at, tz, geo.lat, geo.lon);
        expect(cold, `cold "${rule}" at ${at.toISOString()}`).toEqual(want);
        // Same rule, other instants already cached: the warm path must agree too.
        expect(view(rule, at), `warm "${rule}" at ${at.toISOString()}`).toEqual(want);
        compared++;
      }
    }
    expect(compared).toBeGreaterThan(5_000);
  });
});
