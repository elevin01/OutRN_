import { closeDb, getDb } from "./client.js";
import { migrate, reset } from "./migrate.js";

const [cmd, ...args] = process.argv.slice(2);
// `migrate --reapply <file>` (repeatable): run an applied migration again, for a database that ran an earlier draft.
const reapply = args.flatMap((a, i) => (a === "--reapply" && args[i + 1] ? [args[i + 1]!] : []));
const db = getDb();
try {
  const r = cmd === "reset" ? await reset(db) : await migrate(db, undefined, { reapply });
  console.log(`applied: ${r.applied.length ? r.applied.join(", ") : "none"}; up to date: ${r.skipped.length}`);
} finally {
  await closeDb();
}
