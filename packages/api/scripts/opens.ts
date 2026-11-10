/**
 * What someone sees when they open the app: the default search (three hours, no filters) at fixed
 * moments over the real captures in fixtures/live, the first pages printed with their scores, and
 * how those pages are made up over the opens (which kinds lead, which places repeat).
 *
 *   pnpm --filter @outrn/api opens [seed] [les] [bronxville] [white_plains]
 *                                  [--taste live_music,art:0.5] [--pages 3] [--why] [--now]
 *
 * `seed` rebuilds the two audit databases (outrn_audit_les_bronxville, outrn_audit_white_plains) from
 * the captures, as the golden scenarios seed theirs: a minute each. Without it the last seed is read,
 * so events ingested into them since (`DATABASE_URL=…/outrn_audit_les_bronxville pnpm outrn ingest
 * nyc-parks --area les`) stay; `--now` then asks at moments of the current week instead of the
 * captures'. `--why` adds each option's reasons and caveats.
 *
 * Read it as "would I go out for that, then?", and across the opens as "is it the same three cards?".
 * Columns: travel, merit, draw, appeal, fit (taste when one is given); * is Check first.
 */
process.env["TZ"] = "UTC";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type { RecommendationRequest } from "@outrn/contracts";
import { merit } from "@outrn/engine";
import { seedGolden, type GoldenWorld } from "./golden-lib.js";
import { runEngine } from "../src/service/recommendations.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const BASE = process.env["DATABASE_URL"] ?? "postgres://outrn@127.0.0.1:54329/outrn";
const urlOf = (world: GoldenWorld) => BASE.replace(/\/[^/]+$/, `/outrn_audit_${world}`);

const VALUE_FLAGS = new Set(["--taste", "--pages"]);
const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const positional = args.filter((a, i) => !a.startsWith("--") && !VALUE_FLAGS.has(args[i - 1] ?? ""));
const seed = positional.includes("seed");
const only = positional.filter((a) => a !== "seed");
const pages = Math.max(1, Number(flag("pages") ?? 3) || 3);
const why = args.includes("--why");
const nowWeek = args.includes("--now");
const taste = (flag("taste") ?? "")
  .split(",")
  .filter(Boolean)
  .map((t) => {
    const [interest, weight] = t.split(":");
    return { interest: interest!, weight: weight === undefined ? 0.8 : Number(weight) };
  });

/** Moments someone opens the app, New York local time (EDT, UTC-4, on these dates). */
const MOMENTS: { label: string; at: string }[] = [
  { label: "Sat 10am", at: "2026-10-03T14:00:00Z" },
  { label: "Sat 2pm", at: "2026-10-03T18:00:00Z" },
  { label: "Sat 6:30pm", at: "2026-10-03T22:30:00Z" },
  { label: "Sat 10:30pm", at: "2026-10-04T02:30:00Z" },
  { label: "Sun 1pm", at: "2026-10-04T17:00:00Z" },
  { label: "Tue 12:30pm", at: "2026-09-29T16:30:00Z" },
  { label: "Tue 6pm", at: "2026-09-29T22:00:00Z" },
  { label: "Thu 8pm", at: "2026-10-01T00:00:00Z" },
  { label: "Fri 7pm", at: "2026-10-02T23:00:00Z" },
];
/** With `--now`: the same clock times on the days of this week, for events ingested since the seed. */
function thisWeek(): { label: string; at: string }[] {
  const day = (offset: number, hourUtc: number, label: string) => {
    const d = new Date(Date.now() + offset * 86_400_000);
    d.setUTCHours(hourUtc, 0, 0, 0);
    return { label: `${d.toISOString().slice(0, 10)} ${label}`, at: d.toISOString() };
  };
  // New York is UTC-5 in winter and UTC-4 in summer: an hour either way does not change what this reads.
  return [day(1, 18, "~1pm"), day(2, 23, "~6pm"), day(4, 15, "~10am"), day(4, 18, "~1pm"), day(5, 17, "~12:30pm")];
}
const NOW_MOMENTS = nowWeek ? thisWeek() : [];
const WP_SHIFT_DAYS = 21; // White Plains was captured 18 Oct: the same weekdays three weeks on.

