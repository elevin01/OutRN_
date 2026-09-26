import opening_hours from "opening_hours";
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

// NYC-centric nominatim stub the library uses for holiday/sunset rules. Sunset-based rules need lat/lon.
function nominatim(lat: number, lon: number) {
  return { lat, lon, address: { country_code: "us", state: "New York" } };
}

export interface HoursEvaluation {
  /** Is the venue open at `at`? null when the rule string is unparseable. */
  openNow: boolean | null;
  /** The interval containing `at` if open, else the next opening interval within 36h, else null. */
  interval: OpenInterval | null;
  /** True when the venue is open 24/7 (no closing constraint). */
  always: boolean;
  parseError: string | null;
  /** Rule uses seasonal/holiday/sunset syntax that the library approximates. */
  approximate: boolean;
}

export function isHoursValue(v: unknown): v is HoursValue {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o["osm"] === "string" || Array.isArray(o["weekly"]);
}

export function parseOsmHours(rule: string, lat = 40.7185, lon = -73.988): { oh: opening_hours | null; error: string | null; approximate: boolean } {
  try {
    const oh = new opening_hours(rule, nominatim(lat, lon), { mode: 0, tag_key: "opening_hours", map_value: undefined, warnings_severity: undefined, locale: undefined });
    const warnings = oh.getWarnings();
    return { oh, error: null, approximate: warnings.length > 0 || /sunrise|sunset|dawn|dusk|PH|SH/.test(rule) };
  } catch (e) {
    return { oh: null, error: (e as Error).message.split("\n")[0] ?? "parse error", approximate: false };
  }
}

export function evaluateHours(value: HoursValue, at: Date, timeZone: string, geo?: { lat: number; lon: number }): HoursEvaluation {
  if ("osm" in value) {
    const rule = value.osm.trim();
    if (rule === "24/7") {
      return { openNow: true, interval: { open: new Date(at.getTime() - 86_400_000), close: new Date(at.getTime() + 86_400_000 * 365) }, always: true, parseError: null, approximate: false };
    }
    if (rule === "off" || rule === "closed") return { openNow: false, interval: null, always: false, parseError: null, approximate: false };
    const { oh, error, approximate } = parseOsmHours(rule, geo?.lat, geo?.lon);
    if (!oh) return { openNow: null, interval: null, always: false, parseError: error, approximate: false };
    // opening_hours works in the JS runtime's local timezone. We evaluate with a shifted "wall clock" Date
    // so that the library's local-time arithmetic matches the venue's timezone.
    const shifted = toWallClockDate(at, timeZone);
    const openNow = oh.getState(shifted);
    const horizon = new Date(shifted.getTime() + 36 * 3_600_000);
    const its = oh.getOpenIntervals(new Date(shifted.getTime() - 24 * 3_600_000), horizon);
    let interval: OpenInterval | null = null;
    for (const [from, to] of its) {
      if (from <= shifted && shifted < to) {
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
function toWallClockDate(at: Date, timeZone: string): Date {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
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
