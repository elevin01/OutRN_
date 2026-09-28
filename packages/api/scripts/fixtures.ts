/**
 * Regenerates the contract fixtures in packages/contracts/src/fixtures from the REAL API.
 *
 *   pnpm --filter @outrn/api fixtures
 *
 * Seeds a throwaway database (outrn_fixtures) from the invented synthetic OSM fixtures plus a few
 * crafted facts and one event, runs the actual HTTP app at pinned times, and writes every response.
 * Ids are renumbered in order of appearance so regenerating produces a readable, stable diff.
 *
 * Fixtures are the UI's development data, not a regression snapshot: regenerate them when the
 * contract changes or a scenario needs new data, not after every engine tweak.
 */
process.env["TZ"] = "UTC";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type { ApiError, Area, AreasResponse, OpsRunDetail, OpsRunList, PlaceDetails, RecommendationRequest, RecommendationResponse } from "@outrn/contracts";
import { reset } from "@outrn/db";
import { materializeSubjects, writeFacts } from "@outrn/facts";
import { ingestOsmArea } from "@outrn/ingest";
import { createApp } from "../src/http/app.js";
import { decodeCursor, encodeCursor } from "../src/service/recommendations.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../..");
const OUT = resolve(ROOT, "packages/contracts/src/fixtures");
const BASE = process.env["DATABASE_URL"] ?? "postgres://outrn@127.0.0.1:54329/outrn";
const DB_URL = BASE.replace(/\/[^/]+$/, "/outrn_fixtures");

/** Saturday 3 October 2026, 6:30pm in New York. */
const SAT_EVENING = new Date("2026-10-03T22:30:00Z");
const FETCHED = new Date("2026-09-20T12:00:00Z");
const OPS_TOKEN = "fixtures";

interface ScenarioDef {
  id: string;
  /** Area id the mock lists for this scenario. Real areas keep their own id. */
  areaId: string;
  areaName?: string;
  title: string;
  description: string;
  clock: Date;
  request: RecommendationRequest;
  /** The mock answers the search itself with this error fixture. */
  error?: string;
  /** The mock answers page 2 with CURSOR_EXPIRED. */
  expiresAfterFirstPage?: boolean;
}

const SCENARIOS: ScenarioDef[] = [
  { id: "les", areaId: "les", title: "Lower East Side, Saturday 6:30pm", description: "Walking, 3 hours free. Several pages: follow nextCursor.", clock: SAT_EVENING, request: { areaId: "les", windowMinutes: 180 } },
  { id: "bronxville", areaId: "bronxville", title: "Bronxville, Saturday 7:30pm", description: "Driving (the area default), 2 hours free; travel includes parking.", clock: new Date("2026-10-03T23:30:00Z"), request: { areaId: "bronxville", windowMinutes: 120 } },
  { id: "bars", areaId: "mock-bars", areaName: "Mock · bars, date night", title: "Bars on a date", description: "Narrowed to bars. One has hours confirmed by a call; another's place page shows a stale check and disagreeing sources.", clock: SAT_EVENING, request: { areaId: "les", windowMinutes: 180, company: "date", categories: ["bar"] } },
  { id: "family", areaId: "mock-family", areaName: "Mock · family, age limits", title: "Family, late, bars", description: "A family with no ages given: a bar that is usually 21+ is Check first with a required age caveat.", clock: new Date("2026-10-04T05:15:00Z"), request: { areaId: "les", windowMinutes: 120, company: "family", categories: ["bar"] } },
  { id: "events", areaId: "mock-events", areaName: "Mock · a scheduled event", title: "Theatre tonight", description: "A scheduled performance: kind \"event\" with start and end times.", clock: SAT_EVENING, request: { areaId: "les", windowMinutes: 240, categories: ["theatre"] } },
  { id: "fewer", areaId: "mock-fewer", areaName: "Mock · fewer than three", title: "Free, 1 hour, 2:30am", description: "Fewer than three qualify: `insufficient` explains and offers relaxations. Never pad.", clock: new Date("2026-10-04T06:30:00Z"), request: { areaId: "les", windowMinutes: 60, budget: { kind: "free" } } },
  { id: "none", areaId: "mock-none", areaName: "Mock · nothing fits", title: "Nothing fits", description: "Zero items, with relaxations.", clock: new Date("2026-10-04T08:30:00Z"), request: { areaId: "les", windowMinutes: 30, budget: { kind: "free" }, categories: ["museum"] } },
  { id: "expired", areaId: "mock-expired", areaName: "Mock · expired pages", title: "Pages expired", description: "Page 1 is fine; asking for page 2 returns CURSOR_EXPIRED with `restart`.", clock: SAT_EVENING, request: { areaId: "les", windowMinutes: 120 }, expiresAfterFirstPage: true },
  { id: "error", areaId: "mock-error", areaName: "Mock · service unavailable", title: "Backend down", description: "The search fails with UNAVAILABLE (503, retryable).", clock: SAT_EVENING, request: { areaId: "les", windowMinutes: 180 }, error: "unavailable" },
];

