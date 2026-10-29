#!/usr/bin/env node
// Deterministic time arithmetic: the opening_hours library uses the runtime's local timezone,
// and we shift wall clocks ourselves. UTC keeps that shift exact on every machine.
process.env["TZ"] = "UTC";

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { closeDb, getDb, migrate, reset } from "@outrn/db";
import { registerIngest } from "./cmd/ingest.js";
import { registerRecommend } from "./cmd/recommend.js";
import { registerOps } from "./cmd/ops.js";
import { registerBacktest } from "./cmd/backtest.js";
import { registerFacts } from "./cmd/facts.js";
import { registerVenues } from "./cmd/venues.js";
import { registerAreas } from "./cmd/areas.js";
import { registerWeather } from "./cmd/weather.js";
import { registerRefresh } from "./cmd/refresh.js";
import { registerAi } from "./cmd/ai.js";

// The repository's .env (keys, a database URL), under whatever the shell already set: `pnpm real`'s
// own database and anything exported first win.
const ENV_FILE = fileURLToPath(new URL("../../../.env", import.meta.url));
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

const program = new Command().name("outrn").description("OutRN supply pipeline and recommendation engine").version("0.1.0");

program
  .command("migrate")
  .description("Apply pending SQL migrations")
  .option("--reset", "drop everything and re-apply (development only)")
  .option("--reapply <file...>", "run an applied migration again (a database that applied an earlier draft of it)")
  .action(async (o: { reset?: boolean; reapply?: string[] }) => {
    const db = getDb();
    const r = o.reset ? await reset(db) : await migrate(db, undefined, { reapply: o.reapply ?? [] });
    console.log(`applied: ${r.applied.join(", ") || "none"}; already applied: ${r.skipped.length}`);
  });

registerIngest(program);
registerRecommend(program);
registerOps(program);
registerBacktest(program);
registerFacts(program);
registerVenues(program);
registerAreas(program);
registerWeather(program);
registerRefresh(program);
registerAi(program);

program.hook("postAction", async () => {
  await closeDb();
});

program.parseAsync(process.argv).catch(async (e) => {
  console.error(`error: ${(e as Error).message}`);
  await closeDb();
  process.exit(1);
});
