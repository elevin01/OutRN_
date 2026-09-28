import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { testDatabaseAvailable } from "@outrn/db";
import { formatGolden, GOLDEN_FILE, runGolden, seedGolden, type GoldenResult } from "../scripts/golden-lib.js";

/**
 * The engine's ranking on the golden scenarios must match fixtures/golden/scenarios.json. When a
 * change moves it on purpose, run `pnpm golden` and commit the diff for review.
 */

const ROOT = resolve(__dirname, "../../..");
const BASE = process.env["DATABASE_URL"] ?? "postgres://outrn@127.0.0.1:54329/outrn";
const TEST_URL = BASE.replace(/\/[^/]+$/, "/outrn_test");
const available = await testDatabaseAvailable(BASE);
let db: pg.Pool;

beforeAll(async () => {
  if (!available) return;
  const admin = new pg.Pool({ connectionString: BASE });
  try {
    if (!(await admin.query("select 1 from pg_database where datname = 'outrn_test'")).rowCount) await admin.query("create database outrn_test");
  } finally {
    await admin.end();
  }
  db = new pg.Pool({ connectionString: TEST_URL });
  await db.query("create extension if not exists postgis; create extension if not exists pgcrypto;");
  await seedGolden(db, ROOT);
});

afterAll(async () => {
  if (db) await db.end();
});

/** One line per ranked item, so a failure reads as the ranking change itself. */
const lines = (results: GoldenResult[]) => results.flatMap((r) => [`${r.id} (${r.eligible} eligible)`, ...r.top.map((t) => `  ${t.rank}. ${t.name} [${t.status}] ${t.reasons.join(",")}${t.caveats.length ? ` | ${t.caveats.join(",")}` : ""}`), ...(r.relaxations.length ? [`  relax: ${r.relaxations.join(",")}`] : [])]);

describe.skipIf(!available)("golden scenarios: the engine's ranking is reviewed, never a surprise", () => {
  it(`matches ${GOLDEN_FILE} (after an intended change, run \`pnpm golden\` and review the diff)`, async () => {
    const expected = JSON.parse(readFileSync(resolve(ROOT, GOLDEN_FILE), "utf8")) as { scenarios: GoldenResult[] };
    const actual = await runGolden(db);
    expect(lines(actual)).toEqual(lines(expected.scenarios));
    expect(formatGolden(actual)).toBe(readFileSync(resolve(ROOT, GOLDEN_FILE), "utf8"));
  });
});
