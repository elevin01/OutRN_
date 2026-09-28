import type { Command } from "commander";
import { areaSupply, getArea, getDb, insertArea, isServedArea, listAreas, loadParkingRule, SERVED_LAUNCH_STATES, setLaunchState, updateArea, type LaunchState, type ServiceAreaRow } from "@outrn/db";
import { ingestExtentFor } from "@outrn/ingest";

/**
 * Service areas and their lifecycle. A new area starts 'ingest_only' (filled, not served):
 *   areas add → ingest osm → backtest → areas launch
 */

const MODES = ["walk", "drive", "transit"] as const;
const SLUG = /^[a-z][a-z0-9_]{1,39}$/;

function mode(v: string): ServiceAreaRow["travel_mode"] {
  if (!(MODES as readonly string[]).includes(v)) throw new Error(`--mode must be one of ${MODES.join(", ")}`);
  return v as ServiceAreaRow["travel_mode"];
}

function number(name: string, min: number, max: number) {
  return (v: string) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${name} must be a number between ${min} and ${max}`);
    return n;
  };
}

async function describeArea(area: ServiceAreaRow): Promise<string> {
  const db = getDb();
  const extent = ingestExtentFor(area, await loadParkingRule(db, area.slug));
  const supply = await areaSupply(db, area, extent.radiusM);
  const last = supply.lastIngestAt ? supply.lastIngestAt.toISOString().slice(0, 10) : "never";
  return `${area.slug.padEnd(14)} ${area.launch_state.padEnd(12)} ${area.travel_mode.padEnd(8)} catchment ${String(area.radius_m ?? "-").padStart(5)} m · ingest ${String(extent.radiusM).padStart(6)} m · ${String(supply.eligibleVenues).padStart(6)} eligible venues · last ingest ${last} · ${area.name}`;
}

export function registerAreas(program: Command): void {
  const areas = program.command("areas").description("Service areas: list, add, adjust, launch and pause");

  areas
    .command("list")
    .description("Every area with its state, catchment, derived ingest extent, supply and last ingest")
    .action(async () => {
      for (const area of await listAreas(getDb())) console.log(await describeArea(area));
      console.log(`\nServed by the API: ${SERVED_LAUNCH_STATES.join(", ")}. New areas start ingest_only.`);
    });

  areas
    .command("add <slug>")
    .description("Add an area (starts ingest_only: filled by ingest, not served until launched)")
    .requiredOption("--name <name>", "display name, e.g. \"Mount Kisco\"")
    .requiredOption("--lat <n>", "center latitude (the downtown / main street)", number("--lat", -90, 90))
    .requiredOption("--lon <n>", "center longitude", number("--lon", -180, 180))
    .option("--radius <m>", "origin catchment in metres (where people open the app from)", number("--radius", 300, 20_000), 2500)
    .option("--mode <walk|drive|transit>", "default travel mode", mode, "drive")
    .option("--timezone <iana>", "IANA timezone", "America/New_York")
    .action(async (slug: string, o: { name: string; lat: number; lon: number; radius: number; mode: ServiceAreaRow["travel_mode"]; timezone: string }) => {
      if (!SLUG.test(slug)) throw new Error("slug must be lowercase letters, digits and underscores, starting with a letter");
      const area = await insertArea(getDb(), { slug, name: o.name, lat: o.lat, lon: o.lon, radiusM: o.radius, travelMode: o.mode, timezone: o.timezone });
      console.log(await describeArea(area));
      console.log(`\nNext: pnpm outrn ingest osm --area ${slug} --save fixtures/live/${slug}.json`);
    });

  areas
    .command("set <slug>")
    .description("Adjust an area's name, center, catchment or default travel mode")
    .option("--name <name>")
    .option("--lat <n>", "center latitude", number("--lat", -90, 90))
    .option("--lon <n>", "center longitude", number("--lon", -180, 180))
    .option("--radius <m>", "origin catchment in metres", number("--radius", 300, 20_000))
    .option("--mode <walk|drive|transit>", "default travel mode", mode)
    .action(async (slug: string, o: { name?: string; lat?: number; lon?: number; radius?: number; mode?: ServiceAreaRow["travel_mode"] }) => {
      if ((o.lat === undefined) !== (o.lon === undefined)) throw new Error("set --lat and --lon together");
      const area = await updateArea(getDb(), slug, { ...(o.name ? { name: o.name } : {}), ...(o.lat !== undefined ? { lat: o.lat, lon: o.lon! } : {}), ...(o.radius ? { radiusM: o.radius } : {}), ...(o.mode ? { travelMode: o.mode } : {}) });
      console.log(await describeArea(area));
      if (o.lat !== undefined || o.radius || o.mode) console.log(`\nThe ingest extent may have changed: re-run pnpm outrn ingest osm --area ${slug}`);
    });

  areas
    .command("launch <slug>")
    .description("Open an area in the API (default state: test)")
    .option("--state <test|private_beta|live>", "launch state", "test")
    .option("--force", "launch even with no eligible venues")
    .action(async (slug: string, o: { state: string; force?: boolean }) => {
      if (!(SERVED_LAUNCH_STATES as readonly string[]).includes(o.state)) throw new Error(`--state must be one of ${SERVED_LAUNCH_STATES.join(", ")}`);
      const db = getDb();
      const area = await getArea(db, slug);
      const extent = ingestExtentFor(area, await loadParkingRule(db, slug));
      const supply = await areaSupply(db, area, extent.radiusM);
      if (supply.eligibleVenues === 0 && !o.force) throw new Error(`${slug} has no eligible venues yet: run pnpm outrn ingest osm --area ${slug} first (or --force)`);
      const launched = await setLaunchState(db, slug, o.state as LaunchState);
      console.log(await describeArea(launched));
      if (!supply.lastIngestAt) console.log("\nNote: no successful ingest recorded for this area; its venues came from neighbouring areas' ingests.");
    });

  areas
    .command("pause <slug>")
    .description("Stop serving an area (supply is kept)")
    .action(async (slug: string) => {
      const area = await setLaunchState(getDb(), slug, "paused");
      console.log(await describeArea(area));
      console.log(`\n${isServedArea(area) ? "still served" : "no longer served by the API"}`);
    });
}
