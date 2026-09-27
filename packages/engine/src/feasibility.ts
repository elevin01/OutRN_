import { addMinutes, estimateTravel, localClock, minutesBetween, PROGRAMME_CATEGORIES, type Attribute } from "@outrn/core";
import { evaluateHours, isHoursValue } from "@outrn/facts";
import type { Candidate, CategoryPolicy, Evaluation, ExclusionCode, ReasonCode, RequestContext, Timing } from "./types.js";

/**
 * Feasibility: can this person arrive, get in, and have enough useful time before the earlier
 * of closing and their own deadline? Published facts are hard; estimates never exclude on their
 * own — they downgrade to "check first".
 *
 *   arrival        = depart + travel + admission buffer
 *   latest_arrival = published admission cutoff (hard) | category default (estimate → check first)
 *   latest_finish  = min(effective close, deadline)
 *   useful         = latest_finish − arrival     must clear min useful duration
 */

const DEFAULT_MAX_TRAVEL: Record<RequestContext["mode"], number> = { walk: 25, drive: 30, transit: 35 };

export function deadlineOf(ctx: RequestContext): Date {
  if (ctx.endAt) return ctx.endAt;
  return addMinutes(ctx.now, ctx.windowMinutes ?? 180);
}

function fact<T = unknown>(c: Candidate, a: Attribute): { value: T; confidence: number; isEstimate: boolean } | null {
  const f = c.facts[a];
  if (!f) return null;
  return { value: f.value as T, confidence: f.confidence, isEstimate: f.evidenceClass === "estimate" };
}

export interface FeasibilityOutcome {
  class: Evaluation["class"];
  excludedBy: ExclusionCode | null;
  reasons: ReasonCode[];
  unresolved: ReasonCode[];
  timing: Timing | null;
  cta: Evaluation["cta"];
  price: Evaluation["price"];
  evidenceConfidence: number;
}

