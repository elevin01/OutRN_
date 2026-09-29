import { readFile, writeFile } from "node:fs/promises";
import { assertSourceAllowed, getArea, isServedArea, listAreas, type Db, type ServiceAreaRow } from "@outrn/db";
import { fetchHourlyForecast, finishRun, parseHourlyForecast, startRun, type ForecastResult } from "@outrn/sources";

/**
 * Stores each area's hourly forecast from the National Weather Service (free, no key), for requests
 * to read: rain or cold sinks parks and outdoor seating, and favours places indoors. Run it on a
 * schedule (hourly is plenty); requests never call NWS, and ignore a forecast over 12 hours old.
 */

export interface WeatherRefreshOptions {
  /** One area; every served area when omitted. */
  areaSlug?: string;
  /** Replay a saved NWS hourly forecast (the body of its forecastHourly URL) instead of fetching. */
  fromFile?: string;
  /** Save the fetched forecast for replay. */
  saveTo?: string;
  clock?: () => Date;
  log?: (line: string) => void;
}

export interface WeatherRefreshResult {
  area: string;
  runId: string;
  hours: number;
  from: Date | null;
  to: Date | null;
  issuedAt: Date;
}

export async function refreshWeather(db: Db, opts: WeatherRefreshOptions = {}): Promise<WeatherRefreshResult[]> {
  const log = opts.log ?? (() => undefined);
  const areas: ServiceAreaRow[] = opts.areaSlug ? [await getArea(db, opts.areaSlug)] : (await listAreas(db)).filter(isServedArea);
  if ((opts.fromFile || opts.saveTo) && !opts.areaSlug) throw new Error("--from-file and --save need --area: a forecast is for one place");
  await assertSourceAllowed(db, "nws", opts.fromFile ? "retain" : "fetch");
  const out: WeatherRefreshResult[] = [];
  for (const area of areas) {
    const runId = await startRun(db, { sourceId: "nws", areaId: area.id, kind: opts.fromFile ? "replay" : "hourly_forecast", params: { from_file: opts.fromFile ?? null } });
    try {
      const now = opts.clock?.() ?? new Date();
      const f: ForecastResult = opts.fromFile ? parseHourlyForecast(await readFile(opts.fromFile, "utf8"), now) : await fetchHourlyForecast({ lat: Number(area.lat), lon: Number(area.lon) });
      if (!f.hours.length) throw new Error("the forecast has no hours");
      if (opts.saveTo && !opts.fromFile) await writeFile(opts.saveTo, f.raw, "utf8");
      const issuedAt = f.sourceUpdatedAt ?? f.fetchedAt;
      const hours = f.hours.map((h) => ({ start: h.start.toISOString(), end: h.end.toISOString(), temperatureF: h.temperatureF, precipProbability: h.precipProbability }));
      await db.query(
        `insert into weather_forecasts (area_id, source_id, issued_at, fetched_at, hours, ingestion_run_id) values ($1, 'nws', $2, $3, $4, $5)
         on conflict (area_id) do update set source_id = excluded.source_id, issued_at = excluded.issued_at, fetched_at = excluded.fetched_at, hours = excluded.hours, ingestion_run_id = excluded.ingestion_run_id`,
        [area.id, issuedAt, f.fetchedAt, JSON.stringify(hours), runId],
      );
      await finishRun(db, runId, { status: "succeeded", counts: { hours: hours.length } });
      const r = { area: area.slug, runId, hours: hours.length, from: f.hours[0]?.start ?? null, to: f.hours.at(-1)?.end ?? null, issuedAt };
      log(`${area.slug}: ${r.hours} hours, ${r.from?.toISOString() ?? "?"} to ${r.to?.toISOString() ?? "?"}, issued ${issuedAt.toISOString()}`);
      out.push(r);
    } catch (e) {
      await finishRun(db, runId, { status: "failed", error: (e as Error).message });
      throw new Error(`${area.slug}: ${(e as Error).message}`);
    }
  }
  return out;
}
