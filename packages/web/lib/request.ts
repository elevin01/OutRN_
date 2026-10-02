import type { AreasResponse, Budget, RecommendationRequest, ResolvedRequest, TasteWeight } from "@outrn/contracts";
import { integer, many, one, type Search } from "./query";

/** Search form (URL query) ⇄ API request. Option ids come from GET /v1/areas. */

export type FormValues = Record<string, string | undefined>;

/**
 * A like or a skip ticked on the web form, as a taste for this search. The apps keep a taste on the
 * device and learn it; the web form only says what you like now.
 */
export const FORM_TASTE_WEIGHT = 0.8;

/** Ids the area offers, once each, in the order asked, at most `max`: anything else in a URL is dropped. */
function offeredIds(values: string[], offered: readonly { id: string }[], max: number): string[] {
  const ids = new Set(offered.map((o) => o.id));
  return [...new Set(values)].filter((v) => ids.has(v)).slice(0, max);
}

/** The taste's interests whose weight passes `test`, comma-joined, or nothing. */
function idsWhere(taste: readonly TasteWeight[] | undefined, test: (weight: number) => boolean): string | undefined {
  const ids = (taste ?? []).filter((t) => test(t.weight)).map((t) => t.interest);
  return ids.length ? ids.join(",") : undefined;
}

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
  // A cuisine from the form's select, or several from a link ("cuisines=thai,vietnamese").
  const cuisines = offeredIds([...many(query["cuisines"]), ...many(query["cuisine"])], filters.cuisines, limits.maxCuisines);
  if (cuisines.length) request.cuisines = cuisines;
  const diets = offeredIds(many(query["diets"]), filters.diets, limits.maxDiets);
  if (diets.length) request.diets = diets;
  const features = offeredIds(many(query["features"]), filters.features, limits.maxFeatures);
  if (features.length) request.features = features;
  // What you like ("likes=art,live_music"), and what isn't for you ("skips=drinks"): a like wins.
  const likes = offeredIds(many(query["likes"]), filters.interests, limits.maxTaste);
  const skips = offeredIds(many(query["skips"]), filters.interests, limits.maxTaste).filter((id) => !likes.includes(id));
  const taste = [...likes.map((interest) => ({ interest, weight: FORM_TASTE_WEIGHT })), ...skips.map((interest) => ({ interest, weight: -FORM_TASTE_WEIGHT }))];
  if (taste.length) request.taste = taste.slice(0, limits.maxTaste);
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
    cuisine: r.cuisines.length === 1 ? r.cuisines[0] : "",
    cuisines: r.cuisines.length > 1 ? r.cuisines.join(",") : undefined,
    diets: r.diets.length ? r.diets.join(",") : undefined,
    features: r.features.length ? r.features.join(",") : undefined,
    likes: idsWhere(r.taste, (w) => w > 0),
    skips: idsWhere(r.taste, (w) => w < 0),
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
  if (r.cuisines?.length === 1) params.set("cuisine", r.cuisines[0]!);
  else if (r.cuisines?.length) params.set("cuisines", r.cuisines.join(","));
  if (r.diets?.length) params.set("diets", r.diets.join(","));
  if (r.features?.length) params.set("features", r.features.join(","));
  const likes = idsWhere(r.taste, (w) => w > 0);
  const skips = idsWhere(r.taste, (w) => w < 0);
  if (likes) params.set("likes", likes);
  if (skips) params.set("skips", skips);
  if (r.youngestAge !== undefined) params.set("youngest", String(r.youngestAge));
  if (r.at) params.set("at", r.at);
  return `${base}?${params.toString()}`;
}