export function evaluateFeasibility(c: Candidate, ctx: RequestContext, policy: CategoryPolicy): FeasibilityOutcome {
  const reasons: ReasonCode[] = [];
  const unresolved: ReasonCode[] = [];
  const out = (excludedBy: ExclusionCode): FeasibilityOutcome => ({ class: "ineligible", excludedBy, reasons, unresolved, timing: null, cta: null, price: priceOf(c, ctx).price, evidenceConfidence: 0 });

  if (c.excluded) return out("EXCLUDED_BY_OVERRIDE");
  if (ctx.dismissedIds?.includes(c.id)) return out("DISMISSED");
  if (ctx.categories?.length && !ctx.categories.includes(c.category)) return out("NOT_REQUESTED");

  const status = fact<{ status: string }>(c, "business_status");
  if (status && status.value.status.startsWith("closed") && (!status.isEstimate || status.confidence >= 0.6)) return out("CLOSED_PERMANENTLY");

  // A cinema, theatre or music venue qualifies only through an occurrence in the window. The loader
  // emits the venue row itself only when no occurrence was loaded, so this reads "nothing on".
  if (c.kind === "venue" && PROGRAMME_CATEGORIES.has(c.category)) return out("NO_PROGRAMME");

  // Travel and arrival
  const hour = localClock(ctx.now, ctx.timezone).hour;
  const travel = estimateTravel(ctx.origin, c.point, ctx.mode, { hourLocal: hour });
  const maxTravel = ctx.maxTravelMinutes ?? DEFAULT_MAX_TRAVEL[ctx.mode];
  if (travel.minutes > maxTravel) return out("TOO_FAR");
  const departAt = ctx.now;
  let arrival = addMinutes(departAt, travel.minutes + policy.admissionBufferMinutes);

  // Deadline, with return travel when the user must be back.
  let deadline = deadlineOf(ctx);
  let returnTravel = null;
  if (ctx.backBy) {
    const backHour = localClock(ctx.backBy, ctx.timezone).hour;
    returnTravel = estimateTravel(c.point, ctx.origin, ctx.mode, { hourLocal: backHour });
    const mustLeaveBy = addMinutes(ctx.backBy, -(returnTravel.minutes + 5));
    if (mustLeaveBy < deadline) deadline = mustLeaveBy;
  }

  // Minimum useful duration: published for the venue, else category estimate.
  const minPub = fact<{ minutes: number }>(c, "min_useful_minutes");
  const minUsefulMinutes = minPub && !minPub.isEstimate ? minPub.value.minutes : policy.minUsefulMinutes;
  const minUsefulIsEstimate = !(minPub && !minPub.isEstimate);

  let closesAt: Date | null = null;
  let latestArrival: Date | null = null;
  let latestArrivalIsEstimate = false;
  let latestFinish = deadline;
  let hoursConfidence = 0;

  if (c.kind === "occurrence" && c.occurrence) {
    const o = c.occurrence;
    if (o.status === "cancelled") return out("EVENT_CANCELLED");
    if (o.status === "sold_out") return out("EVENT_SOLD_OUT");
    if (o.status === "ended" || (o.end && o.end <= ctx.now)) return out("EVENT_STARTED");
    const cutoff = o.entryCutoff ?? o.start;
    latestArrival = cutoff;
    if (arrival > cutoff) {
      // Joining late qualifies only if the source says late entry is allowed.
      if (o.lateEntry !== true) return out("EVENT_STARTED");
      unresolved.push("LATE_ENTRY_UNCERTAIN");
    }
    const end = o.end ?? addMinutes(o.start, 120);
    if (!o.end) unresolved.push("HOURS_APPROXIMATE");
    if (end > addMinutes(deadline, 15)) return out("EVENT_ENDS_AFTER_DEADLINE");
    // Arriving early is waiting, not useful time: useful time starts at the event.
    const effectiveStart = arrival < o.start ? o.start : arrival;
    latestFinish = end < deadline ? end : deadline;
    const useful = minutesBetween(effectiveStart, latestFinish);
    const need = policy.minUsefulMinutes > 0 ? policy.minUsefulMinutes : Math.min(45, Math.max(20, minutesBetween(o.start, end) * 0.5));
    if (useful < need) return out("NOT_ENOUGH_TIME");
    if (minutesBetween(ctx.now, o.start) <= 90 && o.start > ctx.now) reasons.push("EVENT_STARTS_SOON");
    hoursConfidence = 0.8; // dated occurrence from a source, status current
    closesAt = end;
    const timing: Timing = { travel, departAt, arrival, latestArrival, latestArrivalIsEstimate: false, latestFinish, usefulMinutes: useful, minUsefulMinutes: need, minUsefulIsEstimate: true, closesAt, deadline, returnTravel };
    return finish(c, ctx, reasons, unresolved, timing, hoursConfidence);
  }

  // Flexible visit: hours
  const hoursFact = fact(c, "opening_hours");
  if (!hoursFact || !isHoursValue(hoursFact.value)) {
    unresolved.push("HOURS_UNKNOWN");
    // No closing constraint known: useful time is bounded by the deadline only.
    const useful = minutesBetween(arrival, deadline);
    if (useful < minUsefulMinutes) return out("NOT_ENOUGH_TIME");
    const timing: Timing = { travel, departAt, arrival, latestArrival: null, latestArrivalIsEstimate: false, latestFinish: deadline, usefulMinutes: useful, minUsefulMinutes, minUsefulIsEstimate, closesAt: null, deadline, returnTravel };
    return finish(c, ctx, reasons, unresolved, timing, 0);
  }
  hoursConfidence = hoursFact.confidence;
  const ev = evaluateHours(hoursFact.value, arrival, c.timezone, c.point);
  if (ev.parseError) {
    unresolved.push("HOURS_UNKNOWN");
    const useful = minutesBetween(arrival, deadline);
    if (useful < minUsefulMinutes) return out("NOT_ENOUGH_TIME");
    return finish(c, ctx, reasons, unresolved, { travel, departAt, arrival, latestArrival: null, latestArrivalIsEstimate: false, latestFinish: deadline, usefulMinutes: useful, minUsefulMinutes, minUsefulIsEstimate, closesAt: null, deadline, returnTravel }, 0);
  }
  if (ev.approximate) unresolved.push("HOURS_APPROXIMATE");
  if (!ev.always) {
    if (!ev.interval) return out("CLOSED_ON_ARRIVAL");
    if (!ev.openNow) {
      // Closed at arrival: waiting for the next opening is fine if it still fits the window.
      if (ev.interval.open > arrival) {
        if (minutesBetween(ev.interval.open, deadline) < minUsefulMinutes) return out("CLOSED_ON_ARRIVAL");
        arrival = ev.interval.open;
        reasons.push("WAIT_FOR_OPENING");
      } else return out("CLOSED_ON_ARRIVAL");
    }
    closesAt = ev.interval.close;
    let effectiveClose = closesAt;
    if (policy.kitchenCloseOffsetMinutes && c.category === "restaurant") effectiveClose = addMinutes(closesAt, -policy.kitchenCloseOffsetMinutes);
    // Last entry limits ARRIVAL, not the end of the visit.
    const lastEntryPub = fact<{ minutes: number }>(c, "last_entry_offset");
    if (lastEntryPub && !lastEntryPub.isEstimate) {
      latestArrival = addMinutes(closesAt, -lastEntryPub.value.minutes);
      if (arrival > latestArrival) return out("LAST_ENTRY_PASSED");
    } else if (policy.lastEntryDefaultMinutes) {
      latestArrival = addMinutes(closesAt, -policy.lastEntryDefaultMinutes);
      latestArrivalIsEstimate = true;
      if (arrival > latestArrival) unresolved.push("LATE_ENTRY_UNCERTAIN");
    }
    latestFinish = effectiveClose < deadline ? effectiveClose : deadline;
  }
  const useful = minutesBetween(arrival, latestFinish);
  if (useful < minUsefulMinutes) return out("NOT_ENOUGH_TIME");
  if (closesAt && minutesBetween(arrival, latestFinish) < minUsefulMinutes + 20 && latestFinish < deadline) reasons.push("CLOSES_SOON");
  if (closesAt && closesAt >= addMinutes(deadline, 60)) reasons.push("OPEN_LATE");
  const timing: Timing = { travel, departAt, arrival, latestArrival, latestArrivalIsEstimate, latestFinish, usefulMinutes: useful, minUsefulMinutes, minUsefulIsEstimate, closesAt, deadline, returnTravel };
  return finish(c, ctx, reasons, unresolved, timing, hoursConfidence);
}

