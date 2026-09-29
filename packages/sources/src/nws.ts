import { z } from "zod";
import type { LatLon } from "@outrn/core";
import { FetchBlocked, guardedFetch } from "./fetch.js";

/**
 * National Weather Service hourly forecast for a point. Two calls: /points to find the
 * grid, then the hourly forecast URL it returns. Output is a compact hourly series the
 * engine's context rules consume. Weather is a suitability signal; closures win.
 */

const NWS_HOST = "api.weather.gov";
/** NWS sends 156 hourly periods (6.5 days); many more is not an hourly forecast, and every request reads them all. */
const MAX_PERIODS = 500;
/** An hourly period is an hour; a longer one would speak for hours it does not describe. */
const MAX_PERIOD_MS = 2 * 3_600_000;

const PointsSchema = z.object({
  properties: z.object({ forecastHourly: z.string().url(), timeZone: z.string().optional() }),
});
const HourlySchema = z.object({
  properties: z.object({
    updateTime: z.string().optional(),
    periods: z.array(
      z.object({
        startTime: z.string(),
        endTime: z.string(),
        // Plausible in either unit; JSON's 1e999 reads as Infinity and is refused here too.
        temperature: z.number().min(-200).max(200),
        temperatureUnit: z.enum(["F", "C"]),
        probabilityOfPrecipitation: z.object({ value: z.number().min(0).max(100).nullable() }).optional(),
        shortForecast: z.string().optional(),
        windSpeed: z.string().optional(),
      }),
    ).max(MAX_PERIODS),
  }),
});

export interface HourlyWeather {
  start: Date;
  end: Date;
  temperatureF: number;
  precipProbability: number | null; // 0..100
  shortForecast: string;
}

export interface ForecastResult {
  hours: HourlyWeather[];
  fetchedAt: Date;
  sourceUpdatedAt: Date | null;
  /** The hourly forecast as NWS sent it: what `--save` keeps for replay. */
  raw: string;
}

/** An NWS hourly forecast (the body of its forecastHourly URL) → hours in °F, in time order. */
export function parseHourlyForecast(text: string, fetchedAt: Date): ForecastResult {
  const parsed = HourlySchema.parse(JSON.parse(text));
  const hours = parsed.properties.periods
    .map((pe) => ({
      start: new Date(pe.startTime),
      end: new Date(pe.endTime),
      temperatureF: pe.temperatureUnit === "C" ? Math.round((pe.temperature * 9) / 5 + 32) : pe.temperature,
      precipProbability: pe.probabilityOfPrecipitation?.value ?? null,
      shortForecast: pe.shortForecast ?? "",
    }))
    .filter((h) => !Number.isNaN(h.start.getTime()) && !Number.isNaN(h.end.getTime()) && h.end > h.start && h.end.getTime() - h.start.getTime() <= MAX_PERIOD_MS)
    .sort((x, y) => x.start.getTime() - y.start.getTime());
  const updated = parsed.properties.updateTime ? new Date(parsed.properties.updateTime) : null;
  return { hours, fetchedAt, sourceUpdatedAt: updated && !Number.isNaN(updated.getTime()) ? updated : null, raw: text };
}

export async function fetchHourlyForecast(p: LatLon): Promise<ForecastResult> {
  const common = { sourceId: "nws", accept: "application/geo+json, application/json", allowedContentTypes: ["application/geo+json", "application/json", "application/ld+json"], minIntervalMs: 1000, allowCrossHostRedirect: false };
  const pts = await guardedFetch(`https://${NWS_HOST}/points/${p.lat.toFixed(4)},${p.lon.toFixed(4)}`, common);
  // The second URL comes from the first response: follow it only to the NWS API itself.
  const forecastUrl = new URL(PointsSchema.parse(JSON.parse(pts.text)).properties.forecastHourly);
  if (forecastUrl.protocol !== "https:" || forecastUrl.host !== NWS_HOST) throw new FetchBlocked(`forecast URL points off ${NWS_HOST}: ${forecastUrl.host}`);
  const hr = await guardedFetch(forecastUrl.toString(), common);
  return parseHourlyForecast(hr.text, hr.fetchedAt);
}

/** Pick the forecast hour covering `at`, or null if outside the series. */
export function weatherAt(f: ForecastResult | null, at: Date): HourlyWeather | null {
  if (!f) return null;
  return f.hours.find((h) => h.start <= at && at < h.end) ?? null;
}
