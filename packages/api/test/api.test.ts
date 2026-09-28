import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { ApiError, AreasResponse, OpsRunDetail, OpsRunList, PlaceDetails, RecommendationResponse, type RecommendationRequest } from "@outrn/contracts";
import { reset, testDatabaseAvailable } from "@outrn/db";
import { materializeSubjects, writeFacts } from "@outrn/facts";
import { ingestOsmArea } from "@outrn/ingest";
import { createApp } from "../src/http/app.js";
import { runEngine } from "../src/service/recommendations.js";

/**
 * The real API against Postgres + PostGIS on the synthetic LES fixture: every response must parse
 * against the contract, and paging must come from the frozen snapshot. Shares outrn_test with the
 * other DB-backed files (each resets it). Skips without a local cluster unless OUTRN_REQUIRE_DB.
 */

const BASE = process.env["DATABASE_URL"] ?? "postgres://outrn@127.0.0.1:54329/outrn";
const TEST_URL = BASE.replace(/\/[^/]+$/, "/outrn_test");
const FIXTURE = resolve(__dirname, "../../../fixtures/osm/les-synthetic.json");
const SAT_EVENING = new Date("2026-10-03T22:30:00Z");
const TOKEN = "test-ops-token";

let db: pg.Pool;
let now = SAT_EVENING;
const available = await testDatabaseAvailable(BASE);

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
  await reset(db);
  await ingestOsmArea(db, { areaSlug: "les", fromFile: FIXTURE });
});

afterAll(async () => {
  if (db) await db.end();
});

const app = () => createApp({ db: () => db, clock: () => now, opsToken: TOKEN });

