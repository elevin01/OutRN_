import opening_hours from "opening_hours";
import SunCalc from "suncalc";
import { fromLocal, localClock, type OpenInterval, type WeeklyIntervals } from "@outrn/core";

/**
 * Opening-hours evaluation. Two stored shapes:
 *   { osm: "Mo-Fr 09:00-17:00; Sa 10:00-16:00" }  — OSM syntax, evaluated with the opening_hours library
 *   { weekly: [{ weekday, startMin, endMin }] }     — explicit intervals (from JSON-LD openingHoursSpecification)
 *
 * Both resolve to "the open interval containing or next-starting after instant `at`" in the
 * venue's timezone. Overnight intervals (20:00–04:00) and seasonal rules are handled by the
 * library for OSM strings; weekly intervals allow endMin > 1440.
 */

export type HoursValue = { osm: string } | { weekly: WeeklyIntervals };

// NYC-centric nominatim stub the library uses for holiday rules. Its sun times are unusable here: it
// reads coordinates only as strings (these numbers, as its types declare them, leave it on its fixed
// 06:00 and 18:00) and would report the times in the server's timezone, not the venue's. So
// evaluateHours puts the real ones into the rule first (withSunTimes).
const NOMINATIM = { lat: 40.7185, lon: -73.988, address: { country_code: "us", state: "New York" } };

export interface HoursEvaluation {
  /** Is the venue open at `at`? null when the rule string is unparseable. */
  openNow: boolean | null;
  /** The interval containing `at` if open, else the next opening interval within 36h, else null. */
  interval: OpenInterval | null;
  /** True when the venue is open 24/7 (no closing constraint). */
  always: boolean;
  parseError: string | null;
  /**
   * The answer may not match the venue: the rule uses school-holiday syntax the library approximates,
   * or it has public-holiday rules and `at` falls on (or the day before) one, when venues read "PH"
   * differently. A PH rule on an ordinary day is exact, and so is a sun-relative one (the real sun).
   */
  approximate: boolean;
}

export function isHoursValue(v: unknown): v is HoursValue {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o["osm"] === "string" || Array.isArray(o["weekly"]);
}

/**
 * Parsing a rule costs ~0.5 ms and evaluating it over a window as much again, for every candidate on
 * every request, while most venues share a handful of rule strings. Parsed rules are cached by rule
 * (a sun-relative one once its times are filled in for the day), and each rule's open intervals by
 * local day. The caches are bounded LRUs; the results are identical to evaluating from scratch.
 */
const PARSED_MAX = 5_000;
const INTERVALS_MAX = 20_000;

interface ParsedRule {
  oh: opening_hours | null;
  error: string | null;
  approximate: boolean;
  /** The rule has public-holiday (PH) selectors: exact on ordinary days, approximate on holidays. */
  publicHolidays: boolean;
}

const parsed = new Map<string, ParsedRule>();
const intervals = new Map<string, [Date, Date, boolean, string | undefined][]>();

function remember<V>(cache: Map<string, V>, key: string, max: number, make: () => V): V {
  const hit = cache.get(key);
  if (hit !== undefined) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const value = make();
  cache.set(key, value);
  if (cache.size > max) cache.delete(cache.keys().next().value as string);
  return value;
}

const SUN_RELATIVE = /sunrise|sunset|dawn|dusk/;
// A sun time alone, or with an offset as OSM writes it: "sunset", "(sunset-01:00)", "(sunrise+00:30)".
const SUN_TIME = /\(\s*(sunrise|sunset|dawn|dusk)\s*([+-])\s*(\d{1,2}):(\d{2})\s*\)|\b(sunrise|sunset|dawn|dusk)\b/g;
type SunEvent = "sunrise" | "sunset" | "dawn" | "dusk";

const sunTimes = new Map<string, Record<SunEvent, Date>>();

