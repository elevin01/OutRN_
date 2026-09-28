/**
 * Regenerates fixtures/golden/scenarios.json: what the engine ranks first for each golden scenario,
 * on the synthetic areas. Run it when a ranking change is intended, and review the diff.
 *
 *   pnpm golden
 */
process.env["TZ"] = "UTC";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { formatGolden, GOLDEN_FILE, runGolden, seedGolden } from "./golden-lib.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const BASE = process.env["DATABASE_URL"] ?? "postgres://outrn@127.0.0.1:54329/outrn";
const DB_URL = BASE.replace(/\/[^/]+$/, "/outrn_golden");

const admin = new pg.Pool({ connectionString: BASE });
if (!(await admin.query("select 1 from pg_database where datname = 'outrn_golden'")).rowCount) await admin.query("create database outrn_golden");
await admin.end();
const db = new pg.Pool({ connectionString: DB_URL });
try {
  await db.query("create extension if not exists postgis; create extension if not exists pgcrypto;");
  await seedGolden(db, ROOT);
  const results = await runGolden(db);
  const path = resolve(ROOT, GOLDEN_FILE);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, formatGolden(results), "utf8");
  for (const r of results) console.log(`${r.id.padEnd(28)} ${r.top.map((t) => `${t.name}${t.status === "check_first" ? "*" : ""}`).join(", ") || "(none)"}`);
  console.log(`\nwrote ${results.length} scenarios to ${GOLDEN_FILE} (* = Check first)`);
} finally {
  await db.end();
}
