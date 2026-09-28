import type { z } from "zod/v4";
import { AreasResponse } from "./areas.js";
import { OpsRunDetail, OpsRunList } from "./ops.js";
import { PlaceDetails } from "./places.js";
import { RecommendationRequest, RecommendationResponse, RecommendationsBody } from "./recommendations.js";

/**
 * The v1 surface. Every route answers JSON: its `response` schema on 2xx, ApiError otherwise.
 * Ops routes need `Authorization: Bearer <OUTRN_OPS_TOKEN>`.
 */
export interface RouteSpec {
  method: "GET" | "POST";
  path: string;
  body?: z.ZodType;
  response: z.ZodType;
  ops?: true;
}

export const ROUTES = {
  areas: { method: "GET", path: "/v1/areas", response: AreasResponse },
  recommendations: { method: "POST", path: "/v1/recommendations", body: RecommendationsBody, response: RecommendationResponse },
  place: { method: "GET", path: "/v1/places/:id", response: PlaceDetails },
  opsEvaluate: { method: "POST", path: "/ops/v1/evaluate", body: RecommendationRequest, response: OpsRunDetail, ops: true },
  opsRuns: { method: "GET", path: "/ops/v1/runs", response: OpsRunList, ops: true },
  opsRun: { method: "GET", path: "/ops/v1/runs/:id", response: OpsRunDetail, ops: true },
} as const satisfies Record<string, RouteSpec>;

export type RouteName = keyof typeof ROUTES;

/** Sent on every response as `x-outrn-contract`. Minor/patch bumps are additive; a major bump is a new route prefix. */
export const CONTRACT_VERSION = "1.3.0";