async function call(method: "GET" | "POST", path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await app().request(path, { method, headers: { "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) });
  return { status: res.status, headers: res.headers, json: (await res.json()) as unknown };
}

const search = async (req: RecommendationRequest) => {
  const r = await call("POST", "/v1/recommendations", req);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return RecommendationResponse.parse(r.json);
};

const runCount = async () => Number((await db.query<{ n: string }>("select count(*) n from recommendation_runs")).rows[0]!.n);

describe.skipIf(!available)("v1 API on the synthetic LES fixture", () => {
  it("lists areas and the filters a request may use, and labels every response with the contract version", async () => {
    const r = await call("GET", "/v1/areas");
    expect(r.status).toBe(200);
    expect(r.headers.get("x-outrn-contract")).toBe("1.0.0");
    const areas = AreasResponse.parse(r.json);
    expect(areas.areas.map((a) => a.id)).toEqual(expect.arrayContaining(["les", "bronxville"]));
    expect(areas.areas.find((a) => a.id === "bronxville")?.defaultTravelMode).toBe("drive");
    expect(areas.filters.categories.map((c) => c.id)).toContain("bowling");
  });

  it("answers a search with the engine's own first page, resolved defaults, and a frozen snapshot", async () => {
    now = SAT_EVENING;
    const req: RecommendationRequest = { areaId: "les", windowMinutes: 180 };
    const page = await search(req);
    expect(page.items).toHaveLength(3);
    expect(page.asOf).toBe(SAT_EVENING.toISOString());
    expect(page.request).toMatchObject({ areaId: "les", travelMode: "walk", travelModeIsDefault: true, budget: { kind: "any" }, atIsExplicit: false });
    expect(page.page).toMatchObject({ offset: 0, size: 3, prevCursor: null });
    expect(page.insufficient).toBeNull();
    expect(page.attributions).toContain("© OpenStreetMap contributors");
    // Same resolution, same engine: the API shows exactly what the engine ranks first (the CLI uses runEngine too).
    const direct = await runEngine(db, req, { clock: () => now, persist: false });
    expect(page.items.map((i) => i.id)).toEqual(direct.shortlist.items.map((e) => e.candidate.id));
    for (const item of page.items) expect(["ready", "check_first"]).toContain(item.status);
  });

  it("pages through the frozen list without re-running the engine, never repeating or reshuffling", async () => {
    now = SAT_EVENING;
    const first = await search({ areaId: "les", windowMinutes: 180 });
    const before = await runCount();
    const seen = [...first.items.map((i) => i.id)];
    let page = first;
    let n = 1;
    while (page.page.nextCursor && n < 20) {
      const next = await search({ cursor: page.page.nextCursor } as unknown as RecommendationRequest);
      expect(next.requestId).toBe(first.requestId);
      expect(next.page.offset).toBe(n * 3);
      expect(next.insufficient).toBeNull();
      // Previous goes back to exactly the page we came from.
      const back = await search({ cursor: next.page.prevCursor! } as unknown as RecommendationRequest);
      expect(back.items.map((i) => i.id)).toEqual(page.items.map((i) => i.id));
      seen.push(...next.items.map((i) => i.id));
      page = next;
      n++;
    }
    expect(n).toBeGreaterThan(3);
    expect(new Set(seen).size).toBe(seen.length);
    expect(await runCount()).toBe(before);
  });

  it("keeps a search's pages stable while the data underneath changes", async () => {
    now = SAT_EVENING;
    const first = await search({ areaId: "les", windowMinutes: 180 });
    const second = await search({ cursor: first.page.nextCursor! } as unknown as RecommendationRequest);
    const target = second.items[0]!;
    await writeFacts(db, [{ subjectKind: "venue", subjectId: target.placeId, attribute: "business_status", value: { status: "closed_temporarily" }, evidenceClass: "published", sourceId: "founder", evidence: "founder: sign on the door", sourceUpdatedAt: now, fetchedAt: now, confidence: 0.9, lineageGroup: "founder" }]);
    await materializeSubjects(db, "venue", [target.placeId], now);
    const again = await search({ cursor: first.page.nextCursor! } as unknown as RecommendationRequest);
    expect(again.items.map((i) => i.id)).toEqual(second.items.map((i) => i.id));
    // A new search sees the change.
    const fresh = await search({ areaId: "les", windowMinutes: 180 });
    const all: string[] = [...fresh.items.map((i) => i.id)];
    let p = fresh;
    while (p.page.nextCursor) {
      p = await search({ cursor: p.page.nextCursor } as unknown as RecommendationRequest);
      all.push(...p.items.map((i) => i.id));
    }
    expect(all).not.toContain(target.id);
  });

  it("expires a search's pages with its plans, and hands back the search to run again", async () => {
    now = SAT_EVENING;
    const implicit = await search({ areaId: "les", windowMinutes: 120, mood: "food" });
    const explicitAt = await search({ areaId: "les", windowMinutes: 120, at: "2026-10-04T15:00:00.000Z" });
    now = new Date(SAT_EVENING.getTime() + 21 * 60_000);
    const r = await call("POST", "/v1/recommendations", { cursor: implicit.page.nextCursor });
    expect(r.status).toBe(410);
    const e = ApiError.parse(r.json);
    expect(e.error.code).toBe("CURSOR_EXPIRED");
    expect(e.error.restart).toEqual({ areaId: "les", windowMinutes: 120, mood: "food" });
    const r2 = ApiError.parse((await call("POST", "/v1/recommendations", { cursor: explicitAt.page.nextCursor })).json);
    expect(r2.error.restart).toEqual({ areaId: "les", windowMinutes: 120, at: "2026-10-04T15:00:00.000Z" });
    now = SAT_EVENING;
  });

  it("rejects bad cursors and bad requests with field-level errors", async () => {
    const bad = await call("POST", "/v1/recommendations", { cursor: "garbage" });
    expect([bad.status, ApiError.parse(bad.json).error.code]).toEqual([400, "CURSOR_INVALID"]);
    const unknownRun = Buffer.from(JSON.stringify({ v: 1, r: "00000000-0000-4000-8000-000000000000", o: 3 })).toString("base64url");
    expect(ApiError.parse((await call("POST", "/v1/recommendations", { cursor: unknownRun })).json).error.code).toBe("CURSOR_INVALID");
    const cases: Array<[unknown, string]> = [
      [{ areaId: "les", windowMinutes: 5 }, "windowMinutes"],
      [{ areaId: "atlantis", windowMinutes: 120 }, "areaId"],
      [{ areaId: "les", windowMinutes: 120, mood: "sleepy" }, "mood"],
      [{ areaId: "les", windowMinutes: 120, categories: ["bar", "spaceport"] }, "categories.1"],
      [{ areaId: "les", windowMinutes: 120, budget: { kind: "max", maxCents: 2500, currency: "EUR" } }, "budget.currency"],
      [{ areaId: "les", windowMinutes: 120, colour: "blue" }, "(body)"],
    ];
    for (const [body, path] of cases) {
      const r = await call("POST", "/v1/recommendations", body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      const e = ApiError.parse(r.json);
      expect(e.error.code).toBe("VALIDATION_FAILED");
      expect(e.error.retryable).toBe(false);
      expect(e.error.fields?.map((f) => f.path), JSON.stringify(e)).toContain(path);
    }
    expect((await call("POST", "/v1/recommendations", "{not json")).status).toBe(400);
  });

  it("describes a place with provenance, hours today and directions; unknown ids are 404", async () => {
    now = SAT_EVENING;
    const page = await search({ areaId: "les", windowMinutes: 180 });
    const r = await call("GET", `/v1/places/${page.items[0]!.placeId}`);
    expect(r.status).toBe(200);
    const place = PlaceDetails.parse(r.json);
    expect(place.facts[0]!.attribute).toBe("opening_hours");
    expect(place.actions.directionsUrls.drive).toContain("travelmode=driving");
    expect(place.facts.every((f) => f.provenance.summary.length > 0)).toBe(true);
    for (const id of ["not-a-uuid", "00000000-0000-4000-8000-000000000000"]) {
      const miss = await call("GET", `/v1/places/${id}`);
      expect([miss.status, ApiError.parse(miss.json).error.code]).toEqual([404, "NOT_FOUND"]);
    }
  });

  it("serves only eligible places: excluded and suspended venues are 404", async () => {
    // The fixture's permanently closed bar is excluded by the pipeline.
    const closed = (await db.query<{ id: string }>("select id from venues where canonical_name = 'Old Norfolk Lounge' and publish_state = 'excluded'")).rows[0]!.id;
    const open = (await search({ areaId: "les", windowMinutes: 180 })).items[0]!.placeId;
    await db.query("update venues set publish_state = 'suspended' where id = $1", [open]);
    try {
      for (const id of [closed, open]) {
        const r = await call("GET", `/v1/places/${id}`);
        expect([r.status, ApiError.parse(r.json).error.code], id).toEqual([404, "NOT_FOUND"]);
      }
    } finally {
      await db.query("update venues set publish_state = 'eligible' where id = $1", [open]);
    }
    expect((await call("GET", `/v1/places/${open}`)).status).toBe(200);
  });

  it("keeps ops diagnostics behind the token", async () => {
    expect((await call("GET", "/ops/v1/runs")).status).toBe(401);
    expect((await call("GET", "/ops/v1/runs", undefined, { authorization: "Bearer wrong" })).status).toBe(401);
    const auth = { authorization: `Bearer ${TOKEN}` };
    const ev = OpsRunDetail.parse((await call("POST", "/ops/v1/evaluate", { areaId: "les", windowMinutes: 180 }, auth)).json);
    expect(ev.counts.total).toBe(ev.counts.ready + ev.counts.check_first + ev.counts.ineligible);
    expect(ev.results.filter((r) => r.shortlisted)).toHaveLength(3);
    expect(ev.results.some((r) => r.excludedBy !== null)).toBe(true);
    const runs = OpsRunList.parse((await call("GET", "/ops/v1/runs?limit=5", undefined, auth)).json);
    expect(runs.runs[0]!.id).toBe(ev.id);
    const stored = OpsRunDetail.parse((await call("GET", `/ops/v1/runs/${ev.id}`, undefined, auth)).json);
    expect(stored.results.map((r) => [r.itemId, r.class, r.shortlisted])).toEqual(ev.results.map((r) => [r.itemId, r.class, r.shortlisted]));
    expect((await call("GET", "/ops/v1/runs/not-a-uuid", undefined, auth)).status).toBe(404);
  });

  it("reports an unreachable database as a retryable outage", async () => {
    const down = createApp({ db: () => { throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }); }, log: () => undefined });
    const res = await down.request("/v1/areas");
    expect(res.status).toBe(503);
    expect(ApiError.parse(await res.json()).error).toMatchObject({ code: "UNAVAILABLE", retryable: true });
  });
});
