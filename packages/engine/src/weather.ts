import type { Queryable } from "@outrn/db";
import type { RequestContext } from "./types.js";

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

/**
 * The weather a plan should allow for: over the first two hours of the window (all of a shorter one),
 * the highest chance of rain and the lowest temperature. Null when the forecast was issued more than
 * 12 hours before the request, or does not cover the plan's start: no weather is better than wrong weather.
 */
export function weatherFor(hours: readonly ForecastHour[], issuedAt: Date, at: Date, windowMinutes: number, now: Date): RequestContext["weather"] {
  if (now.getTime() - issuedAt.getTime() > FORECAST_MAX_AGE_HOURS * 3_600_000) return null;
  const start = at.getTime();
  const end = start + Math.max(1, Math.min(windowMinutes, LOOKAHEAD_MINUTES)) * 60_000;
  const span = hours.filter((h) => Number.isFinite(h.temperatureF) && Date.parse(h.start) < end && Date.parse(h.end) > start);
  if (!span.some((h) => Date.parse(h.start) <= start)) return null;
  const chances = span.map((h) => h.precipProbability).filter((p): p is number => typeof p === "number" && Number.isFinite(p));
  return { temperatureF: Math.min(...span.map((h) => h.temperatureF)), precipProbability: chances.length ? Math.max(...chances) : null };
}

/** The area's stored forecast, as weather for this plan (see weatherFor). */
export async function loadWeather(q: Queryable, areaId: string, at: Date, windowMinutes: number, now: Date): Promise<RequestContext["weather"]> {
  const r = await q.query<{ issued_at: Date; hours: ForecastHour[] }>(`select issued_at, hours from weather_forecasts where area_id = $1`, [areaId]);
  const row = r.rows[0];
  return row && Array.isArray(row.hours) ? weatherFor(row.hours, row.issued_at, at, windowMinutes, now) : null;
}
