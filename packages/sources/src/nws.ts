import { z } from "zod";
import type { LatLon } from "@outrn/core";
import { guardedFetch } from "./fetch.js";

/**
 * National Weather Service hourly forecast for a point. Two calls: /points to find the
 * grid, then the hourly forecast URL it returns. Output is a compact hourly series the
 * engine's context rules consume. Weather is a suitability signal; closures win.
 */

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
        temperature: z.number(),
        temperatureUnit: z.string(),
        probabilityOfPrecipitation: z.object({ value: z.number().nullable() }).optional(),
        shortForecast: z.string().optional(),
        windSpeed: z.string().optional(),
      }),
    ),
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
}

export async function fetchHourlyForecast(p: LatLon): Promise<ForecastResult> {
  const common = { sourceId: "nws", accept: "application/geo+json, application/json", allowedContentTypes: ["application/geo+json", "application/json", "application/ld+json"], minIntervalMs: 1000, allowCrossHostRedirect: false };
  const pts = await guardedFetch(`https://api.weather.gov/points/${p.lat.toFixed(4)},${p.lon.toFixed(4)}`, common);
  const forecastUrl = PointsSchema.parse(JSON.parse(pts.text)).properties.forecastHourly;
  const hr = await guardedFetch(forecastUrl, common);
  const parsed = HourlySchema.parse(JSON.parse(hr.text));
  const hours = parsed.properties.periods.map((pe) => ({
    start: new Date(pe.startTime),
    end: new Date(pe.endTime),
    temperatureF: pe.temperatureUnit === "C" ? Math.round((pe.temperature * 9) / 5 + 32) : pe.temperature,
    precipProbability: pe.probabilityOfPrecipitation?.value ?? null,
    shortForecast: pe.shortForecast ?? "",
  }));
  return { hours, fetchedAt: hr.fetchedAt, sourceUpdatedAt: parsed.properties.updateTime ? new Date(parsed.properties.updateTime) : null };
}

/** Pick the forecast hour covering `at`, or null if outside the series. */
export function weatherAt(f: ForecastResult | null, at: Date): HourlyWeather | null {
  if (!f) return null;
  return f.hours.find((h) => h.start <= at && at < h.end) ?? null;
}
