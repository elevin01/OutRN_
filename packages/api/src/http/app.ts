import { timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { CONTRACT_VERSION, PageRequest, RecommendationRequest, ROUTES } from "@outrn/contracts";
import type { Queryable } from "@outrn/db";
import type { z } from "zod/v4";
import { ApiProblem, fromZod, isUnavailable } from "../errors.js";
import { areas } from "../service/areas.js";
import { evaluate, recentRuns, storedRun } from "../service/ops.js";
import { placeDetails } from "../service/places.js";
import { recommendations } from "../service/recommendations.js";

export interface AppOptions {
  db: () => Queryable;
  clock?: () => Date;
  /** Bearer token for /ops/v1/*. */
  opsToken?: string | undefined;
  /** Without a token, serve ops routes anyway (local development only). */
  allowOpenOps?: boolean;
  /** Browser origins allowed to call /v1/* directly. */
  corsOrigins?: string[];
  log?: (line: string) => void;
}

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new ApiProblem("VALIDATION_FAILED", "The body must be JSON.", { fields: [{ path: "(body)", message: "not valid JSON" }] });
  }
}

function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const r = schema.safeParse(value);
  if (!r.success) throw fromZod(r.error);
  return r.data;
}

/**
 * The v1 HTTP boundary. Every response is checked against its contract schema before it is sent:
 * a backend change that would break the UI fails here, loudly, instead of in the browser.
 */
export function createApp(opts: AppOptions): Hono {
  const app = new Hono();
  const clock = opts.clock ?? (() => new Date());
  const service = { clock };

  app.use("*", async (c, next) => {
    const t0 = Date.now();
    await next();
    c.header("x-outrn-contract", CONTRACT_VERSION);
    opts.log?.(`${c.req.method} ${c.req.path} ${c.res.status} ${Date.now() - t0}ms`);
  });
  app.use("/v1/*", cors({ origin: opts.corsOrigins ?? ["http://localhost:3000", "http://127.0.0.1:3000"], allowMethods: ["GET", "POST"] }));

  const send = <T extends z.ZodType>(c: Context, schema: T, body: z.infer<T>) => {
    const r = schema.safeParse(body);
    if (!r.success) throw new Error(`${c.req.method} ${c.req.path}: response breaks the contract: ${r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    return c.json(body as object, 200);
  };

  app.get("/healthz", (c) => c.json({ ok: true }));

  app.get(ROUTES.areas.path, async (c) => send(c, ROUTES.areas.response, await areas(opts.db())));

  app.post(ROUTES.recommendations.path, async (c) => {
    const raw = await readJson(c);
    // Parse by shape so a bad field gets a precise error instead of "no union member matched".
    const body = raw && typeof raw === "object" && "cursor" in raw ? parse(PageRequest, raw) : parse(RecommendationRequest, raw);
    return send(c, ROUTES.recommendations.response, await recommendations(opts.db(), body, service));
  });

  app.get(ROUTES.place.path, async (c) => send(c, ROUTES.place.response, await placeDetails(opts.db(), c.req.param("id"), service)));

  app.use("/ops/*", async (c, next) => {
    if (opts.opsToken) {
      const header = c.req.header("authorization") ?? "";
      if (!sameSecret(header, `Bearer ${opts.opsToken}`)) throw new ApiProblem("UNAUTHORIZED", "Ops routes need Authorization: Bearer <OUTRN_OPS_TOKEN>.");
    } else if (!opts.allowOpenOps) {
      throw new ApiProblem("UNAUTHORIZED", "Ops routes are disabled: set OUTRN_OPS_TOKEN.");
    }
    await next();
  });
  app.post(ROUTES.opsEvaluate.path, async (c) => send(c, ROUTES.opsEvaluate.response, await evaluate(opts.db(), parse(RecommendationRequest, await readJson(c)), service)));
  app.get(ROUTES.opsRuns.path, async (c) => send(c, ROUTES.opsRuns.response, await recentRuns(opts.db(), Number.parseInt(c.req.query("limit") ?? "20", 10) || 20)));
  app.get(ROUTES.opsRun.path, async (c) => send(c, ROUTES.opsRun.response, await storedRun(opts.db(), c.req.param("id"))));

  app.notFound((c) => c.json(new ApiProblem("NOT_FOUND", `No route for ${c.req.method} ${c.req.path}.`).body(), 404));
  app.onError((err, c) => {
    const problem =
      err instanceof ApiProblem
        ? err
        : isUnavailable(err)
          ? new ApiProblem("UNAVAILABLE", "The service is temporarily unavailable. Try again shortly.")
          : new ApiProblem("INTERNAL", "Something went wrong on our side.");
    if (problem.code === "INTERNAL" || problem.code === "UNAVAILABLE") (opts.log ?? console.error)(`${c.req.method} ${c.req.path} failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    return c.json(problem.body(), problem.status as ContentfulStatusCode);
  });
  return app;
}
