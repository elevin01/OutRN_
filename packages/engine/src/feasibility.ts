import { dayPart } from "./daypart.js";
import { addMinutes, CUISINE_CATEGORIES, cuisineMatches, servesDiet, DEFAULT_MAX_TRAVEL_MINUTES, DEFAULT_PARKING_BUFFER_MINUTES, estimateTravel, localClock, minutesBetween, ownValue, PROGRAMME_CATEGORIES, websiteUrl, type Attribute, type Category } from "@outrn/core";
import { evaluateHours, isHoursValue } from "@outrn/facts";
import type { Candidate, CategoryPolicy, Evaluation, ExclusionCode, NearbyParking, ReasonCode, RequestContext, Timing, TimingBase } from "./types.js";
import { conditionsFor, waitMayNotFit } from "./conditions.js";
import { cuisinesOf } from "./cuisine.js";
import { dietLevelsOf, dietsFromNameOnly, hasFeature } from "./offers.js";
import { parkingMinutesFor, parkingOpenFor } from "./parking.js";
import { FOOD_CATEGORIES, isTakeout, TAKEOUT_MINUTES, takeoutOf, visitFor } from "./visit.js";

/**
 * Feasibility: can this person arrive, get in, and have enough useful time before the earlier
 * of closing and their own deadline? Published facts are hard; estimates never exclude on their
 * own — they downgrade to "check first".
 *
 *   arrival        = depart + travel + admission buffer
 *   latest_arrival = published admission cutoff (hard) | category default (estimate → check first)
 *                    | a restaurant's published last orders (kitchen close − time to order, hard)
 *   latest_finish  = min(effective close, deadline)
 *   useful         = latest_finish − arrival     must clear min useful duration
 */

/** Minutes a table needs to get its order in before the kitchen closes. */
export const ORDER_MINUTES = 15;

/**
 * Youngest person in the party: a number when known, "minor" when company is family and no age was
 * given (a child of unknown age), undefined when there is no reason to assume a minor.
 */
export function partyYoungest(ctx: RequestContext): number | "minor" | undefined {
  if (typeof ctx.youngestAge === "number") return ctx.youngestAge;
  return ctx.company === "family" ? "minor" : undefined;
}

/** Whether anyone under 18 is going: a family of unknown ages, or a youngest age under 18, whatever the company. */
export function minorInParty(ctx: RequestContext): boolean {
  const youngest = partyYoungest(ctx);
  return youngest === "minor" || (typeof youngest === "number" && youngest < 18);
}

/**
 * How long a cinema, theatre or music venue with nothing listed needs, when all we know is its own
 * site lists what's on: a feature and its trailers, a play, a set. Their category policies have no
 * minimum (a listed occurrence brings its own duration), and a bare venue must not borrow that zero.
 */
export const UNLISTED_PROGRAMME_MINUTES: Readonly<Partial<Record<Category, number>>> = { cinema: 120, theatre: 120, live_music: 90 };

/** A venue's minimum admission age, if any fact states or estimates one (0 = no limit). */
export function ageLimitOf(c: Candidate): { minAge: number; isEstimate: boolean } | null {
  const f = c.facts.age_limit;
  const minAge = (f?.value as { minAge?: unknown } | undefined)?.minAge;
  return f && typeof minAge === "number" ? { minAge, isEstimate: f.evidenceClass === "estimate" } : null;
}

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

/**
 * A restaurant's published kitchen hours at `at`: when food is served and the last moment to order.
 * "closed" when the kitchen is shut then and does not reopen; null when no published, parseable
 * kitchen schedule applies (the category's kitchen offset stands in).
 */