const AREAS: { area: string; world: GoldenWorld }[] = [
  { area: "les", world: "les_bronxville" },
  { area: "bronxville", world: "les_bronxville" },
  { area: "white_plains", world: "white_plains" },
];

async function ensure(world: GoldenWorld): Promise<pg.Pool> {
  const name = `outrn_audit_${world}`;
  const admin = new pg.Pool({ connectionString: BASE });
  try {
    const exists = (await admin.query("select 1 from pg_database where datname = $1", [name])).rowCount;
    if (!exists) await admin.query(`create database ${name}`);
    if (!exists || seed) {
      const db = new pg.Pool({ connectionString: urlOf(world) });
      await db.query("create extension if not exists postgis; create extension if not exists pgcrypto;");
      await db.end();
      const fresh = new pg.Pool({ connectionString: urlOf(world) });
      console.error(`seeding ${name}…`);
      await seedGolden(fresh, ROOT, world);
      await fresh.end();
    }
  } finally {
    await admin.end();
  }
  return new pg.Pool({ connectionString: urlOf(world) });
}

const pad = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s.padEnd(n));

for (const world of ["les_bronxville", "white_plains"] as const) {
  const here = AREAS.filter((a) => a.world === world && (!only.length || only.includes(a.area)));
  if (!here.length) continue;
  const db = await ensure(world);
  try {
    for (const { area } of here) {
      const categoryCount = new Map<string, number>();
      const firstNames = new Map<string, number>();
      for (const m of nowWeek ? NOW_MOMENTS : MOMENTS) {
        const at = new Date(new Date(m.at).getTime() + (world === "white_plains" && !nowWeek ? WP_SHIFT_DAYS * 86_400_000 : 0));
        const request: RecommendationRequest = { areaId: area, windowMinutes: 180, ...(taste.length ? { taste } : {}) };
        const run = await runEngine(db, request, { clock: () => at, persist: false });
        const { shortlist } = run;
        const eligible = shortlist.all.filter((e) => e.class !== "ineligible").length;
        console.log(`\n== ${area} · ${m.label} · 3h${taste.length ? ` · taste ${taste.map((t) => t.interest).join(",")}` : ""} (${eligible} eligible)`);
        shortlist.ordered.slice(0, pages * 3).forEach((e, i) => {
          const s = e.scores;
          if (i < 3) {
            categoryCount.set(e.candidate.category, (categoryCount.get(e.candidate.category) ?? 0) + 1);
            firstNames.set(e.candidate.name, (firstNames.get(e.candidate.name) ?? 0) + 1);
          }
          const tag = `${e.candidate.kind === "occurrence" ? "EVENT " : ""}${e.candidate.category}${e.class === "check_first" ? "*" : ""}`;
          console.log(
            `${i % 3 === 0 ? "-" : " "}${String(i + 1).padStart(2)} ${pad(e.candidate.name, 38)} ${pad(tag, 20)} ${String(e.timing?.travel.minutes ?? "?").padStart(2)}m  m=${merit(e).toFixed(3)} d=${(e.draw ?? 0).toFixed(2)} a=${s.appeal.toFixed(2)} f=${s.fit.toFixed(2)}${s.taste !== undefined ? ` t=${s.taste.toFixed(2)}` : ""}${
              why ? `  ${e.reasons.join(",")}${e.unresolved.length ? ` | ${e.unresolved.join(",")}` : ""}` : ""
            }`,
          );
        });
      }
      console.log(`\n## ${area}: first pages over ${(nowWeek ? NOW_MOMENTS : MOMENTS).length} opens`);
      console.log("   kinds: " + [...categoryCount].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(", "));
      console.log("   repeats: " + ([...firstNames].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ×${n}`).join(", ") || "none"));
      console.log(`   distinct places: ${firstNames.size} of ${(nowWeek ? NOW_MOMENTS : MOMENTS).length * 3}`);
    }
  } finally {
    await db.end();
  }
}