/**
 * The rule with each sun-relative time replaced by its wall-clock time on `localDate` where the place
 * is, to the minute: sunrise and sunset, and dawn and dusk as civil twilight, as OSM means them. Null
 * when one does not occur that day (polar day or night). Evaluated over the days either side, the
 * day's times are within a couple of minutes of theirs.
 */
export function withSunTimes(rule: string, localDate: string, timeZone: string, lat: number, lon: number): string | null {
  // At the ~1 km bucket the place is in (the sun times differ by seconds within one), so the answer
  // does not depend on which place in it was asked about first.
  const [la, lo] = [lat.toFixed(2), lon.toFixed(2)];
  const sun = remember(sunTimes, `${localDate}\u0000${timeZone}\u0000${la},${lo}`, 2_000, () => SunCalc.getTimes(fromLocal(localDate, 12 * 60, timeZone), Number(la), Number(lo)));
  let missing = false;
  const out = rule.replace(SUN_TIME, (match, withOffset: SunEvent | undefined, sign: string | undefined, hh: string | undefined, mm: string | undefined, bare: SunEvent | undefined) => {
    const t = sun[(withOffset ?? bare)!];
    if (Number.isNaN(t.getTime())) {
      missing = true;
      return match;
    }
    const clock = localClock(new Date(Math.round(t.getTime() / 60_000) * 60_000), timeZone);
    const offset = withOffset ? (sign === "-" ? -1 : 1) * (Number(hh) * 60 + Number(mm)) : 0;
    const minutes = Math.max(0, clock.minutes + offset);
    return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
  });
  return missing ? null : out;
}

export function parseOsmHours(rule: string): ParsedRule {
  return remember(parsed, rule, PARSED_MAX, () => {
    try {
      const oh = new opening_hours(rule, NOMINATIM, { mode: 0, tag_key: "opening_hours", map_value: undefined, warnings_severity: undefined, locale: undefined });
      const warnings = oh.getWarnings();
      return { oh, error: null, approximate: warnings.length > 0 || /SH/.test(rule), publicHolidays: /\bPH\b/.test(rule) };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { oh: null, error: msg.split("\n")[0] ?? "parse error", approximate: false, publicHolidays: false };
    }
  });
}

/** New York public holidays (federal and state, with observed days), by wall-clock local day. */
const holidays = new Map<string, boolean>();
function isPublicHoliday(wallClockDay: Date): boolean {
  return remember(holidays, String(wallClockDay.getTime()), 2_000, () => parseOsmHours("PH").oh?.getState(new Date(wallClockDay.getTime() + 12 * 3_600_000)) ?? false);
}