async function seed(db: pg.Pool): Promise<void> {
  await reset(db);
  for (const area of ["les", "bronxville"]) {
    await ingestOsmArea(db, { areaSlug: area, fromFile: resolve(ROOT, `fixtures/osm/${area}-synthetic.json`) });
  }
  await db.query(`update facts set fetched_at = $1`, [FETCHED]);
  const id = async (name: string) => {
    const r = await db.query<{ id: string }>(`select id from venues where canonical_name = $1 and publish_state = 'eligible'`, [name]);
    if (r.rows.length !== 1) throw new Error(`expected exactly one eligible "${name}", found ${r.rows.length}`);
    return r.rows[0]!.id;
  };

  // Hours confirmed by a call four days before: "hours confirmed" on the card.
  const confirmed = await id("Clinton Bar");
  // A check 130 days old, and a newer OSM edit that disagrees: due for recheck, sources disagree.
  const disputed = await id("Hester Bar");
  // Usually 21+: an estimate, so a family sees Check first rather than an exclusion.
  const pitt = await id("Pitt Street Nightcap");
  await writeFacts(db, [
    { subjectKind: "venue", subjectId: confirmed, attribute: "opening_hours", value: { osm: "Mo-Su 16:00-02:00" }, evidenceClass: "published", sourceId: "founder", evidence: "founder: called 9/29", sourceUpdatedAt: new Date("2026-09-29T16:00:00Z"), fetchedAt: new Date("2026-09-29T16:00:00Z"), confidence: 0.9, lineageGroup: "founder" },
    { subjectKind: "venue", subjectId: disputed, attribute: "opening_hours", value: { osm: "Mo-Su 17:00-01:00" }, evidenceClass: "published", sourceId: "founder", evidence: "founder: called 5/26", sourceUpdatedAt: new Date("2026-05-26T16:00:00Z"), fetchedAt: new Date("2026-05-26T16:00:00Z"), confidence: 0.9, lineageGroup: "founder" },
    { subjectKind: "venue", subjectId: disputed, attribute: "opening_hours", value: { osm: "Mo-Su 18:00-02:00" }, evidenceClass: "published", sourceId: "osm", evidence: "osm: opening_hours tag", sourceUpdatedAt: new Date("2026-08-30T10:00:00Z"), fetchedAt: FETCHED, confidence: 0.7, lineageGroup: "osm" },
    { subjectKind: "venue", subjectId: pitt, attribute: "age_limit", value: { minAge: 21 }, evidenceClass: "estimate", sourceId: "category_policy", evidence: "bars in New York are usually 21+", fetchedAt: FETCHED, confidence: 0.5, lineageGroup: "category_policy" },
  ]);
  await materializeSubjects(db, "venue", [confirmed, disputed, pitt], SAT_EVENING);

  // One performance tonight at the Delancey Playhouse.
  const playhouse = await id("Delancey Playhouse");
  const show = await db.query<{ id: string }>(
    `insert into occurrences (venue_id, title, start_at, end_at, status) values ($1, 'The Tenement Follies', $2, $3, 'scheduled') returning id`,
    [playhouse, new Date("2026-10-03T23:30:00Z"), new Date("2026-10-04T01:30:00Z")],
  );
  await writeFacts(db, [
    { subjectKind: "occurrence", subjectId: show.rows[0]!.id, attribute: "price", value: { min: 25, max: 40, currency: "USD" }, evidenceClass: "published", sourceId: "firstparty", evidence: "https://delanceyplayhouse.example/tonight", fetchedAt: FETCHED, confidence: 0.85, lineageGroup: "firstparty:delanceyplayhouse.example" },
    { subjectKind: "occurrence", subjectId: show.rows[0]!.id, attribute: "admission", value: { requirement: "ticket" }, evidenceClass: "published", sourceId: "firstparty", evidence: "https://delanceyplayhouse.example/tonight", fetchedAt: FETCHED, confidence: 0.85, lineageGroup: "firstparty:delanceyplayhouse.example" },
  ]);
  await materializeSubjects(db, "occurrence", [show.rows[0]!.id], SAT_EVENING);
}

type Json = unknown;

