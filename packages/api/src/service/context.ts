import type { Budget, RecommendationRequest, ResolvedRequest } from "@outrn/contracts";
import type { Category, LatLon } from "@outrn/core";
import { findArea, isServedArea, type Queryable, type ServiceAreaRow } from "@outrn/db";
import { loadParkingBuffer, type Company, type Mood, type RequestContext } from "@outrn/engine";
import { COMPANIES, MOODS, REQUESTABLE_CATEGORIES } from "../config.js";
import { invalid } from "../errors.js";

/**
 * One place where a request becomes an engine context: the API, the ops console and the CLI all
 * resolve requests here, so they cannot drift apart.
 */

/** Engine knobs the CLI and backtests may set; not part of the public contract. */
export interface InternalOverrides {
  origin?: LatLon;
  backBy?: Date;
  maxTravelMinutes?: number;
  requireWheelchair?: boolean;
  /** Evaluate an area that is not open yet (operators checking a new area before launch). */
  includeUnlaunched?: boolean;
}

export interface ResolvedContext {
  area: ServiceAreaRow;
  ctx: RequestContext;
  resolved: ResolvedRequest;
  /** The request as received (already schema-valid). */
  request: RecommendationRequest;
}

export async function resolveRequest(q: Queryable, request: RecommendationRequest, now: Date, overrides: InternalOverrides = {}): Promise<ResolvedContext> {
  const area = await findArea(q, request.areaId);
  if (!area) throw invalid("areaId", `unknown area "${request.areaId}"`);
  if (!isServedArea(area) && !overrides.includeUnlaunched) throw invalid("areaId", `"${request.areaId}" is not open yet`);
  if (request.mood !== undefined && !(request.mood in MOODS)) throw invalid("mood", `unknown mood "${request.mood}"`);
  if (request.company !== undefined && !(request.company in COMPANIES)) throw invalid("company", `unknown company "${request.company}"`);
  const categories = request.categories ?? [];
  categories.forEach((c, i) => {
    if (!(REQUESTABLE_CATEGORIES as readonly string[]).includes(c)) throw invalid(`categories.${i}`, `unknown category "${c}"`);
  });
  const budget: Budget = request.budget ?? { kind: "any" };
  if (budget.kind === "max" && budget.currency !== "USD") throw invalid("budget.currency", "only USD is supported");

  const at = request.at ? new Date(request.at) : now;
  const mode = request.travelMode ?? area.travel_mode;
  const ctx: RequestContext = {
    origin: overrides.origin ?? { lat: area.lat, lon: area.lon },
    now: at,
    windowMinutes: request.windowMinutes,
    mode,
    timezone: area.timezone,
  };
  if (budget.kind === "free") ctx.budget = "free";
  if (budget.kind === "max") ctx.budget = budget.maxCents / 100;
  if (request.mood) ctx.mood = request.mood as Mood;
  if (request.company) ctx.company = request.company as Company;
  if (request.youngestAge !== undefined) ctx.youngestAge = request.youngestAge;
  if (categories.length) ctx.categories = categories as Category[];
  if (overrides.backBy) ctx.backBy = overrides.backBy;
  if (overrides.maxTravelMinutes) ctx.maxTravelMinutes = overrides.maxTravelMinutes;
  if (overrides.requireWheelchair) ctx.requireWheelchair = true;
  if (mode === "drive") {
    const parking = await loadParkingBuffer(q, area.slug, at, area.timezone);
    if (parking !== undefined) ctx.parkingBufferMinutes = parking;
  }

  const resolved: ResolvedRequest = {
    areaId: area.slug,
    windowMinutes: request.windowMinutes,
    travelMode: mode,
    travelModeIsDefault: request.travelMode === undefined,
    budget,
    mood: request.mood ?? null,
    company: request.company ?? null,
    youngestAge: request.youngestAge ?? null,
    categories,
    at: at.toISOString(),
    atIsExplicit: request.at !== undefined,
  };
  return { area, ctx, resolved, request };
}
