import type { Budget, RecommendationRequest, ResolvedRequest } from "@outrn/contracts";
import { CUISINE_FILTERS, haversineMetres, type Category, type LatLon } from "@outrn/core";
import { findArea, isServedArea, type Queryable, type ServiceAreaRow } from "@outrn/db";
import { loadParkingBuffer, loadWeather, sunsetOn, type Company, type Mood, type RequestContext } from "@outrn/engine";
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
  /** The request as used: schema-valid, with its origin already rounded. The only form that is stored. */
  request: RecommendationRequest;
}

/** ~100 m: plenty for a travel estimate, and no more precise a location than we need to keep. */
export function roundOrigin(p: LatLon): LatLon {
  return { lat: Math.round(p.lat * 1000) / 1000, lon: Math.round(p.lon * 1000) / 1000 };
}

/** How far outside an area's catchment a device may be and still plan from where it is. */
const ORIGIN_SLACK_M = 1500;
const MAX_BACK_BY_HOURS = 24;

export async function resolveRequest(q: Queryable, request: RecommendationRequest, now: Date, overrides: InternalOverrides = {}): Promise<ResolvedContext> {
  const area = await findArea(q, request.areaId);
  if (!area) throw invalid("areaId", `unknown area "${request.areaId}"`);
  if (!isServedArea(area) && !overrides.includeUnlaunched) throw invalid("areaId", `"${request.areaId}" is not open yet`);
  // The table's own keys only: `in` also finds "constructor", "toString", "__proto__"…
  if (request.mood !== undefined && !Object.hasOwn(MOODS, request.mood)) throw invalid("mood", `unknown mood "${request.mood}"`);
  if (request.company !== undefined && !Object.hasOwn(COMPANIES, request.company)) throw invalid("company", `unknown company "${request.company}"`);
  const categories = request.categories ?? [];
  categories.forEach((c, i) => {
    if (!(REQUESTABLE_CATEGORIES as readonly string[]).includes(c)) throw invalid(`categories.${i}`, `unknown category "${c}"`);
  });
  const cuisines = request.cuisines ?? [];
  cuisines.forEach((c, i) => {
    if (!Object.hasOwn(CUISINE_FILTERS, c)) throw invalid(`cuisines.${i}`, `unknown cuisine "${c}"`);
  });
  const budget: Budget = request.budget ?? { kind: "any" };
  if (budget.kind === "max" && budget.currency !== "USD") throw invalid("budget.currency", "only USD is supported");

  const at = request.at ? new Date(request.at) : now;
  const mode = request.travelMode ?? area.travel_mode;
  const center = { lat: Number(area.lat), lon: Number(area.lon) };
  const deviceOrigin = request.origin ? roundOrigin(request.origin) : undefined;
  if (deviceOrigin && haversineMetres(deviceOrigin, center) > (area.radius_m ?? 1500) + ORIGIN_SLACK_M) {
    throw invalid("origin", `outside ${area.name}; choose the area you are in`);
  }
  const backBy = request.backBy ? new Date(request.backBy) : undefined;
  if (backBy && (backBy <= at || backBy.getTime() - at.getTime() > MAX_BACK_BY_HOURS * 3_600_000)) {
    throw invalid("backBy", `must be after the plan's start and within ${MAX_BACK_BY_HOURS} hours of it`);
  }
  const origin = overrides.origin ?? deviceOrigin ?? center;
  const ctx: RequestContext = {
    origin,
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
  if (cuisines.length) ctx.cuisines = cuisines;
  if (backBy ?? overrides.backBy) ctx.backBy = (backBy ?? overrides.backBy)!;
  if (request.seenIds?.length) ctx.seenIds = request.seenIds;
  if (request.dismissedIds?.length) ctx.dismissedIds = request.dismissedIds;
  if (request.visitStyle === "takeout") ctx.visitStyle = "takeout";
  // Enables the sunset window for viewpoints, waterfronts and parks.
  ctx.sunset = sunsetOn(origin, at, area.timezone);
  // The area's stored forecast (outrn weather refresh), when it is current and covers the start.
  const weather = await loadWeather(q, area.id, at, request.windowMinutes, now);
  if (weather) ctx.weather = weather;
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
    cuisines,
    at: at.toISOString(),
    atIsExplicit: request.at !== undefined,
    origin,
    originIsDefault: origin === center,
    backBy: backBy?.toISOString() ?? null,
    visitStyle: request.visitStyle ?? "dine_in",
  };
  return { area, ctx, resolved, request: deviceOrigin ? { ...request, origin: deviceOrigin } : request };
}