async function call(app: ReturnType<typeof createApp>, method: "GET" | "POST", path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: Json }> {
  const res = await app.request(path, { method, headers: { "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, json: await res.json() };
}

async function main(): Promise<void> {
  const admin = new pg.Pool({ connectionString: BASE });
  if (!(await admin.query("select 1 from pg_database where datname = 'outrn_fixtures'")).rowCount) await admin.query("create database outrn_fixtures");
  await admin.end();
  const db = new pg.Pool({ connectionString: DB_URL });
  await db.query("create extension if not exists postgis; create extension if not exists pgcrypto;");
  await seed(db);

  let now = SAT_EVENING;
  const app = createApp({ db: () => db, clock: () => now, opsToken: OPS_TOKEN });
  const ok = <T>(r: { status: number; json: Json }, what: string): T => {
    if (r.status !== 200) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.json)}`);
    return r.json as T;
  };

  const areas = ok<AreasResponse>(await call(app, "GET", "/v1/areas"), "areas");
  const errors: Record<string, { status: number; body: ApiError }> = {};
  const scenarios: { id: string; area: Area; title: string; description: string; request: RecommendationRequest; pages: RecommendationResponse[]; error?: string; expiresAfterFirstPage?: boolean }[] = [];

  for (const s of SCENARIOS) {
    now = s.clock;
    const real = areas.areas.find((a) => a.id === s.request.areaId)!;
    const area: Area = s.areaId === real.id ? real : { ...real, id: s.areaId, name: s.areaName ?? s.title };
    const pages = [ok<RecommendationResponse>(await call(app, "POST", "/v1/recommendations", s.request), s.id)];
    if (s.expiresAfterFirstPage) {
      now = new Date(s.clock.getTime() + 21 * 60_000);
      const r = await call(app, "POST", "/v1/recommendations", { cursor: pages[0]!.page.nextCursor });
      if (r.status !== 410) throw new Error(`expected CURSOR_EXPIRED, got ${r.status}`);
      errors["cursor-expired"] = { status: r.status, body: r.json as ApiError };
    } else if (!s.error) {
      while (pages.at(-1)!.page.nextCursor && pages.length < 4) pages.push(ok<RecommendationResponse>(await call(app, "POST", "/v1/recommendations", { cursor: pages.at(-1)!.page.nextCursor }), `${s.id} page ${pages.length + 1}`));
      // The mock serves only captured pages: end the chain where the capture ends.
      pages.at(-1)!.page.nextCursor = null;
    }
    const pinned = pages.map((p) => ({ ...p, request: { ...p.request, areaId: area.id }, area: { ...p.area, id: area.id, name: area.name } }));
    scenarios.push({ id: s.id, area, title: s.title, description: s.description, request: { ...s.request, areaId: area.id }, pages: s.error ? [] : pinned, ...(s.error ? { error: s.error } : {}), ...(s.expiresAfterFirstPage ? { expiresAfterFirstPage: true } : {}) });
    console.log(`${s.id.padEnd(11)} ${pages.map((p) => p.items.map((i) => `${i.name} [${i.status}]`).join(", ") || "(none)").join(" | ")}${pages[0]!.insufficient ? ` · insufficient: ${pages[0]!.insufficient.relaxations.map((r) => r.text).join(", ")}` : ""}`);
  }

  now = SAT_EVENING;
  const placeIds = [...new Set(scenarios.flatMap((s) => s.pages.flatMap((p) => p.items.map((i) => i.placeId))))];
  const places: Record<string, PlaceDetails> = {};
  for (const id of placeIds) places[id] = ok<PlaceDetails>(await call(app, "GET", `/v1/places/${id}`), `place ${id}`);

  const auth = { authorization: `Bearer ${OPS_TOKEN}` };
  const evaluation = ok<OpsRunDetail>(await call(app, "POST", "/ops/v1/evaluate", { areaId: "les", windowMinutes: 180 }, auth), "ops evaluate");
  const runs = ok<OpsRunList>(await call(app, "GET", "/ops/v1/runs?limit=5", undefined, auth), "ops runs");

  const capture = async (name: string, r: Promise<{ status: number; json: Json }>) => {
    const x = await r;
    errors[name] = { status: x.status, body: x.json as ApiError };
  };
  await capture("validation", call(app, "POST", "/v1/recommendations", { areaId: "les", windowMinutes: 5, mood: "sleepy" }));
  await capture("unknown-area", call(app, "POST", "/v1/recommendations", { areaId: "atlantis", windowMinutes: 120 }));
  await capture("cursor-invalid", call(app, "POST", "/v1/recommendations", { cursor: "not-a-cursor" }));
  await capture("not-found", call(app, "GET", "/v1/places/00000000-0000-4000-8000-000000000000"));
  await capture("unauthorized", call(app, "GET", "/ops/v1/runs"));
  const down = createApp({ db: () => { throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" }); }, log: () => undefined });
  await capture("unavailable", call(down, "GET", "/v1/areas"));
  await db.end();

  // Stable output: renumber ids by first appearance, pin wall-clock values, rewrite cursors to match.
  const ids = new Map<string, string>();
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const idFor = (u: string) => {
    if (u === "00000000-0000-4000-8000-000000000000") return u;
    if (!ids.has(u)) ids.set(u, `00000000-0000-4000-8000-${(ids.size + 1).toString(16).padStart(12, "0")}`);
    return ids.get(u)!;
  };
  const stable = (v: Json, key = ""): Json => {
    if (typeof v === "string") {
      if (UUID.test(v)) return idFor(v);
      if ((key === "nextCursor" || key === "prevCursor") && v) {
        const c = decodeCursor(v);
        return encodeCursor({ run: idFor(c.run), offset: c.offset });
      }
      return v;
    }
    if (Array.isArray(v)) return v.map((x) => stable(x));
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.entries(v).map(([k, x]) => {
          if (k === "durationMs" && typeof x === "number") return [k, 42];
          if (k === "createdAt" && typeof x === "string") return [k, SAT_EVENING.toISOString()];
          return [UUID.test(k) ? idFor(k) : k, stable(x, k)];
        }),
      );
    }
    return v;
  };
  const stableScenarios = stable(scenarios) as typeof scenarios;
  const stablePlaces = stable(places) as typeof places;
  const stableOps = stable({ evaluation, runs }) as { evaluation: OpsRunDetail; runs: OpsRunList };
  const stableErrors = stable(errors) as typeof errors;

  rmSync(OUT, { recursive: true, force: true });
  const write = (rel: string, data: Json) => {
    const path = join(OUT, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
  };
  const imports: string[] = [];
  const ident = (rel: string) => "fx_" + rel.replace(/\.json$/, "").replace(/[^a-zA-Z0-9]+/g, "_");
  const add = (rel: string, data: Json) => {
    write(rel, data);
    imports.push(`import ${ident(rel)} from "./${rel}" with { type: "json" };`);
    return ident(rel);
  };

  const areasRef = add("areas.json", areas);
  const scenarioRefs = stableScenarios.map((s) => {
    const pageRefs = s.pages.map((p, i) => add(`recommendations/${s.id}-${i + 1}.json`, p));
    return `  { id: ${JSON.stringify(s.id)}, area: ${JSON.stringify(s.area)}, title: ${JSON.stringify(s.title)}, description: ${JSON.stringify(s.description)}, request: ${JSON.stringify(s.request)}, pages: [${pageRefs.join(", ")}] as unknown as RecommendationResponse[]${s.error ? `, error: ${JSON.stringify(s.error)}` : ""}${s.expiresAfterFirstPage ? ", expiresAfterFirstPage: true" : ""} },`;
  });
  const placeRefs = Object.entries(stablePlaces).map(([id, p]) => `  ${JSON.stringify(id)}: ${add(`places/${id}.json`, p)} as unknown as PlaceDetails,`);
  const evalRef = add("ops/evaluate.json", stableOps.evaluation);
  const runsRef = add("ops/runs.json", stableOps.runs);
  const errorRefs = Object.entries(stableErrors).map(([name, e]) => `  ${JSON.stringify(name)}: ${add(`errors/${name}.json`, e)} as unknown as ErrorFixture,`);

  const index = `// Generated by \`pnpm --filter @outrn/api fixtures\`. Do not edit by hand: change the scenario in
// packages/api/scripts/fixtures.ts and regenerate. Every response here came from the real API.
import type { ApiError, Area, AreasResponse, OpsRunDetail, OpsRunList, PlaceDetails, RecommendationRequest, RecommendationResponse } from "../index.js";
${imports.join("\n")}

export interface Scenario {
  id: string;
  /** How the mock lists it in GET /v1/areas. Real areas keep their id; mock-only ones start with "mock-". */
  area: Area;
  title: string;
  description: string;
  /** The request that produced it (areaId rewritten to the scenario's). */
  request: RecommendationRequest;
  /** Page 1, 2, ... chained by nextCursor / prevCursor. Empty when the search itself fails. */
  pages: RecommendationResponse[];
  /** Name of the error fixture the search returns instead. */
  error?: string;
  /** Page 2 returns the "cursor-expired" error. */
  expiresAfterFirstPage?: boolean;
}

export interface ErrorFixture {
  status: number;
  body: ApiError;
}

export const areas = ${areasRef} as unknown as AreasResponse;

export const scenarios: Scenario[] = [
${scenarioRefs.join("\n")}
];

/** GET /v1/places/:id for every place any scenario shows. */
export const places: Record<string, PlaceDetails> = {
${placeRefs.join("\n")}
};

export const ops = { evaluate: ${evalRef} as unknown as OpsRunDetail, runs: ${runsRef} as unknown as OpsRunList };

export const errors: Record<string, ErrorFixture> = {
${errorRefs.join("\n")}
};
`;
  writeFileSync(join(OUT, "index.ts"), index);
  console.log(`\nwrote ${imports.length} fixtures to ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