function priceOf(c: Candidate, ctx: RequestContext): { price: Evaluation["price"]; ok: "yes" | "no" | "unknown"; free: boolean } {
  const p = fact<{ min?: number; max?: number; free?: boolean; unknown?: boolean; currency: string }>(c, "price");
  if (!p) return { price: { text: "price unknown", isEstimate: false, unknown: true }, ok: ctx.budget === undefined ? "yes" : "unknown", free: false };
  const v = p.value;
  if (v.free) return { price: { text: "free", isEstimate: p.isEstimate, unknown: false }, ok: "yes", free: true };
  if (v.unknown || (v.min === undefined && v.max === undefined)) return { price: { text: "paid, amount unknown", isEstimate: p.isEstimate, unknown: true }, ok: ctx.budget === undefined ? "yes" : "unknown", free: false };
  const min = v.min ?? v.max!;
  const max = v.max ?? v.min!;
  const text = min === max ? `$${min}` : `$${min}–${max}`;
  if (ctx.budget === "free") return { price: { text, isEstimate: p.isEstimate, unknown: false }, ok: "no", free: false };
  if (typeof ctx.budget === "number") return { price: { text, isEstimate: p.isEstimate, unknown: false }, ok: min <= ctx.budget ? "yes" : "no", free: false };
  return { price: { text, isEstimate: p.isEstimate, unknown: false }, ok: "yes", free: false };
}

function finish(c: Candidate, ctx: RequestContext, reasons: ReasonCode[], unresolved: ReasonCode[], timing: Timing, hoursConfidence: number): FeasibilityOutcome {
  const bail = (excludedBy: ExclusionCode): FeasibilityOutcome => ({ class: "ineligible", excludedBy, reasons, unresolved, timing, cta: null, price: priceOf(c, ctx).price, evidenceConfidence: 0 });

  // Budget
  const pr = priceOf(c, ctx);
  if (pr.ok === "no") return bail(ctx.budget === "free" ? "NOT_FREE" : "OVER_BUDGET");
  if (pr.ok === "unknown") {
    if (ctx.budget === "free") return bail("NOT_FREE"); // strict: unknown cannot satisfy "free"
    unresolved.push("PRICE_UNKNOWN");
  } else if (pr.free) reasons.push("FREE");
  else if (typeof ctx.budget === "number") reasons.push("FITS_BUDGET");

  // Accessibility: unknown must not pass a required filter.
  if (ctx.requireWheelchair) {
    const w = fact<{ value: string }>(c, "wheelchair");
    if (!w) return bail("ACCESS_UNKNOWN");
    if (w.value.value === "no") return bail("NOT_ACCESSIBLE");
    if (w.value.value === "limited") unresolved.push("ACCESS_LIMITED");
    if (w.value.value === "unknown") return bail("ACCESS_UNKNOWN");
  }

  // Admission
  const adm = fact<{ requirement: string }>(c, "admission");
  const admStatus = fact<{ status: string }>(c, "admission_status");
  let cta: Evaluation["cta"] = "go";
  const req = adm?.value.requirement ?? "unknown";
  if (req === "ticket" || req === "reservation") {
    cta = "book";
    if (admStatus?.value.status !== "confirmed") unresolved.push("ADMISSION_UNCONFIRMED");
  } else if (req === "tour_only") {
    cta = "check";
    unresolved.push("TOUR_ONLY");
  } else if (req === "unknown" || !adm) {
    cta = "check";
    unresolved.push("ADMISSION_UNKNOWN");
  }

  // Evidence on hours
  if (timing.closesAt && hoursConfidence < 0.4) unresolved.push("HOURS_UNVERIFIED");
  const fresh = c.facts["open_state"] ?? c.facts["queue"] ?? c.facts["crowd_level"];
  if (fresh && fresh.evidenceClass === "observation" && (!fresh.validUntil || fresh.validUntil > ctx.now)) reasons.push("FRESH_REPORT");

  // Positive timing reasons
  const shortTravel = ctx.mode === "walk" ? timing.travel.minutes <= 10 : timing.travel.minutes <= 15;
  if (shortTravel) reasons.push("SHORT_TRAVEL");
  if (timing.usefulMinutes >= timing.minUsefulMinutes * 1.5) reasons.push("ENOUGH_TIME");

  const admConf = adm ? adm.confidence : 0;
  const statusConf = c.facts["business_status"]?.confidence ?? 0;
  const evidenceConfidence = 0.5 * hoursConfidence + 0.3 * statusConf + 0.2 * admConf;

  const cls: Evaluation["class"] = unresolved.length ? "check_first" : "ready";
  if (cls === "check_first" && cta === "go") cta = "check";
  return { class: cls, excludedBy: null, reasons, unresolved, timing, cta, price: pr.price, evidenceConfidence };
}
