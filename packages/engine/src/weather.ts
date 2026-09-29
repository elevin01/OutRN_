import type { Queryable } from "@outrn/db";
import type { RequestContext } from "./types.js";
import { WEATHER_LIMITS } from "./forecast.js";

/** One forecast hour as stored (weather_forecasts.hours). */
export interface ForecastHour {
  start: string;
  end: string;
  temperatureF: number;
  precipProbability: number | null;
}

/** Where forecasts come from (source_policies), for the attributions of a plan they shaped. */
export const WEATHER_SOURCE = "nws";

/** A forecast older than this is not today's: NWS reissues hourly. */
export const FORECAST_MAX_AGE_HOURS = 12;
/** The part of the window a forecast speaks for: the first two hours, where the plan starts. */
const LOOKAHEAD_MINUTES = 120;
/** A forecast issued after the request is not one it could have read: clocks agree to within this. */
const CLOCK_SKEW_MS = 5 * 60_000;

/**
 * The weather a plan should allow for: over the first two hours of the window (all of a shorter one),
 * the highest chance of rain and the lowest temperature (and the highest, for heat), with the span read.
 * The forecast is read from the plan's start for as long as it runs without a gap: nothing after a
 * gap or past its end is read, and `until` says where the reading stopped, so nothing is ever said
 * about an hour the forecast did not cover. The chance of rain is unknown (null) unless it is given
 * for every minute of the two hours, or some hour read is already wet: an hour without one, a gap, or
 * the end of the forecast could be the wet one. Null when the forecast was issued more than 12 hours
 * before the request or after it, or does not cover the plan's start: no weather is better than wrong weather.
 */
export function weatherFor(hours: readonly ForecastHour[], issuedAt: Date, at: Date, windowMinutes: number, now: Date): RequestContext["weather"] {
  const age = now.getTime() - issuedAt.getTime();
  if (!(age <= FORECAST_MAX_AGE_HOURS * 3_600_000 && age >= -CLOCK_SKEW_MS)) return null;
  const start = at.getTime();
  const end = start + Math.max(1, Math.min(windowMinutes, LOOKAHEAD_MINUTES)) * 60_000;
  const span = hours
    .filter((h) => h !== null && typeof h === "object" && Number.isFinite(h.temperatureF) && Date.parse(h.start) < end && Date.parse(h.end) > start)
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  // The hours read: from the start, each one beginning no later than the last one read ends.
  const read: ForecastHour[] = [];
  let reach = start;
  for (const h of span) {
    if (Date.parse(h.start) > reach) break; // a gap: what follows is not this plan's weather
    read.push(h);
    reach = Math.max(reach, Date.parse(h.end));
  }
  if (!read.length) return null;
  const until = Math.min(reach, end);
  // Dry needs a chance of rain for all of it: an hour without one, a gap, or the forecast's end could be the wet one.
  const chance = (h: ForecastHour) => (typeof h.precipProbability === "number" && Number.isFinite(h.precipProbability) ? h.precipProbability : null);
  const known = read.map(chance).filter((p): p is number => p !== null);
  const wettest = known.reduce((m, p) => Math.max(m, p), -Infinity);
  const everyMinute = reach >= end && read.every((h) => chance(h) !== null);
  const precipProbability = known.length && (everyMinute || wettest >= WEATHER_LIMITS.rainChance) ? wettest : null;
  return {
    temperatureF: read.reduce((m, h) => Math.min(m, h.temperatureF), Infinity),
    precipProbability,
    highF: read.reduce((m, h) => Math.max(m, h.temperatureF), -Infinity),
    from: new Date(start),
    until: new Date(until),
  };
}

/** The area's stored forecast, as weather for this plan (see weatherFor). */
export async function loadWeather(q: Queryable, areaId: string, at: Date, windowMinutes: number, now: Date): Promise<RequestContext["weather"]> {
  const r = await q.query<{ issued_at: Date; hours: ForecastHour[] }>(`select issued_at, hours from weather_forecasts where area_id = $1`, [areaId]);
  const row = r.rows[0];
  return row && Array.isArray(row.hours) ? weatherFor(row.hours, row.issued_at, at, windowMinutes, now) : null;
}
