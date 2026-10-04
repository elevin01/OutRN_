import type { RecommendationItem, RecommendationRequest, RecommendationResponse } from "@outrn/contracts";

/** How soon an event must start to be "happening soon" (the same as the mobile app's). */
export const SOON_MINUTES = 120;

/**
 * The events-only search beside a search: who is going, when, how and for how much, and the taste,
 * but not the kind of place asked for (a nudge is not narrowed to restaurants).
 */
export function eventsOnlyOf(request: RecommendationRequest): RecommendationRequest {
  const { categories: _c, cuisines: _q, diets: _d, features: _f, visitStyle: _v, ...rest } = request;
  return { ...rest, eventsOnly: true };
}

/**
 * Events from an events-only search starting within two hours (or on now and still joinable, which
 * the engine has checked), loves first, at most `max`.
 */
export function happeningSoon(response: RecommendationResponse | null | undefined, now: number, max = 3): RecommendationItem[] {
  if (!response) return [];
  const soon = response.items.filter((i) => {
    if (i.kind !== "event" || !i.event) return false;
    const starts = Date.parse(i.event.startsAt);
    return Number.isFinite(starts) && starts - now <= SOON_MINUTES * 60_000;
  });
  const loved = (i: RecommendationItem) => i.reasons.some((r) => r.code === "TASTE_MATCH");
  return [...soon.filter(loved), ...soon.filter((i) => !loved(i))].slice(0, max);
}
