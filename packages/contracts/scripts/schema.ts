/**
 * Writes (or checks) schema/v1.json: the whole v1 contract as JSON Schema. It is committed so every
 * contract change shows up as a reviewable diff, and CI compares it with the base branch's copy to
 * flag breaking changes (scripts/compat.ts).
 *
 *   pnpm --filter @outrn/contracts schema         # regenerate
 *   pnpm --filter @outrn/contracts schema:check   # fail if stale
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod/v4";
import { ApiError, CONTRACT_VERSION, ROUTES, type RouteSpec } from "../src/index.js";

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "../schema/v1.json");

function strip(schema: Record<string, unknown>): Record<string, unknown> {
  const { $schema: _drop, ...rest } = schema;
  return rest;
}

export function contractDocument(): string {
  const routes = Object.fromEntries(
    Object.entries(ROUTES as Record<string, RouteSpec>).map(([name, r]) => [
      name,
      {
        method: r.method,
        path: r.path,
        ...(r.ops ? { ops: true } : {}),
        ...(r.body ? { body: strip(z.toJSONSchema(r.body, { io: "input" }) as Record<string, unknown>) } : {}),
        response: strip(z.toJSONSchema(r.response, { io: "output" }) as Record<string, unknown>),
      },
    ]),
  );
  const doc = { $schema: "https://json-schema.org/draft/2020-12/schema", contract: CONTRACT_VERSION, routes, error: strip(z.toJSONSchema(ApiError, { io: "output" }) as Record<string, unknown>) };
  return JSON.stringify(doc, null, 2) + "\n";
}

const mode = process.argv[2] ?? "write";
const next = contractDocument();
if (mode === "check") {
  let current = "";
  try {
    current = readFileSync(OUT, "utf8");
  } catch {
    // missing counts as stale
  }
  if (current !== next) {
    console.error("packages/contracts/schema/v1.json is stale. Run `pnpm --filter @outrn/contracts schema` and commit the result.");
    process.exit(1);
  }
  console.log("contract schema is up to date");
} else {
  writeFileSync(OUT, next);
  console.log(`wrote ${OUT}`);
}
