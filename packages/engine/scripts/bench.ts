/**
 * Engine throughput at area scale: loads an area's real candidates, replicates them (jittered) to
 * the target counts, and times recommend(). Needs DATABASE_URL with the area ingested.
 *
 *   pnpm --filter @outrn/engine bench [area=les] [at=2026-10-03T22:30:00Z]
 */
process.env["TZ"] = "UTC";
import pg from "pg";
import { getArea } from "@outrn/db";
import { loadCandidates, loadPolicies, recommend, type Candidate, type RequestContext } from "../src/index.js";

const [areaSlug = "les", atArg = "2026-10-03T22:30:00Z"] = process.argv.slice(2);
const db = new pg.Pool({ connectionString: process.env["DATABASE_URL"] ?? "postgres://outrn@127.0.0.1:54329/outrn" });
const area = await getArea(db, areaSlug);
const now = new Date(atArg);
const origin = { lat: area.lat, lon: area.lon };
const t0 = performance.now();
const base = await loadCandidates(db, origin, area.travel_mode, now, new Date(now.getTime() + 180 * 60_000));
console.log(`${area.slug}: loaded ${base.length} candidates in ${(performance.now() - t0).toFixed(0)} ms`);
const policies = await loadPolicies(db);
const ctx: RequestContext = { origin, now, windowMinutes: 180, mode: area.travel_mode, timezone: area.timezone };
for (const target of [base.length, 1_000, 3_000, 10_000]) {
  const cands: Candidate[] = [];
  for (let i = 0; cands.length < target; i++) for (const c of base) if (cands.length < target) cands.push({ ...c, id: `${c.id}-${i}`, venueId: `${c.venueId}-${i}`, point: { lat: c.point.lat + (i % 9) * 0.0004, lon: c.point.lon + Math.floor(i / 9) * 0.0004 } });
  const cold = performance.now();
  recommend(cands, ctx, policies);
  const coldMs = performance.now() - cold;
  const warm = performance.now();
  const s = recommend(cands, ctx, policies);
  const warmMs = performance.now() - warm;
  console.log(`${String(cands.length).padStart(6)} candidates: first ${coldMs.toFixed(0).padStart(5)} ms · repeat ${warmMs.toFixed(0).padStart(5)} ms (${((warmMs / cands.length) * 1000).toFixed(0)} µs each) · ${s.ordered.length} eligible`);
}
await db.end();
