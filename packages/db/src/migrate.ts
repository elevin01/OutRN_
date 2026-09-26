import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "./client.js";

const here = dirname(fileURLToPath(import.meta.url));
// Works from both src (tsx) and dist (compiled): migrations live beside the package root.
export const MIGRATIONS_DIR = join(here, "..", "migrations");

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

/**
 * Forward-only SQL migrations, applied in filename order inside one transaction each.
 * Tracked in schema_migrations. Same files run against local Postgres and Supabase.
 */
export async function migrate(db: Db, dir: string = MIGRATIONS_DIR): Promise<MigrationResult> {
  await db.query(`create table if not exists schema_migrations (
    name text primary key,
    applied_at timestamptz not null default now(),
    checksum text not null
  )`);
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const done = new Set((await db.query<{ name: string }>("select name from schema_migrations")).rows.map((r) => r.name));
  const applied: string[] = [];
  const skipped: string[] = [];
  for (const f of files) {
    if (done.has(f)) {
      skipped.push(f);
      continue;
    }
    const sql = await readFile(join(dir, f), "utf8");
    const client = await db.connect();
    try {
      await client.query("begin");
      await client.query(sql);
      await client.query("insert into schema_migrations(name, checksum) values ($1, md5($2))", [f, sql]);
      await client.query("commit");
      applied.push(f);
    } catch (e) {
      await client.query("rollback").catch(() => undefined);
      throw new Error(`migration ${f} failed: ${(e as Error).message}`);
    } finally {
      client.release();
    }
  }
  return { applied, skipped };
}

/** Drops the public schema and re-applies everything. Development only. */
export async function reset(db: Db): Promise<MigrationResult> {
  await db.query("drop schema public cascade; create schema public;");
  await db.query("create extension if not exists postgis; create extension if not exists pgcrypto;");
  return migrate(db);
}
