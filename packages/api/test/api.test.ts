import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { ApiError, AreasResponse, OpsRunDetail, OpsRunList, PlaceDetails, RecommendationResponse, type RecommendationRequest } from "@outrn/contracts";
import { getArea, loadParkingRule, reset, setLaunchState, testDatabaseAvailable } from "@outrn/db";
import { materializeSubjects, writeFacts } from "@outrn/facts";
import { ingestExtentFor, ingestOsmArea } from "@outrn/ingest";
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
    expect(r.headers.get("x-outrn-contract")).toBe("1.1.0");
    const areas = AreasResponse.parse(r.json);
    expect(areas.areas.map((a) => a.id)).toEqual(expect.arrayContaining(["les", "bronxville"]));
    expect(areas.areas.find((a) => a.id === "bronxville")?.defaultTravelMode).toBe("drive");
    expect(areas.filters.categories.map((c) => c.id)).toContain("bowling");
  });

  it("serves only launched areas; operators can evaluate one before it opens", async () => {
    now = SAT_EVENING;
    const listed = AreasResponse.parse((await call("GET", "/v1/areas")).json).areas.map((a) => a.id);
    expect(listed).toEqual(expect.arrayContaining(["les", "bronxville"]));
    expect(listed).not.toContain("yonkers");
    const closed = await call("POST", "/v1/recommendations", { areaId: "yonkers", windowMinutes: 120 });
    expect(closed.status).toBe(400);
    expect(ApiError.parse(closed.json).error.fields).toEqual([{ path: "areaId", message: '"yonkers" is not open yet' }]);
    const ops = await call("POST", "/ops/v1/evaluate", { areaId: "yonkers", windowMinutes: 120 }, { authorization: `Bearer ${TOKEN}` });
    expect(ops.status).toBe(200);
    expect(OpsRunDetail.parse(ops.json).areaName).toBe("Yonkers");
    await setLaunchState(db, "yonkers", "private_beta");
    try {
      expect(AreasResponse.parse((await call("GET", "/v1/areas")).json).areas.map((a) => a.id)).toContain("yonkers");
      const open = await search({ areaId: "yonkers", windowMinutes: 120 });
      expect(open.request.travelMode).toBe("drive");
      expect(open.area.name).toBe("Yonkers");
    } finally {
      await setLaunchState(db, "yonkers", "ingest_only");
    }
  });

  it("seeds the Westchester and Bronx areas with parking estimates, and derives their ingest extents", async () => {
    const rows = (await db.query<{ slug: string; travel_mode: string; launch_state: string }>("select slug, travel_mode, launch_state from service_areas order by slug")).rows;
    const added = ["bronx", "mamaroneck", "mount_vernon", "new_rochelle", "port_chester", "rye", "scarsdale", "tarrytown", "white_plains", "yonkers"];
    for (const slug of added) expect(rows.find((r) => r.slug === slug), slug).toMatchObject({ launch_state: "ingest_only" });
    expect(rows.find((r) => r.slug === "bronx")?.travel_mode).toBe("transit");
    for (const slug of added) {
      const area = await getArea(db, slug);
      const parking = await loadParkingRule(db, slug);
      const extent = ingestExtentFor(area, parking);
      if (area.travel_mode === "drive") {
        expect(parking, slug).not.toBeNull();
        expect(extent.radiusM, slug).toBeGreaterThan(12_000);
        expect(extent.radiusM, slug).toBeLessThan(17_000);
      } else {
        expect(extent.radiusM, slug).toBeGreaterThan(10_000);
        expect(extent.radiusM, slug).toBeLessThan(14_000);
      }
    }
    expect(await loadParkingRule(db, "bronx")).toMatchObject({ defaultMinutes: 15 });
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

  it("plans from the device's location (rounded, inside the area) and stores only the rounded point", async () => {
    now = SAT_EVENING;
    const fromCenter = await search({ areaId: "les", windowMinutes: 180 });
    expect(fromCenter.request).toMatchObject({ originIsDefault: true, origin: { lat: 40.7185, lon: -73.988 }, backBy: null });
    const device = { lat: 40.714567891, lon: -73.99123456 };
    const fromDevice = await search({ areaId: "les", windowMinutes: 180, origin: device });
    expect(fromDevice.request).toMatchObject({ originIsDefault: false, origin: { lat: 40.715, lon: -73.991 } });
    const stored = (await db.query<{ request: { origin?: unknown } }>("select request from recommendation_snapshots where run_id = $1", [fromDevice.requestId])).rows[0]!;
    expect(stored.request.origin).toEqual({ lat: 40.715, lon: -73.991 });
    // Same venue, different start: travel differs for at least one shared item.
    const all = async (first: RecommendationResponse) => {
      const items = [...first.items];
      let p = first;
      while (p.page.nextCursor) {
        p = await search({ cursor: p.page.nextCursor } as unknown as RecommendationRequest);
        items.push(...p.items);
      }
      return new Map(items.map((i) => [i.id, i.timing.travel.minutes]));
    };
    const a = await all(fromCenter);
    const b = await all(fromDevice);
    expect([...b].some(([id, minutes]) => a.has(id) && a.get(id) !== minutes)).toBe(true);
    // Bronxville is not on the Lower East Side.
    const far = await call("POST", "/v1/recommendations", { areaId: "les", windowMinutes: 180, origin: { lat: 40.941, lon: -73.835 } });
    expect(far.status).toBe(400);
    expect(ApiError.parse(far.json).error.fields?.[0]?.path).toBe("origin");
  });

  it("honours be-back-by, dismissals and recently seen items", async () => {
    now = SAT_EVENING;
    const backBy = new Date(SAT_EVENING.getTime() + 100 * 60_000);
    const back = await search({ areaId: "les", windowMinutes: 180, backBy: backBy.toISOString() });
    expect(back.request.backBy).toBe(backBy.toISOString());
    let p = back;
    for (;;) {
      for (const item of p.items) expect(Date.parse(item.timing.finishBy), item.name).toBeLessThanOrEqual(backBy.getTime());
      if (!p.page.nextCursor) break;
      p = await search({ cursor: p.page.nextCursor } as unknown as RecommendationRequest);
    }
    const early = await call("POST", "/v1/recommendations", { areaId: "les", windowMinutes: 180, backBy: SAT_EVENING.toISOString() });
    expect(ApiError.parse(early.json).error.fields?.[0]?.path).toBe("backBy");

    const plain = await search({ areaId: "les", windowMinutes: 180 });
    const first = plain.items[0]!;
    const dismissed = await search({ areaId: "les", windowMinutes: 180, dismissedIds: [first.id] });
    const ids: string[] = [];
    for (let q = dismissed; ; ) {
      ids.push(...q.items.map((i) => i.id));
      if (!q.page.nextCursor) break;
      q = await search({ cursor: q.page.nextCursor } as unknown as RecommendationRequest);
    }
    expect(ids).not.toContain(first.id);
    const seen = await search({ areaId: "les", windowMinutes: 180, seenIds: [first.id] });
    expect(seen.items[0]!.id).not.toBe(first.id);
    // A run keeps how many ids a device sent, never which ones.
    const ctxRow = (await db.query<{ context: Record<string, unknown> }>("select context from recommendation_runs where id = $1", [seen.requestId])).rows[0]!;
    expect(ctxRow.context).toMatchObject({ seenCount: 1, dismissedCount: 0 });
    expect(ctxRow.context).not.toHaveProperty("seenIds");
    expect(ctxRow.context).not.toHaveProperty("dismissedIds");
  });

  it("accepts only item ids (UUIDs) in seen and dismissed lists", async () => {
    for (const bad of ["x".repeat(10_000), "not-a-uuid", ""]) {
      const r = await call("POST", "/v1/recommendations", { areaId: "les", windowMinutes: 180, seenIds: [bad] });
      expect(r.status).toBe(400);
      expect(ApiError.parse(r.json).error.fields?.[0]?.path).toBe("seenIds.0");
    }
    const tooMany = Array.from({ length: 201 }, () => crypto.randomUUID());
    expect((await call("POST", "/v1/recommendations", { areaId: "les", windowMinutes: 180, dismissedIds: tooMany })).status).toBe(400);
  });

  it("keeps recommendation runs for 30 days, without breaking rows that point at them", async () => {
    now = SAT_EVENING;
    const old = (await db.query<{ id: string }>(
      `insert into recommendation_runs (area_id, context, candidate_count, results, shortlist, engine_version, weights_version, created_at)
       values (null, '{}', 0, '[]', '[]', 'test', 'test', $1) returning id`,
      [new Date(SAT_EVENING.getTime() - 31 * 86_400_000)],
    )).rows[0]!.id;
    const event = (await db.query<{ id: string }>(`insert into interaction_events (device_id, run_id, type) values ('device-1', $1, 'impression') returning id`, [old])).rows[0]!.id;
    const recent = await search({ areaId: "les", windowMinutes: 120 }); // a search prunes, and its own run is new
    expect((await db.query("select 1 from recommendation_runs where id = $1", [old])).rowCount).toBe(0);
    expect((await db.query("select 1 from recommendation_runs where id = $1", [recent.requestId])).rowCount).toBe(1);
    expect((await db.query<{ run_id: string | null }>("select run_id from interaction_events where id = $1", [event])).rows[0]!.run_id).toBeNull();
  });

  it("knows when the sun sets: outdoor places get the sunset window before dusk", async () => {
    now = new Date("2026-10-03T21:50:00Z"); // 5:50pm; sunset ~6:36pm
    const page = await search({ areaId: "les", windowMinutes: 120, categories: ["park"] });
    const reasons = page.items.flatMap((i) => i.reasons.map((r) => r.code));
    expect(reasons).toContain("SUNSET_WINDOW");
    now = SAT_EVENING;
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

  it("pages a snapshot written before contract 1.1, and expires one it cannot read", async () => {
    now = SAT_EVENING;
    const first = await search({ areaId: "les", windowMinutes: 180 });
    const next = { cursor: first.page.nextCursor! } as unknown as RecommendationRequest;
    const expected = (await search(next)).items.map((i) => i.id);
    // Exactly what a v1.0 API stored: no origin, originIsDefault or backBy in the resolved request.
    await db.query(`update recommendation_snapshots set resolved = resolved - 'origin' - 'originIsDefault' - 'backBy' where run_id = $1`, [first.requestId]);
    const upgraded = await search(next);
    expect(upgraded.items.map((i) => i.id)).toEqual(expected);
    expect(upgraded.request).toMatchObject({ origin: { lat: 40.7185, lon: -73.988 }, originIsDefault: true, backBy: null });

    // A shape nobody can read: expire it and hand back the search to run again.
    await db.query(`update recommendation_snapshots set resolved = '{}' where run_id = $1`, [first.requestId]);
    const unreadable = await call("POST", "/v1/recommendations", next);
    expect(unreadable.status).toBe(410);
    expect(ApiError.parse(unreadable.json).error).toMatchObject({ code: "CURSOR_EXPIRED", restart: { areaId: "les", windowMinutes: 180 } });

    // Not even the request is readable: start over.
    await db.query(`update recommendation_snapshots set request = '"garbage"' where run_id = $1`, [first.requestId]);
    const lost = await call("POST", "/v1/recommendations", next);
    expect([lost.status, ApiError.parse(lost.json).error.code]).toEqual([400, "CURSOR_INVALID"]);
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

  it("names an OSM mapper's survey on place details, never as our confirmation", async () => {
    const id = (await db.query<{ id: string }>("select id from venues where canonical_name = 'Grand Kitchen'")).rows[0]!.id;
    const record = (await db.query<{ external_id: string }>(`select se.external_id from entity_links el join source_entities se on se.id = el.source_entity_id where el.venue_id = $1 and el.superseded_by is null`, [id])).rows[0]!.external_id;
    // The fixture's own hours, re-asserted by its record with the survey a mapper recorded before the element's last edit.
    await writeFacts(db, [{ subjectKind: "venue", subjectId: id, attribute: "opening_hours", value: { osm: "Mo-Su 11:00-23:00" }, evidenceClass: "published", sourceId: "osm", sourceRecord: record, lineageGroup: "osm", evidence: "opening_hours=Mo-Su 11:00-23:00; check_date:opening_hours=2026-04-01", sourceUpdatedAt: new Date("2026-04-19T00:00:00Z"), observedAt: new Date("2026-04-01T12:00:00Z"), fetchedAt: new Date("2026-09-26T00:00:00Z"), confidence: 0.69 }]);
    await materializeSubjects(db, "venue", [id], now);
    const r = await call("GET", `/v1/places/${id}`);
    const hours = PlaceDetails.parse(r.json).facts.find((f) => f.attribute === "opening_hours")!;
    expect(hours.provenance).toMatchObject({ freshness: "checked by an OSM mapper Apr 2026", verifiedAt: null, dueForRecheck: false, sourceUpdatedAt: "2026-04-19T00:00:00.000Z" });
    expect(hours.provenance.summary).not.toMatch(/confirmed/);
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

  it("enforces a published closing date from its day, before any ingest records the closure", async () => {
    const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as { elements: { lat: number; lon: number; tags: Record<string, string> }[] };
    const el = fixture.elements.find((e) => e.tags["name"] === "Delancey Coffee")!;
    const path = join(mkdtempSync(join(tmpdir(), "outrn-")), "closing.json");
    writeFileSync(path, JSON.stringify({ ...fixture, elements: [{ ...el, tags: { ...el.tags, opening_hours: "24/7", end_date: "2026-11-10" } }], outrn_extent: { lat: el.lat, lon: el.lon, radius_m: 5 } }));
    // Normalized on Nov 1; no ingest or materialization runs after that.
    await ingestOsmArea(db, { areaSlug: "les", fromFile: path, clock: () => new Date("2026-11-01T15:00:00Z") });
    const decision = async (at: string) => {
      const run = await runEngine(db, { areaId: "les", windowMinutes: 120, categories: ["cafe"] }, { clock: () => new Date(at), persist: false });
      return run.shortlist.all.find((e) => e.candidate.name === "Delancey Coffee")!;
    };
    expect((await decision("2026-11-09T17:00:00Z")).excludedBy).toBeNull(); // noon the day before
    for (const at of ["2026-11-10T05:01:00Z", "2026-11-10T17:00:00Z"]) {
      // 00:01 and noon on the closing day, New York
      const closed = await decision(at);
      expect([closed.class, closed.excludedBy], at).toEqual(["ineligible", "CLOSED_PERMANENTLY"]);
    }
    // 23:59 the night before: the visit would run past the closure.
    expect((await decision("2026-11-10T04:59:00Z")).excludedBy).toBe("CLOSED_PERMANENTLY");
  });

  it("reports an unreachable database as a retryable outage", async () => {
    const down = createApp({ db: () => { throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }); }, log: () => undefined });
    const res = await down.request("/v1/areas");
    expect(res.status).toBe(503);
    expect(ApiError.parse(await res.json()).error).toMatchObject({ code: "UNAVAILABLE", retryable: true });
  });
});