/** Whether a local calendar day ("YYYY-MM-DD") is a New York public holiday, as `PH` in hours resolves it. */
export function isPublicHolidayOn(localDate: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(localDate);
  return m ? isPublicHoliday(new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : false;
}

export function clearHoursCaches(): void {
  parsed.clear();
  sunTimes.clear();
  intervals.clear();
  holidays.clear();
}

export function evaluateHours(value: HoursValue, at: Date, timeZone: string, geo?: { lat: number; lon: number }): HoursEvaluation {
  if ("osm" in value) {
    const rule = value.osm.trim();
    if (rule === "24/7") {
      return { openNow: true, interval: { open: new Date(at.getTime() - 86_400_000), close: new Date(at.getTime() + 86_400_000 * 365) }, always: true, parseError: null, approximate: false };
    }
    if (rule === "off" || rule === "closed") return { openNow: false, interval: null, always: false, parseError: null, approximate: false };
    // A sun-relative rule is read with the day's real sun times where the place is.
    const local = SUN_RELATIVE.test(rule) ? withSunTimes(rule, localClock(at, timeZone).date, timeZone, geo?.lat ?? 40.7185, geo?.lon ?? -73.988) : rule;
    if (local === null) return { openNow: null, interval: null, always: false, parseError: "no sunrise or sunset that day", approximate: false };
    const { oh, error, approximate: ruleApproximate, publicHolidays } = parseOsmHours(local);
    if (!oh) return { openNow: null, interval: null, always: false, parseError: error, approximate: false };
    // opening_hours works in the JS runtime's local timezone. We evaluate with a shifted "wall clock" Date
    // so that the library's local-time arithmetic matches the venue's timezone.
    const shifted = toWallClockDate(at, timeZone);
    // The intervals over [at − 24h, at + 36h], cut from one wider window per local day so repeat
    // evaluations (every candidate's arrival, every request that day) reuse it. Clipping reproduces
    // exactly what getOpenIntervals returns for the narrow window.
    const day = new Date(shifted.getFullYear(), shifted.getMonth(), shifted.getDate());
    const nextDay = new Date(shifted.getFullYear(), shifted.getMonth(), shifted.getDate() + 1);
    const approximate = ruleApproximate || (publicHolidays && (isPublicHoliday(day) || isPublicHoliday(nextDay)));
    const wide = remember(intervals, `${local}\u0000${timeZone}\u0000${day.getTime()}`, INTERVALS_MAX, () =>
      oh.getOpenIntervals(new Date(day.getTime() - 24 * 3_600_000), new Date(day.getTime() + 61 * 3_600_000)),
    );
    const lo = shifted.getTime() - 24 * 3_600_000;
    const hi = shifted.getTime() + 36 * 3_600_000;
    const its: [Date, Date, boolean][] = [];
    for (const [from, to, unknown] of wide) {
      const f = Math.max(from.getTime(), lo);
      const t = Math.min(to.getTime(), hi);
      if (t > f) its.push([new Date(f), new Date(t), unknown]);
    }
    let openNow = false;
    let interval: OpenInterval | null = null;
    for (const [from, to, unknown] of its) {
      if (from <= shifted && shifted < to) {
        openNow = !unknown;
        interval = { open: fromWallClockDate(from, timeZone), close: fromWallClockDate(to, timeZone) };
        break;
      }
    }
    if (!interval) {
      const next = its.find(([from]) => from > shifted);
      if (next) interval = { open: fromWallClockDate(next[0], timeZone), close: fromWallClockDate(next[1], timeZone) };
    }
    return { openNow, interval, always: false, parseError: null, approximate };
  }
  // weekly intervals
  const clock = localClock(at, timeZone);
  const candidates: OpenInterval[] = [];
  for (let dayOffset = -1; dayOffset <= 1; dayOffset++) {
    const wd = (clock.weekday + dayOffset + 7) % 7;
    const date = shiftDate(clock.date, dayOffset);
    for (const iv of value.weekly) {
      if (iv.weekday !== wd) continue;
      candidates.push({ open: fromLocal(date, iv.startMin, timeZone), close: fromLocal(date, iv.endMin, timeZone) });
    }
  }
  candidates.sort((a, b) => a.open.getTime() - b.open.getTime());
  const current = candidates.find((c) => c.open <= at && at < c.close) ?? null;
  const next = current ?? candidates.find((c) => c.open > at) ?? null;
  return { openNow: current !== null, interval: next, always: false, parseError: null, approximate: false };
}

/** Represent instant `at` (in `timeZone`) as a Date whose LOCAL fields equal that wall clock. */
const wallClockFormats = new Map<string, Intl.DateTimeFormat>();

function toWallClockDate(at: Date, timeZone: string): Date {
  let fmt = wallClockFormats.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    wallClockFormats.set(timeZone, fmt);
  }
  const p = Object.fromEntries(fmt.formatToParts(at).map((x) => [x.type, x.value]));
  return new Date(+p["year"]!, +p["month"]! - 1, +p["day"]!, +p["hour"]!, +p["minute"]!, +p["second"]!);
}

function fromWallClockDate(wall: Date, timeZone: string): Date {
  const date = `${wall.getFullYear()}-${String(wall.getMonth() + 1).padStart(2, "0")}-${String(wall.getDate()).padStart(2, "0")}`;
  return fromLocal(date, wall.getHours() * 60 + wall.getMinutes(), timeZone);
}

function shiftDate(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}