export function kitchenAt(c: Candidate, at: Date): { opensAt: Date | null; lastOrder: Date } | "closed" | null {
  if (c.category !== "restaurant") return null;
  const k = fact(c, "kitchen_hours");
  if (!k || k.isEstimate || !isHoursValue(k.value)) return null;
  const ev = evaluateHours(k.value, at, c.timezone, c.point);
  if (ev.parseError || ev.always) return null;
  if (!ev.interval || (!ev.openNow && ev.interval.open <= at)) return "closed";
  const lastOrder = addMinutes(ev.interval.close, -ORDER_MINUTES);
  const opensAt = ev.openNow ? null : ev.interval.open;
  if (lastOrder <= (opensAt ?? at)) return "closed";
  return { opensAt, lastOrder };
}

/** Exclusions a visit at another time or of another length could avoid. */
const TIME_EXCLUSIONS: ReadonlySet<ExclusionCode> = new Set(["NOT_ENOUGH_TIME", "CLOSED_ON_ARRIVAL", "KITCHEN_CLOSED", "EVENT_ENDS_AFTER_DEADLINE"]);

export function evaluateFeasibility(c: Candidate, ctx: RequestContext, policy: CategoryPolicy): FeasibilityOutcome {
  const r = evaluateWithParking(c, ctx, policy);
  // When a scheduled closure is what leaves no worthwhile visit, the place is closing for good, not
  // short of time: more time would not admit it. Decided exactly, by the same visit without it.
  if (r.excludedBy && TIME_EXCLUSIONS.has(r.excludedBy) && c.facts.scheduled_closure) {
    const { scheduled_closure: _closure, ...facts } = c.facts;
    if (evaluateWithParking({ ...c, facts }, ctx, policy).class !== "ineligible") return { ...r, excludedBy: "CLOSED_PERMANENTLY" };
  }
  return r;
}

/**
 * A drive parks at the nearest public parking that works for the visit and is open from parking
 * until the car is collected. With none, the plan names no lot and allows the area's usual time to
 * find a space.
 */
function evaluateWithParking(c: Candidate, ctx: RequestContext, policy: CategoryPolicy): FeasibilityOutcome {
  for (const lot of ctx.mode === "drive" ? (c.parkingOptions ?? []) : []) {
    const r = evaluateVisit(c, ctx, policy, lot);
    if (r.class !== "ineligible" && r.timing && parkingOpenFor(lot, r.timing, c.timezone)) return r;
  }
  return evaluateVisit(c, ctx, policy, null);
}

