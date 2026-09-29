import type { Command } from "commander";
import { getDb } from "@outrn/db";
import { refreshWeather } from "@outrn/ingest";

export function registerWeather(program: Command): void {
  const weather = program.command("weather").description("Hourly forecasts from the National Weather Service, which requests read (rain and cold favour indoor places)");

  weather
    .command("refresh")
    .description("Fetch and store each served area's hourly forecast (run it hourly; requests ignore one over 12 hours old)")
    .option("--area <slug>", "one area (default: every served area)")
    .option("--from-file <path>", "replay a saved NWS hourly forecast instead of fetching (needs --area)")
    .option("--save <path>", "save the fetched forecast for replay (needs --area)")
    .action(async (o: { area?: string; fromFile?: string; save?: string }) => {
      const r = await refreshWeather(getDb(), { ...(o.area ? { areaSlug: o.area } : {}), ...(o.fromFile ? { fromFile: o.fromFile } : {}), ...(o.save ? { saveTo: o.save } : {}), log: (l) => console.log(l) });
      if (!r.length) console.log("no served areas: switch one on with outrn areas launch <slug>");
    });
}
