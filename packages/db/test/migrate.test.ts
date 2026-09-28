import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { migrate, testDatabaseAvailable } from "../src/index.js";

/**
 * The migration runner against a scratch database of its own (outrn_migrate_test), with migration
 * files in a temp directory. Skips without a local cluster unless OUTRN_REQUIRE_DB.
 */

const BASE = process.env["DATABASE_URL"] ?? "postgres://outrn@127.0.0.1:54329/outrn";
const TEST_URL = BASE.replace(/\/[^/]+$/, "/outrn_migrate_test");
const available = await testDatabaseAvailable(BASE);

let db: pg.Pool;
let dir: string;
const put = (name: string, sql: string) => writeFile(join(dir, name), sql, "utf8");
const columns = async () => (await db.query<{ column_name: string }>("select column_name from information_schema.columns where table_name = 't' order by column_name")).rows.map((r) => r.column_name);

beforeAll(async () => {
  if (!available) return;
  const admin = new pg.Pool({ connectionString: BASE });
  try {
    if (!(await admin.query("select 1 from pg_database where datname = 'outrn_migrate_test'")).rowCount) await admin.query("create database outrn_migrate_test");
  } finally {
    await admin.end();
  }
  db = new pg.Pool({ connectionString: TEST_URL });
});

beforeEach(async () => {
  if (!available) return;
  await db.query("drop table if exists t; drop table if exists schema_migrations");
  dir = await mkdtemp(join(tmpdir(), "outrn-migrations-"));
});

afterAll(async () => {
  if (db) await db.end();
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe.skipIf(!available)("migration runner", () => {
  it("applies pending files in order and then reports them up to date, non-ASCII text included", async () => {
    await put("0001_t.sql", "-- a table → with a comment the checksum must survive\ncreate table t (a int);");
    await put("0002_b.sql", "alter table t add column b int;");
    expect(await migrate(db, dir)).toEqual({ applied: ["0001_t.sql", "0002_b.sql"], skipped: [] });
    expect(await migrate(db, dir)).toEqual({ applied: [], skipped: ["0001_t.sql", "0002_b.sql"] });
  });

  it("refuses to run when an applied migration was edited, before running anything", async () => {
    await put("0001_t.sql", "create table t (a int);");
    await put("0002_b.sql", "alter table t add column if not exists b int;");
    await migrate(db, dir);
    // An earlier draft ran here; the file has since grown a statement. A new file is pending too.
    await put("0002_b.sql", "alter table t add column if not exists b int;\nalter table t add column if not exists c int;");
    await put("0003_d.sql", "alter table t add column d int;");
    await expect(migrate(db, dir)).rejects.toThrow(/0002_b\.sql changed after this database applied it.*--reapply 0002_b\.sql/);
    expect(await columns()).toEqual(["a", "b"]); // 0003 did not run either
  });

  it("refuses to run when an applied migration was deleted or renamed, before running anything", async () => {
    await put("0001_t.sql", "create table t (a int);");
    await put("0002_b.sql", "alter table t add column b int;");
    await migrate(db, dir);
    // Deleted, with a new file pending: nothing may run.
    await rm(join(dir, "0001_t.sql"));
    await put("0003_c.sql", "alter table t add column c int;");
    await expect(migrate(db, dir)).rejects.toThrow(/0001_t\.sql was applied to this database but is missing .*Restore the file/);
    await expect(migrate(db, dir, { reapply: ["0001_t.sql"] })).rejects.toThrow(/missing/);
    expect(await columns()).toEqual(["a", "b"]);
    // Renamed: the applied name is missing, even though its SQL is still there under another name.
    await put("0001_t.sql", "create table t (a int);");
    await rm(join(dir, "0002_b.sql"));
    await put("0002_b_renamed.sql", "alter table t add column b int;");
    await expect(migrate(db, dir)).rejects.toThrow(/0002_b\.sql was applied to this database but is missing/);
    expect(await columns()).toEqual(["a", "b"]);
    // Restored under its own name: the pending migration runs.
    await rm(join(dir, "0002_b_renamed.sql"));
    await put("0002_b.sql", "alter table t add column b int;");
    expect(await migrate(db, dir)).toEqual({ applied: ["0003_c.sql"], skipped: ["0001_t.sql", "0002_b.sql"] });
    expect(await columns()).toEqual(["a", "b", "c"]);
  });

  it("re-applies a named migration on request, records its new checksum, and carries on", async () => {
    await put("0001_t.sql", "create table t (a int);");
    await put("0002_b.sql", "alter table t add column if not exists b int;");
    await migrate(db, dir);
    await put("0002_b.sql", "alter table t add column if not exists b int;\nalter table t add column if not exists c int;");
    await put("0003_d.sql", "alter table t add column d int;");
    expect(await migrate(db, dir, { reapply: ["0002_b.sql"] })).toEqual({ applied: ["0002_b.sql", "0003_d.sql"], skipped: ["0001_t.sql"] });
    expect(await columns()).toEqual(["a", "b", "c", "d"]);
    expect(await migrate(db, dir)).toEqual({ applied: [], skipped: ["0001_t.sql", "0002_b.sql", "0003_d.sql"] });
  });

  it("re-applies only migrations this database has applied", async () => {
    await put("0001_t.sql", "create table t (a int);");
    await expect(migrate(db, dir, { reapply: ["0001_t.sql"] })).rejects.toThrow(/cannot re-apply 0001_t\.sql/);
    await migrate(db, dir);
    await expect(migrate(db, dir, { reapply: ["0009_missing.sql"] })).rejects.toThrow(/cannot re-apply 0009_missing\.sql/);
  });
});
