// Opening-hours evaluation shifts wall clocks in the runtime's local zone; UTC keeps that exact on
// every machine (the CLI does the same).
process.env["TZ"] = "UTC";

import { serve } from "@hono/node-server";
import { createMockApp } from "../mock/app.js";

/** The mock API over the contract fixtures. No database needed. `pnpm api:mock`. */

const port = Number(process.env["PORT"] ?? process.env["OUTRN_API_PORT"] ?? 4000);
serve({ fetch: createMockApp({ log: (line) => console.log(line) }).fetch, port, hostname: process.env["HOST"] ?? "127.0.0.1" }, (info) => {
  console.log(`outrn MOCK api listening on http://${info.address}:${info.port} · fixtures from @outrn/contracts`);
});
