// Opening-hours evaluation shifts wall clocks in the runtime's local zone; UTC keeps that exact on
// every machine (the CLI does the same).
process.env["TZ"] = "UTC";

import { serve } from "@hono/node-server";
import { getDb } from "@outrn/db";
import { createApp } from "../http/app.js";

/** The real API: Postgres-backed. `pnpm api:dev` (watch) or `pnpm api:start`. */

const port = Number(process.env["PORT"] ?? process.env["OUTRN_API_PORT"] ?? 4000);
const opsToken = process.env["OUTRN_OPS_TOKEN"] || undefined;
const production = process.env["NODE_ENV"] === "production";
const app = createApp({
  db: getDb,
  opsToken,
  allowOpenOps: !production,
  corsOrigins: (process.env["OUTRN_WEB_ORIGINS"] ?? "http://localhost:3000,http://127.0.0.1:3000").split(",").map((s) => s.trim()).filter(Boolean),
  log: (line) => console.log(line),
});

serve({ fetch: app.fetch, port, hostname: process.env["HOST"] ?? "127.0.0.1" }, (info) => {
  console.log(`outrn api listening on http://${info.address}:${info.port} · ops ${opsToken ? "token required" : production ? "disabled" : "open (dev)"}`);
});