function evaluateVisit(c: Candidate, ctx: RequestContext, policy: CategoryPolicy, lot: NearbyParking | null): FeasibilityOutcome {
  const reasons: ReasonCode[] = [];
  const unresolved: ReasonCode[] = [];
  const out = (excludedBy: ExclusionCode): FeasibilityOutcome => ({ class: "ineligible", excludedBy, reasons, unresolved, timing: null, cta: null, price: priceOf(c, ctx).price, evidenceConfidence: 0 });

  if (c.excluded) return out("EXCLUDED_BY_OVERRIDE");
  if (ctx.dismissedIds?.includes(c.id)) return out("DISMISSED");
  if (ctx.categories?.length && !ctx.categories.includes(c.category)) return out("NOT_REQUESTED");
  if (ctx.cuisines?.length) {
    // A cuisine search is a search for food: nothing else was asked for, and a place whose cuisine
    // isn't known is not known to serve it.
    if (c.kind === "occurrence" || !CUISINE_CATEGORIES.has(c.category)) return out("NOT_REQUESTED");
    if (!cuisineMatches(ctx.cuisines, cuisinesOf(c))) return out("OTHER_CUISINE");
  }
  if (ctx.diets?.length) {
    // A diet is a need, so a search for one is a search for food known to serve it: all of the
    // diets asked for, since one party eats together. Unknown is not a yes.
    if (c.kind === "occurrence" || !CUISINE_CATEGORIES.has(c.category)) return out("NOT_REQUESTED");
    const levels = dietLevelsOf(c);
    if (!ctx.diets.every((d) => servesDiet(levels, d))) return out("DIET_NOT_KNOWN");
    // A diet is a need (celiac, kosher, halal), and a name is not a record ("kosher-style" delis are
    // not kosher): a place known only by its name is Check first, with the reason named.
    if (dietsFromNameOnly(c)) unresolved.push("DIET_FROM_NAME");
  }
  // Must-haves the place's record has to state: tables outside, wifi.
  if (ctx.features?.length && !ctx.features.every((f) => hasFeature(c, f))) return out("FEATURE_NOT_KNOWN");

  const status = fact<{ status: string }>(c, "business_status");
  if (status && status.value.status.startsWith("closed") && (!status.isEstimate || status.confidence >= 0.6)) return out(status.value.status === "closed_temporarily" ? "CLOSED_TEMPORARILY" : "CLOSED_PERMANENTLY");
  // A closing date published ahead is in force from its instant, even before an ingest records the
  // closed status, and it is a hard end to any visit before it (see the deadline below). A status
  // that merely lapsed is uncertainty, not a closure: it excludes nothing.
  const closureFact = fact<{ at: string }>(c, "scheduled_closure");
  const closureAt = closureFact && !closureFact.isEstimate ? new Date(closureFact.value.at) : null;
  if (closureAt && closureAt.getTime() <= ctx.now.getTime()) return out("CLOSED_PERMANENTLY");
  // Not open to the public (a private club, a university's own library): not a place anyone can go.
  if (fact<{ requirement: string }>(c, "admission")?.value.requirement === "members_only") return out("MEMBERS_ONLY");

  // Age limits are admission rules, not preferences. A published limit the party cannot meet excludes;
  // an estimated one (a casino assumed 21+) only downgrades to Check first, with the limit named.
  const limit = ageLimitOf(c);
  const youngest = partyYoungest(ctx);
  if (limit && limit.minAge > 0 && youngest !== undefined) {
    const tooYoung = youngest === "minor" ? limit.minAge >= 18 : youngest < limit.minAge;
    if (tooYoung) {
      if (!limit.isEstimate) return out("AGE_RESTRICTED");
      unresolved.push("AGE_LIMIT_LIKELY");
    } else if (youngest === "minor") {
      unresolved.push("AGE_LIMIT_UNCERTAIN"); // e.g. 16+ with children whose ages we do not know
    }
  } else if (!limit && minorInParty(ctx) && (c.category === "bar" || c.category === "nightclub")) {
    // A bar that serves food has no age limit we know of, but children may not be welcome, least of all late.
    unresolved.push("KIDS_UNCERTAIN");
  }

  // How the food is had: a place that does not do takeout cannot serve a takeout request, and a
  // takeout-only counter has no seats for a sit-down meal (both published; offered as relaxations).
  const takeout = takeoutOf(c);
  if (ctx.visitStyle === "takeout" && FOOD_CATEGORIES.has(c.category) && takeout === "no") return out("NO_TAKEOUT");
  if (ctx.visitStyle !== "takeout" && c.category === "restaurant" && takeout === "only") return out("TAKEOUT_ONLY");

  // A cinema, theatre or music venue qualifies through an occurrence in the window. The loader emits
  // the venue row itself only when none was loaded, so this reads "nothing listed here". Its own site
  // still lists what's on: arriving at its time of day (an evening, not a morning; judged in finish,
  // at the arrival) it's worth a look, Check first. Only a site a user can open counts (the same rule
  // the API applies before it shows the link). Not with anyone under 18: with nothing listed there is
  // no show to judge, and many of these rooms are 21+ without a min_age tag (a burlesque theatre, a
  // music hall with a bar). A listed occurrence brings its own age facts.
  const unlistedProgramme = c.kind === "venue" && PROGRAMME_CATEGORIES.has(c.category);
  if (unlistedProgramme) {
    const site = (c.facts.website?.value as { value?: unknown } | undefined)?.value;
    if (typeof site !== "string" || !websiteUrl(site) || minorInParty(ctx)) return out("NO_PROGRAMME");
    unresolved.push("PROGRAMME_UNLISTED");
  }

  // Travel and arrival
  const hour = localClock(ctx.now, ctx.timezone).hour;
  // A drive that parks in a known lot counts the walk from it.
  const parkingMinutes = ctx.mode === "drive" ? parkingMinutesFor(lot, ctx.parkingBufferMinutes ?? DEFAULT_PARKING_BUFFER_MINUTES) : null;
  const parking = parkingMinutes === null ? {} : { parkingBufferMinutes: parkingMinutes };
  const travel = estimateTravel(ctx.origin, c.point, ctx.mode, { hourLocal: hour, ...parking });
  const maxTravel = ctx.maxTravelMinutes ?? DEFAULT_MAX_TRAVEL_MINUTES[ctx.mode];
  if (travel.minutes > maxTravel) return out("TOO_FAR");
  const departAt = ctx.now;
  let arrival = addMinutes(departAt, travel.minutes + policy.admissionBufferMinutes);
  // Waiting outside for an opening (the venue's or its kitchen's) is not a plan: when the visit starts
  // later than the trip would arrive, leave later so the trip arrives then. The time before is the user's.
  const naturalArrival = arrival;
  const leaveFor = (arrivalAt: Date): Date => (arrivalAt > naturalArrival ? addMinutes(arrivalAt, -(travel.minutes + policy.admissionBufferMinutes)) : departAt);

  // Deadline, with return travel when the user must be back.
  let deadline = deadlineOf(ctx);
  let returnTravel = null;
  if (ctx.backBy) {
    const backHour = localClock(ctx.backBy, ctx.timezone).hour;
    returnTravel = estimateTravel(c.point, ctx.origin, ctx.mode, { hourLocal: backHour, ...parking });
    const mustLeaveBy = addMinutes(ctx.backBy, -(returnTravel.minutes + 5));
    if (mustLeaveBy < deadline) deadline = mustLeaveBy;
  }
  // Nothing counts after a scheduled closure: it bounds every visit like the user's own deadline
  // (arrivals, waits, useful time, events). Timing still reports the user's deadline.
  const userDeadline = deadline;
  if (closureAt && closureAt < deadline) deadline = closureAt;
  const closureBinds = closureAt !== null && deadline === closureAt;

  // Minimum useful duration: published for the venue, else category estimate.
  // Food to go needs only the time to order and collect it.
  const minPub = fact<{ minutes: number }>(c, "min_useful_minutes");
  const takingOut = isTakeout(c, ctx);
  const categoryMinutes = unlistedProgramme ? Math.max(policy.minUsefulMinutes, ownValue(UNLISTED_PROGRAMME_MINUTES, c.category) ?? 0) : policy.minUsefulMinutes;
  const minUsefulMinutes = takingOut ? TAKEOUT_MINUTES : minPub && !minPub.isEstimate ? minPub.value.minutes : categoryMinutes;
  const minUsefulIsEstimate = takingOut || !(minPub && !minPub.isEstimate);

  let closesAt: Date | null = null;
  let latestArrival: Date | null = null;
  let latestArrivalIsEstimate = false;
  let latestArrivalKind: TimingBase["latestArrivalKind"] = null;
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
    // A small overrun of the user's own deadline is tolerated; none past a permanent closure.
    if (end > addMinutes(userDeadline, 15) || (closureAt && end > closureAt)) return out("EVENT_ENDS_AFTER_DEADLINE");
    // Arriving early is waiting, not useful time: useful time starts at the event.
    const effectiveStart = arrival < o.start ? o.start : arrival;
    latestFinish = end < deadline ? end : deadline;
    const useful = minutesBetween(effectiveStart, latestFinish);
    const need = policy.minUsefulMinutes > 0 ? policy.minUsefulMinutes : Math.min(45, Math.max(20, minutesBetween(o.start, end) * 0.5));
    if (useful < need) return out("NOT_ENOUGH_TIME");
    if (minutesBetween(ctx.now, o.start) <= 90 && o.start > ctx.now) reasons.push("EVENT_STARTS_SOON");
    hoursConfidence = 0.8; // dated occurrence from a source, status current
    closesAt = end;
    const timing: TimingBase = { travel, departAt, arrival, latestArrival, latestArrivalIsEstimate: false, latestArrivalKind: o.entryCutoff ? "event_entry" : null, latestFinish, usefulMinutes: useful, minUsefulMinutes: need, minUsefulIsEstimate: true, closesAt, deadline: userDeadline, returnTravel, parkingMinutes, parking: lot };
    return finish(c, ctx, reasons, unresolved, timing, hoursConfidence);
  }

  // Flexible visit: hours
  // Published kitchen hours decide when a meal can start: wait for the kitchen, order before it closes.
  const kitchenGate = (): { latestArrival: Date | null } | ExclusionCode => {
    const k = kitchenAt(c, arrival);
    if (k === null) return { latestArrival: null };
    if (k === "closed") return "KITCHEN_CLOSED";
    if (k.opensAt && k.opensAt > arrival) {
      if (minutesBetween(k.opensAt, deadline) < minUsefulMinutes) return "KITCHEN_CLOSED";
      arrival = k.opensAt;
      reasons.push("WAIT_FOR_OPENING");
    }
    return arrival > k.lastOrder ? "KITCHEN_CLOSED" : { latestArrival: k.lastOrder };
  };

  const hoursFact = fact(c, "opening_hours");
  if (!hoursFact || !isHoursValue(hoursFact.value)) {
    unresolved.push("HOURS_UNKNOWN");
    const kitchen = kitchenGate();
    if (typeof kitchen === "string") return out(kitchen);
    // No closing constraint known: useful time is bounded by the deadline only.
    const useful = minutesBetween(arrival, deadline);
    if (useful < minUsefulMinutes) return out("NOT_ENOUGH_TIME");
    const timing: TimingBase = { travel, departAt: leaveFor(arrival), arrival, latestArrival: kitchen.latestArrival, latestArrivalIsEstimate: false, latestArrivalKind: kitchen.latestArrival ? "last_order" : null, latestFinish: deadline, usefulMinutes: useful, minUsefulMinutes, minUsefulIsEstimate, closesAt: null, deadline: userDeadline, returnTravel, parkingMinutes, parking: lot };
    return finish(c, ctx, reasons, unresolved, timing, 0);
  }
  hoursConfidence = hoursFact.confidence;
  const ev = evaluateHours(hoursFact.value, arrival, c.timezone, c.point);
  if (ev.parseError) {
    unresolved.push("HOURS_UNKNOWN");
    const kitchen = kitchenGate();
    if (typeof kitchen === "string") return out(kitchen);
    const useful = minutesBetween(arrival, deadline);
    if (useful < minUsefulMinutes) return out("NOT_ENOUGH_TIME");
    return finish(c, ctx, reasons, unresolved, { travel, departAt: leaveFor(arrival), arrival, latestArrival: kitchen.latestArrival, latestArrivalIsEstimate: false, latestArrivalKind: kitchen.latestArrival ? "last_order" : null, latestFinish: deadline, usefulMinutes: useful, minUsefulMinutes, minUsefulIsEstimate, closesAt: null, deadline: userDeadline, returnTravel, parkingMinutes, parking: lot }, 0);
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
  }
  // Published kitchen hours decide when a meal can start, whether or not the venue ever closes.
  const kitchen = kitchenGate();
  if (typeof kitchen === "string") return out(kitchen);
  latestArrival = kitchen.latestArrival;
  if (latestArrival) latestArrivalKind = "last_order";
  if (closesAt) {
    let effectiveClose = closesAt;
    // Without them, the category's guess at when the kitchen stops stands in.
    if (!kitchen.latestArrival && policy.kitchenCloseOffsetMinutes && c.category === "restaurant") effectiveClose = addMinutes(closesAt, -policy.kitchenCloseOffsetMinutes);
    // Last entry limits ARRIVAL, not the end of the visit.
    const lastEntryPub = fact<{ minutes: number }>(c, "last_entry_offset");
    if (lastEntryPub && !lastEntryPub.isEstimate) {
      const lastEntry = addMinutes(closesAt, -lastEntryPub.value.minutes);
      if (!latestArrival || lastEntry < latestArrival) {
        latestArrival = lastEntry;
        latestArrivalKind = "last_entry";
      }
      if (arrival > lastEntry) return out("LAST_ENTRY_PASSED");
    } else if (policy.lastEntryDefaultMinutes && !latestArrival) {
      latestArrival = addMinutes(closesAt, -policy.lastEntryDefaultMinutes);
      latestArrivalKind = "last_entry";
      latestArrivalIsEstimate = true;
      if (arrival > latestArrival) unresolved.push("LATE_ENTRY_UNCERTAIN");
    }
    latestFinish = effectiveClose < deadline ? effectiveClose : deadline;
  }
  const useful = minutesBetween(arrival, latestFinish);
  if (useful < minUsefulMinutes) return out("NOT_ENOUGH_TIME");
  // A binding closure is this visit's closing time, shown and reasoned about like one.
  if (closureBinds && (!closesAt || closureAt! < closesAt)) closesAt = closureAt;
  if (closesAt && minutesBetween(arrival, latestFinish) < minUsefulMinutes + 20 && latestFinish < userDeadline) reasons.push("CLOSES_SOON");
  if (closesAt && closesAt >= addMinutes(userDeadline, 60)) reasons.push("OPEN_LATE");
  const timing: TimingBase = { travel, departAt: leaveFor(arrival), arrival, latestArrival, latestArrivalIsEstimate, latestArrivalKind, latestFinish, usefulMinutes: useful, minUsefulMinutes, minUsefulIsEstimate, closesAt, deadline: userDeadline, returnTravel, parkingMinutes, parking: lot };
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
  const usd = (n: number) => (Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`);
  const text = min === max ? usd(min) : `${usd(min)}–${usd(max)}`;
  if (ctx.budget === "free") return { price: { text, isEstimate: p.isEstimate, unknown: false }, ok: "no", free: false };
  if (typeof ctx.budget === "number") return { price: { text, isEstimate: p.isEstimate, unknown: false }, ok: min <= ctx.budget ? "yes" : "no", free: false };
  return { price: { text, isEstimate: p.isEstimate, unknown: false }, ok: "yes", free: false };
}

function finish(c: Candidate, ctx: RequestContext, reasons: ReasonCode[], unresolved: ReasonCode[], base: TimingBase, hoursConfidence: number): FeasibilityOutcome {
  const visit = visitFor(c, ctx, base);
  const timing: Timing = { ...base, visit, conditions: conditionsFor(c, ctx, base, visit) };
  const bail = (excludedBy: ExclusionCode): FeasibilityOutcome => ({ class: "ineligible", excludedBy, reasons, unresolved, timing, cta: null, price: priceOf(c, ctx).price, evidenceConfidence: 0 });
  // A programme venue with nothing listed is worth a look only arriving in its prime time: the same
  // instant the score reads the time of day at.
  if (c.kind === "venue" && PROGRAMME_CATEGORIES.has(c.category) && dayPart(c.category, base.arrival, c.timezone) !== "prime") return bail("NO_PROGRAMME");

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
  // An expected wait is an estimate: when it could eat the visit or run past last orders, check first.
  if (waitMayNotFit(timing, timing.conditions)) unresolved.push("WAIT_MAY_NOT_FIT");
  // Rain likely outdoors: a forecast, so it never excludes a place, but look at the sky before going.
  if (timing.conditions.some((x) => x.kind === "weather" && x.level === "rain")) unresolved.push("RAIN_LIKELY");
  // A report is a reason only while it still holds at the arrival, the rule the conditions use: a
  // crowd or queue report that became a condition, or an open/closed report valid past the arrival.
  const open = c.facts.open_state;
  const openHolds = open !== undefined && open.evidenceClass === "observation" && open.validUntil !== null && open.validUntil > timing.arrival;
  if (openHolds || timing.conditions.some((x) => x.basis === "report")) reasons.push("FRESH_REPORT");

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
