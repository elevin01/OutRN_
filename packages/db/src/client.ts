import pg from "pg";

export type Db = pg.Pool;
export type Tx = pg.PoolClient;
export type Queryable = pg.Pool | pg.PoolClient;

let pool: pg.Pool | null = null;

export function databaseUrl(): string {
  const url = process.env["DATABASE_URL"];
  if (!url) {
    throw new Error("DATABASE_URL is not set. Copy .env.example to .env or run `pnpm db:start`.");
  }
  return url;
}

/**
 * Can a Postgres at `url` be reached? For test files: they must decide whether to skip at load time,
 * because describe.skipIf reads its condition before any beforeAll hook runs.
 */
export async function databaseReachable(url: string, timeoutMs = 2000): Promise<boolean> {
  const probe = new pg.Pool({ connectionString: url, connectionTimeoutMillis: timeoutMs, max: 1 });
  try {
    await probe.query("select 1");
    return true;
  } catch {
    return false;
  } finally {
    await probe.end().catch(() => undefined);
  }
}

/**
 * For DB-backed test files: is the database there? Locally, no database means those tests skip.
 * With OUTRN_REQUIRE_DB set (CI's database job) it is an error instead, so a broken service
 * container can never turn the suite green by skipping it.
 */
export async function testDatabaseAvailable(url: string): Promise<boolean> {
  const ok = await databaseReachable(url);
  if (!ok && process.env["OUTRN_REQUIRE_DB"]) throw new Error(`OUTRN_REQUIRE_DB is set but no database is reachable at ${url}`);
  return ok;
}

export function getDb(): Db {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: databaseUrl(),
      max: 8,
      application_name: "outrn",
      // Return timestamptz as Date (default) and numeric as string (default). Keep JSON as parsed.
    });
    pool.on("error", (err) => {
      console.error("[db] pool error", err);
    });
  }
  return pool;
}

export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

export async function withTx<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("begin");
    const out = await fn(client);
    await client.query("commit");
    return out;
  } catch (e) {
    await client.query("rollback").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}
