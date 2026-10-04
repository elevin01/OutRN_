import type { RecommendationItem, RecommendationResponse } from "@outrn/contracts";

/** How soon an event must start to be "happening soon". */
export const SOON_MINUTES = 120;

/**
 * The event worth a nudge from an events-only search: one starting within the next two hours (or on
 * now and still joinable, which the engine has already checked), one this person loves first, else
 * the engine's best. Null when nothing is on soon.
 */
export function happeningSoon(
  response: RecommendationResponse | undefined,
  now: number,
): RecommendationItem | null {
  if (!response || !(Date.parse(response.expiresAt) > now)) return null;
  const soon = response.items.filter((i) => {
    if (i.kind !== "event" || !i.event) return false;
    const starts = Date.parse(i.event.startsAt);
    const ends = Date.parse(i.event.endsAt ?? i.timing.finishBy);
    if (!Number.isFinite(ends) || ends <= now) return false;
    return Number.isFinite(starts) && starts - now <= SOON_MINUTES * 60_000;
  });
  return (
    soon.find((i) => i.reasons.some((r) => r.code === "TASTE_MATCH")) ??
    soon[0] ??
    null
  );
}
