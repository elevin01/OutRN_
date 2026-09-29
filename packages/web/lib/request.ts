import type { AreasResponse, Budget, RecommendationRequest, ResolvedRequest } from "@outrn/contracts";
import { integer, one, type Search } from "./query";

/** Search form (URL query) ⇄ API request. Option ids come from GET /v1/areas. */

export type FormValues = Record<string, string | undefined>;

function sameBudget(a: Budget, b: Budget): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function requestFromQuery(query: Search, meta: AreasResponse): RecommendationRequest {
  const { filters, limits } = meta;
  const travelMode = filters.travelModes.find((m) => m.id === one(query["mode"]))?.id;
  const budget = filters.budgets.find((b) => b.id === one(query["budget"]))?.budget;
  const youngest = one(query["youngest"]);
  const request: RecommendationRequest = {
    areaId: one(query["area"]) || meta.defaultAreaId,
    windowMinutes: integer(query["minutes"], filters.defaultWindowMinutes, limits.windowMinutes.min, limits.windowMinutes.max),
  };
  if (travelMode) request.travelMode = travelMode;
  if (budget && budget.kind !== "any") request.budget = budget;
  for (const key of ["mood", "company"] as const) {
    const value = one(query[key]);
    if (value) request[key] = value;
  }
  // One kind from the form's select, or several from a category shortcut ("categories=park,garden").
  const offered = new Set(filters.categories.map((c) => c.id));
  const several = (one(query["categories"]) ?? "").split(",").filter((id) => offered.has(id)).slice(0, limits.maxCategories);
  const category = one(query["category"]);
  if (several.length) request.categories = several;
  else if (category) request.categories = [category];
  if (youngest) request.youngestAge = integer(youngest, 0, limits.youngestAge.min, limits.youngestAge.max);
  const at = one(query["at"]);
  if (at) {
    const parsed = new Date(at);
    if (!Number.isNaN(parsed.getTime())) request.at = parsed.toISOString();
  }
  return request;
}

/** The form's values for a search the API already resolved (e.g. when paging by cursor). */
export function formFromResolved(r: ResolvedRequest, meta: AreasResponse): FormValues {
  return {
    area: r.areaId,
    minutes: String(r.windowMinutes),
    mode: r.travelModeIsDefault ? "" : r.travelMode,
    budget: meta.filters.budgets.find((b) => sameBudget(b.budget, r.budget))?.id ?? "any",
    mood: r.mood ?? "",
    company: r.company ?? "",
    category: r.categories.length === 1 ? r.categories[0] : "",
    categories: r.categories.length > 1 ? r.categories.join(",") : undefined,
    youngest: r.youngestAge === null ? undefined : String(r.youngestAge),
    at: r.atIsExplicit ? r.at : undefined,
  };
}

/** A URL that runs this request as a new search. */
export function hrefForRequest(r: RecommendationRequest, meta: AreasResponse, base = "/"): string {
  const params = new URLSearchParams({ run: "1", area: r.areaId, minutes: String(r.windowMinutes) });
  if (r.travelMode) params.set("mode", r.travelMode);
  const budget = r.budget && meta.filters.budgets.find((b) => sameBudget(b.budget, r.budget!));
  if (budget) params.set("budget", budget.id);
  if (r.mood) params.set("mood", r.mood);
  if (r.company) params.set("company", r.company);
  if (r.categories?.length === 1) params.set("category", r.categories[0]!);
  else if (r.categories?.length) params.set("categories", r.categories.join(","));
  if (r.youngestAge !== undefined) params.set("youngest", String(r.youngestAge));
  if (r.at) params.set("at", r.at);
  return `${base}?${params.toString()}`;
}
