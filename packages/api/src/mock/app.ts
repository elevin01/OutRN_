import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { CONTRACT_VERSION, PageRequest, RecommendationRequest, type AreasResponse, type RecommendationResponse, type ResolvedRequest } from "@outrn/contracts";
import { areas, errors, ops, places, scenarios, type ErrorFixture } from "@outrn/contracts/fixtures";
import type { z } from "zod/v4";

/**
 * The mock API: the same routes and contract as the real one, answered from the fixtures. No
 * Postgres, no engine, no credentials. Each scenario is listed as an area ("Mock · fewer than
 * three", …) so every screen state is one dropdown choice away.
 *
 * Deliberately imports nothing but the contract, the fixtures and Hono.
 */

const byCursor = new Map<string, RecommendationResponse>();
const expiredCursors = new Set<string>();
for (const s of scenarios) {
  s.pages.forEach((p, i) => {
    const next = s.pages[i + 1];
    if (p.page.nextCursor && next) byCursor.set(p.page.nextCursor, next);
    if (p.page.nextCursor && s.expiresAfterFirstPage) expiredCursors.add(p.page.nextCursor);
    const prev = s.pages[i - 1];
    if (p.page.prevCursor && prev) byCursor.set(p.page.prevCursor, prev);
  });
}

const realAreaIds = new Set(areas.areas.map((a) => a.id));
const mockAreas: AreasResponse = {
  ...areas,
  areas: [...areas.areas, ...scenarios.filter((s) => !realAreaIds.has(s.area.id)).map((s) => s.area)],
};

function fail(c: Context, name: string, override?: Partial<ErrorFixture["body"]["error"]>) {
  const e = errors[name]!;
  return c.json({ error: { ...e.body.error, ...override } }, e.status as ContentfulStatusCode);
}

function invalidBody(c: Context, error: z.ZodError) {
  const fields = error.issues.map((i) => ({ path: i.path.map(String).join(".") || "(body)", message: i.message }));
  return fail(c, "validation", { message: `The request is not valid: ${fields.map((f) => `${f.path}: ${f.message}`).join("; ")}`, fields });
}

/** Echo the caller's choices into the fixture so headings and the form match what was asked. */
function echo(page: RecommendationResponse, body: RecommendationRequest): RecommendationResponse {
  const area = mockAreas.areas.find((a) => a.id === body.areaId)!;
  const request: ResolvedRequest = {
    ...page.request,
    areaId: body.areaId,
    windowMinutes: body.windowMinutes,
    travelMode: body.travelMode ?? area.defaultTravelMode,
    travelModeIsDefault: body.travelMode === undefined,
    budget: body.budget ?? { kind: "any" },
    mood: body.mood ?? null,
    company: body.company ?? null,
    youngestAge: body.youngestAge ?? null,
    categories: body.categories ?? [],
    ...(body.at ? { at: body.at, atIsExplicit: true } : {}),
    origin: body.origin ? { lat: Math.round(body.origin.lat * 1000) / 1000, lon: Math.round(body.origin.lon * 1000) / 1000 } : area.center,
    originIsDefault: body.origin === undefined,
    backBy: body.backBy ?? null,
  };
  return { ...page, request };
}

export function createMockApp(opts: { log?: (line: string) => void } = {}): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    const t0 = Date.now();
    await next();
    c.header("x-outrn-contract", CONTRACT_VERSION);
    c.header("x-outrn-mock", "1");
    opts.log?.(`${c.req.method} ${c.req.path} ${c.res.status} ${Date.now() - t0}ms (mock)`);
  });
  app.use("/v1/*", cors({ origin: (origin) => origin, allowMethods: ["GET", "POST"] }));

  app.get("/healthz", (c) => c.json({ ok: true, mock: true }));
  app.get("/v1/areas", (c) => c.json(mockAreas));

  app.post("/v1/recommendations", async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return fail(c, "validation", { message: "The body must be JSON.", fields: [{ path: "(body)", message: "not valid JSON" }] });
    }
    if (raw && typeof raw === "object" && "cursor" in raw) {
      const parsed = PageRequest.safeParse(raw);
      if (!parsed.success) return invalidBody(c, parsed.error);
      if (expiredCursors.has(parsed.data.cursor)) return fail(c, "cursor-expired");
      const page = byCursor.get(parsed.data.cursor);
      return page ? c.json(page) : fail(c, "cursor-invalid");
    }
    const parsed = RecommendationRequest.safeParse(raw);
    if (!parsed.success) return invalidBody(c, parsed.error);
    const body = parsed.data;
    const scenario = scenarios.find((s) => s.area.id === body.areaId);
    if (!scenario) return fail(c, "unknown-area", { message: `areaId: unknown area "${body.areaId}"`, fields: [{ path: "areaId", message: `unknown area "${body.areaId}"` }] });
    if (scenario.error) return fail(c, scenario.error);
    return c.json(echo(scenario.pages[0]!, body));
  });

  app.get("/v1/places/:id", (c) => {
    const place = places[c.req.param("id")];
    return place ? c.json(place) : fail(c, "not-found");
  });

  // Ops: open in the mock (there is nothing to protect), same shapes as the real routes.
  app.post("/ops/v1/evaluate", (c) => c.json(ops.evaluate));
  app.get("/ops/v1/runs", (c) => c.json(ops.runs));
  app.get("/ops/v1/runs/:id", (c) => c.json(ops.evaluate));

  app.notFound((c) => fail(c, "not-found", { message: `No route for ${c.req.method} ${c.req.path}.` }));
  return app;
}
