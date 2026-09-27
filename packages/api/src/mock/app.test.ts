import { describe, expect, it } from "vitest";
import { ApiError, AreasResponse, OpsRunDetail, OpsRunList, PlaceDetails, RecommendationResponse, ROUTES } from "@outrn/contracts";
import { scenarios } from "@outrn/contracts/fixtures";
import { createApp } from "../http/app.js";
import { createMockApp } from "./app.js";

/** The mock must behave like the real API for every scenario, with no database. */

const mock = createMockApp();
const call = async (method: "GET" | "POST", path: string, body?: unknown) => {
  const res = await mock.request(path, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, json: (await res.json()) as unknown, headers: res.headers };
};

describe("mock API", () => {
  it("lists every scenario as an area", async () => {
    const areas = AreasResponse.parse((await call("GET", "/v1/areas")).json);
    for (const s of scenarios) expect(areas.areas.map((a) => a.id)).toContain(s.area.id);
  });

  it.each(scenarios.map((s) => [s.id, s] as const))("scenario %s: search, then every page by cursor, then each place", async (_, s) => {
    const first = await call("POST", "/v1/recommendations", { ...s.request, windowMinutes: 120 });
    expect(first.headers.get("x-outrn-mock")).toBe("1");
    if (s.error) {
      expect(first.status).toBeGreaterThanOrEqual(400);
      ApiError.parse(first.json);
      return;
    }
    let page = RecommendationResponse.parse(first.json);
    expect(page.request.windowMinutes).toBe(120); // echoes what was asked
    const ids = [...page.items.map((i) => i.id)];
    while (page.page.nextCursor) {
      const r = await call("POST", "/v1/recommendations", { cursor: page.page.nextCursor });
      if (s.expiresAfterFirstPage) {
        expect(r.status).toBe(410);
        expect(ApiError.parse(r.json).error.restart).toBeDefined();
        break;
      }
      page = RecommendationResponse.parse(r.json);
      ids.push(...page.items.map((i) => i.id));
      if (page.page.prevCursor) expect((await call("POST", "/v1/recommendations", { cursor: page.page.prevCursor })).status).toBe(200);
    }
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of s.pages) for (const item of p.items) PlaceDetails.parse((await call("GET", `/v1/places/${item.placeId}`)).json);
  });

  it("validates requests like the real API", async () => {
    const r = await call("POST", "/v1/recommendations", { areaId: "les", windowMinutes: 5 });
    expect(r.status).toBe(400);
    expect(ApiError.parse(r.json).error.fields?.[0]?.path).toBe("windowMinutes");
    expect((await call("POST", "/v1/recommendations", { areaId: "nowhere", windowMinutes: 120 })).status).toBe(400);
    expect((await call("POST", "/v1/recommendations", { cursor: "garbage" })).status).toBe(400);
    expect((await call("GET", "/v1/places/nope")).status).toBe(404);
  });

  it("serves ops views", async () => {
    OpsRunDetail.parse((await call("POST", "/ops/v1/evaluate", { areaId: "les", windowMinutes: 180 })).json);
    const runs = OpsRunList.parse((await call("GET", "/ops/v1/runs")).json);
    OpsRunDetail.parse((await call("GET", `/ops/v1/runs/${runs.runs[0]!.id}`)).json);
  });

  it("answers every contract route, as the real API does", async () => {
    const real = createApp({ db: () => { throw Object.assign(new Error("no db in this test"), { code: "ECONNREFUSED" }); }, allowOpenOps: true, log: () => undefined });
    for (const r of Object.values(ROUTES)) {
      const path = r.path.replace(":id", "00000000-0000-4000-8000-000000000001");
      const init = { method: r.method, headers: { "content-type": "application/json" }, ...(r.method === "POST" ? { body: JSON.stringify({ areaId: "les", windowMinutes: 120 }) } : {}) };
      const m = await mock.request(path, init);
      const x = await real.request(path, init);
      // Registered on both: never a "no route" 404 (a place or run id may legitimately be missing).
      const noRoute = async (res: Response) => res.status === 404 && ((await res.json()) as { error: { message: string } }).error.message.startsWith("No route");
      expect(await noRoute(m), `mock ${r.method} ${r.path}`).toBe(false);
      expect(await noRoute(x), `real ${r.method} ${r.path}`).toBe(false);
    }
  });
});
