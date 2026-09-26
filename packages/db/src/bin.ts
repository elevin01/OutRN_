import { closeDb, getDb } from "./client.js";
import { migrate, reset } from "./migrate.js";

const cmd = process.argv[2];
const db = getDb();
try {
  const r = cmd === "reset" ? await reset(db) : await migrate(db);
  console.log(`applied: ${r.applied.length ? r.applied.join(", ") : "none"}; up to date: ${r.skipped.length}`);
} finally {
  await closeDb();
}
