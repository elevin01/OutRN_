import { createHash } from "node:crypto";
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

export interface MigrateOptions {
  /**
   * Applied migrations to run again and re-record: for a database that applied an earlier draft of a
   * file. Each named file must be safe to run twice (if not exists / drop if exists).
   */
  reapply?: readonly string[];
}

const checksum = (sql: string) => createHash("md5").update(sql, "utf8").digest("hex");

/**
 * Forward-only SQL migrations, applied in filename order inside one transaction each.
 * Tracked in schema_migrations. Same files run against local Postgres and Supabase.
 *
 * An applied migration must still be the file that ran, under the same name. Edited afterwards, its
 * new statements would never reach this database, which would silently report itself up to date;
 * deleted or renamed, the database's history no longer matches the repository. Either stops
 * everything before anything runs, naming the file and the way out.
 */
export async function migrate(db: Db, dir: string = MIGRATIONS_DIR, opts: MigrateOptions = {}): Promise<MigrationResult> {
  await db.query(`create table if not exists schema_migrations (
    name text primary key,
    applied_at timestamptz not null default now(),
    checksum text not null
  )`);
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const sqlOf = new Map(await Promise.all(files.map(async (f) => [f, await readFile(join(dir, f), "utf8")] as const)));
  const done = new Map((await db.query<{ name: string; checksum: string }>("select name, checksum from schema_migrations")).rows.map((r) => [r.name, r.checksum]));
  // A migration this database applied must still exist under its name: deleted or renamed, the
  // database's history can no longer be reproduced from the repository.
  const missing = [...done.keys()].filter((f) => !sqlOf.has(f)).sort();
  if (missing.length) {
    const one = missing.length === 1;
    throw new Error(
      `${one ? "migration" : "migrations"} ${missing.join(", ")} ${one ? "was" : "were"} applied to this database but ${one ? "is" : "are"} missing from ${dir}, ` +
        `so its history cannot be reproduced from the repository. Restore ${one ? "the file" : "the files"} under the same name from git history; ` +
        `never delete or rename an applied migration (--reapply cannot help: there is nothing to run).`,
    );
  }
  const reapply = new Set(opts.reapply ?? []);
  for (const f of reapply) if (!done.has(f) || !sqlOf.has(f)) throw new Error(`cannot re-apply ${f}: it is not an applied migration in ${dir}`);
  const changed = files.filter((f) => done.has(f) && done.get(f) !== checksum(sqlOf.get(f)!) && !reapply.has(f));
  if (changed.length) {
    throw new Error(
      `${changed.length === 1 ? "migration" : "migrations"} ${changed.join(", ")} changed after this database applied ${changed.length === 1 ? "it" : "them"}, ` +
        `so the new statements would never run here. Never edit an applied migration; add a new one. ` +
        `If this database ran an earlier draft and the file is safe to run again, re-apply it: ` +
        changed.map((f) => `pnpm db:migrate --reapply ${f}`).join(" && "),
    );
  }
  const applied: string[] = [];
  const skipped: string[] = [];
  for (const f of files) {
    if (done.has(f) && !reapply.has(f)) {
      skipped.push(f);
      continue;
    }
    const sql = sqlOf.get(f)!;
    const client = await db.connect();
    try {
      await client.query("begin");
      await client.query(sql);
      await client.query(
        "insert into schema_migrations(name, checksum) values ($1, $2) on conflict (name) do update set checksum = excluded.checksum, applied_at = now()",
        [f, checksum(sql)],
      );
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
