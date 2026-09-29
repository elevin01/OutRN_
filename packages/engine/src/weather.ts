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
 * the highest chance of rain and the lowest temperature (and the highest, for heat), with the span read. The chance of rain is unknown (null) unless it
 * is given for every minute of that span, or some hour is already wet: an hour without one, a gap, or
 * the end of the forecast could be the wet one. Null when the forecast was issued more than 12 hours
 * before the request or after it, or does not cover the plan's start: no weather is better than wrong weather.
 */
export function weatherFor(hours: readonly ForecastHour[], issuedAt: Date, at: Date, windowMinutes: number, now: Date): RequestContext["weather"] {
  const age = now.getTime() - issuedAt.getTime();
  if (!(age <= FORECAST_MAX_AGE_HOURS * 3_600_000 && age >= -CLOCK_SKEW_MS)) return null;
  const start = at.getTime();
  const end = start + Math.max(1, Math.min(windowMinutes, LOOKAHEAD_MINUTES)) * 60_000;
  const span = hours.filter((h) => h !== null && typeof h === "object" && Number.isFinite(h.temperatureF) && Date.parse(h.start) < end && Date.parse(h.end) > start);
  if (!span.some((h) => Date.parse(h.start) <= start)) return null;
  // Dry needs a chance of rain for all of it: an hour without one, or a gap, could be the wet one.
  const known = span.filter((h) => typeof h.precipProbability === "number" && Number.isFinite(h.precipProbability)).sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  let covered = start;
  let wettest = -Infinity;
  for (const h of known) {
    if (Date.parse(h.start) <= covered) covered = Math.max(covered, Date.parse(h.end));
    wettest = Math.max(wettest, h.precipProbability!);
  }
  const precipProbability = known.length && (covered >= end || wettest >= WEATHER_LIMITS.rainChance) ? wettest : null;
  return {
    temperatureF: span.reduce((m, h) => Math.min(m, h.temperatureF), Infinity),
    precipProbability,
    highF: span.reduce((m, h) => Math.max(m, h.temperatureF), -Infinity),
    from: new Date(start),
    until: new Date(end),
  };
}

/** The area's stored forecast, as weather for this plan (see weatherFor). */
export async function loadWeather(q: Queryable, areaId: string, at: Date, windowMinutes: number, now: Date): Promise<RequestContext["weather"]> {
  const r = await q.query<{ issued_at: Date; hours: ForecastHour[] }>(`select issued_at, hours from weather_forecasts where area_id = $1`, [areaId]);
  const row = r.rows[0];
  return row && Array.isArray(row.hours) ? weatherFor(row.hours, row.issued_at, at, windowMinutes, now) : null;
}
