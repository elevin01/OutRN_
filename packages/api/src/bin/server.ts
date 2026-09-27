import { serve } from "@hono/node-server";
import { getDb } from "@outrn/db";
import { createApp, openOpsAllowed } from "../http/app.js";

/** The real API: Postgres-backed. `pnpm api:dev` (watch) or `pnpm api:start`. */

const port = Number(process.env["PORT"] ?? process.env["OUTRN_API_PORT"] ?? 4000);
const opsToken = process.env["OUTRN_OPS_TOKEN"] || undefined;
// Without a token, ops routes are open only under NODE_ENV=development (`pnpm dev`); anywhere else they are disabled.
const allowOpenOps = openOpsAllowed(process.env["NODE_ENV"]);
const app = createApp({
  db: getDb,
  opsToken,
  allowOpenOps,
  corsOrigins: (process.env["OUTRN_WEB_ORIGINS"] ?? "http://localhost:3000,http://127.0.0.1:3000").split(",").map((s) => s.trim()).filter(Boolean),
  log: (line) => console.log(line),
});

serve({ fetch: app.fetch, port, hostname: process.env["HOST"] ?? "127.0.0.1" }, (info) => {
  console.log(`outrn api listening on http://${info.address}:${info.port} · ops ${opsToken ? "token required" : allowOpenOps ? "open (NODE_ENV=development)" : "disabled (set OUTRN_OPS_TOKEN)"}`);
});
