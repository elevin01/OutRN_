import type { RecommendationItem } from "@outrn/contracts";
import { DEFAULT_PARKING_BUFFER_MINUTES } from "@outrn/core";
import { caveatNotes, explain, planSteps, reasonNotes, type Evaluation, type RequestContext } from "@outrn/engine";
import { labelOf } from "../config.js";
import { ageLimitFrom, directionsUrl, linksFrom, priceOf, subtypeFrom, textFrom, websiteUrl } from "./values.js";

const VISIT_LABEL: Record<string, string> = { dine_in: "Sit-down meal", counter: "Counter service", takeout: "Takeout", visit: "Visit", event: "Event" };

/**
 * Engine evaluation → public item. The engine's `Evaluation` never crosses the boundary: only what
 * the product needs, with estimates and unknowns kept explicit.
 */
export function toItem(e: Evaluation, ctx: RequestContext): RecommendationItem {
  const c = e.candidate;
  const t = e.timing;
  if (e.class === "ineligible" || !t) throw new Error(`toItem: ${c.id} is ineligible and must not be shown`);
  const copy = explain(e, ctx.timezone);
  const o = c.occurrence;
  return {
    id: c.id,
    kind: c.kind === "occurrence" ? "event" : "venue",
    placeId: c.venueId,
    name: c.name,
    placeName: c.venueName ?? c.name,
    category: { id: c.category, label: labelOf(c.category) },
    subtype: subtypeFrom(c.facts.subtype?.value),
    status: e.class,
    callToAction: e.cta ?? "check",
    location: { lat: c.point.lat, lon: c.point.lon },
    event: o ? { startsAt: o.start.toISOString(), endsAt: o.end?.toISOString() ?? null, entryCutoffAt: o.entryCutoff?.toISOString() ?? null, lateEntry: o.lateEntry } : null,
    timing: {
      travel: {
        mode: t.travel.mode,
        minutes: t.travel.minutes,
        isEstimate: t.travel.isEstimate,
        parkingMinutes: t.travel.mode === "drive" ? (ctx.parkingBufferMinutes ?? DEFAULT_PARKING_BUFFER_MINUTES) : null,
      },
      leaveAt: t.departAt.toISOString(),
      arriveAt: t.arrival.toISOString(),
      usefulMinutes: t.usefulMinutes,
      finishBy: t.latestFinish.toISOString(),
      closesAt: t.closesAt?.toISOString() ?? null,
      visit: { style: t.visit.style, label: VISIT_LABEL[t.visit.style] ?? "Visit", minMinutes: t.visit.minMinutes, typicalMinutes: t.visit.typicalMinutes, isEstimate: t.visit.isEstimate },
    },
    plan: planSteps(e, ctx).map((s) => ({ kind: s.kind, at: s.at.toISOString(), isEstimate: s.isEstimate, text: s.text })),
    price: priceOf(c.facts.price),
    ageLimit: ageLimitFrom(c.facts.age_limit),
    reasons: reasonNotes(e, ctx.timezone).map((n) => ({ ...n, required: false })),
    caveats: caveatNotes(e).map((n) => ({ ...n, required: true })),
    copy: { summary: copy.factLine, sentence: copy.sentence || null, caveat: copy.caveat, action: copy.cta ?? "Check first" },
    actions: {
      directionsUrl: directionsUrl(c.point, t.travel.mode),
      websiteUrl: websiteUrl(textFrom(c.facts.website?.value)),
      phone: textFrom(c.facts.phone?.value),
      links: linksFrom(c.facts.links?.value),
    },
  };
}

/** Distinct source ids behind the facts of these evaluations (for attribution). */
export function sourcesOf(evaluations: Evaluation[]): string[] {
  const out = new Set<string>();
  for (const e of evaluations) for (const f of Object.values(e.candidate.facts)) for (const s of f?.sources ?? []) out.add(s);
  return [...out];
}
