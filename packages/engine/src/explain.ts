import { addMinutes, INTERESTS } from "@outrn/core";
import { waitCeilingMinutes } from "./conditions.js";
import { kidFacilityLevels } from "./amenities.js";
import { leadCuisine } from "./cuisine.js";
import { ageLimitOf } from "./feasibility.js";
import { happyHourAt } from "./offers.js";
import { parkStepText } from "./parking.js";
import { fmtDuration, fmtTime } from "./format.js";
import type { Evaluation, ReasonCode, RequestContext } from "./types.js";

/**
 * Explanations are rendered from reason codes and timing facts, never free text. A sentence
 * appears only when its inputs are valid. Estimates keep their tilde.
 */

export { fmtDuration, fmtTime } from "./format.js";

const UNRESOLVED_TEXT: Partial<Record<ReasonCode, string>> = {
  HOURS_UNKNOWN: "hours not listed",
  HOURS_UNVERIFIED: "hours not checked recently",
  HOURS_APPROXIMATE: "hours are approximate",
  ADMISSION_UNCONFIRMED: "admission not confirmed",
  ADMISSION_UNKNOWN: "walk-in status unknown",
  TOUR_ONLY: "by guided tour only",
  PRICE_UNKNOWN: "price unknown",
  LATE_ENTRY_UNCERTAIN: "may be past last entry",
  ACCESS_LIMITED: "limited accessibility",
  WAIT_MAY_NOT_FIT: "a wait could leave too little time",
  KIDS_UNCERTAIN: "a bar: check children are welcome",
  PROGRAMME_UNLISTED: "check what's on",
  RAIN_LIKELY: "rain likely",
  DIET_FROM_NAME: "only its name says it serves this diet: check with them",
  RESTROOM_NOT_ACCESSIBLE: "its restroom isn't wheelchair accessible",
  RESTROOM_ACCESS_LIMITED: "its restroom has limited wheelchair access",
};

/** One reason or caveat as data: a stable code, its inputs, and default wording. */
export interface Note {
  code: ReasonCode;
  /** Default wording, lower case so it can sit inside a sentence. */
  text: string;
  params: Record<string, string | number | boolean | null>;
}

export interface CardCopy {
  /** e.g. "~12 min walk · takes about 1h20 · until 10pm · $15–35" */
  factLine: string;
  /** e.g. "Short walk, plenty of time, free." */
  sentence: string;
  /** e.g. "Check first: hours not checked recently" */
  caveat: string | null;
  cta: "Go now" | "Check first" | "Book" | null;
}

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

/** Why this option is good, in the order the card sentence reads them. Only reasons the sentence would use. */
export function reasonNotes(e: Evaluation, tz: string): Note[] {
  const t = e.timing;
  if (!t) return [];
  const out: Note[] = [];
  const has = (code: ReasonCode) => e.reasons.includes(code);
  const add = (code: ReasonCode, text: string, params: Note["params"] = {}) => out.push({ code, text, params });
  // What this person likes comes first: it is why this option is on their list.
  if (has("TASTE_MATCH") && e.tasteLead) add("TASTE_MATCH", `matches your taste for ${INTERESTS[e.tasteLead].toLowerCase()}`, { interest: e.tasteLead });
  if (has("EVENT_STARTS_SOON")) add("EVENT_STARTS_SOON", "starts soon", { startsAt: iso(e.candidate.occurrence?.start) });
  if (has("SHORT_TRAVEL")) add("SHORT_TRAVEL", t.travel.mode === "walk" ? "a short walk" : t.travel.mode === "drive" ? "a short drive" : "a short trip", { mode: t.travel.mode, minutes: t.travel.minutes });
  const happy = has("HAPPY_HOUR") ? happyHourAt(e.candidate, t.arrival, t.latestFinish) : null;
  if (happy) add("HAPPY_HOUR", happy.from ? `happy hour from ${fmtTime(happy.from, tz)}` : `happy hour until ${fmtTime(happy.until, tz)}`, { from: iso(happy.from), until: iso(happy.until) });
  if (has("WAIT_FOR_OPENING")) add("WAIT_FOR_OPENING", `opens at ${fmtTime(t.arrival, tz)}`, { opensAt: iso(t.arrival) });
  if (has("ENOUGH_TIME")) add("ENOUGH_TIME", "plenty of time", { usefulMinutes: t.usefulMinutes });
  else if (has("CLOSES_SOON")) add("CLOSES_SOON", "closes soon", { closesAt: iso(t.closesAt) });
  if (has("OPEN_LATE")) add("OPEN_LATE", "open late", { closesAt: iso(t.closesAt) });
  if (has("DAWN_TO_DUSK")) add("DAWN_TO_DUSK", "usually open dawn to dusk", { closesAt: iso(t.closesAt) });
  if (has("HOURS_CONFIRMED")) add("HOURS_CONFIRMED", "hours confirmed", { verifiedAt: iso(e.candidate.facts.opening_hours?.verifiedAt) });
  if (has("FREE")) add("FREE", e.price.isEstimate ? "usually free" : "free");
  else if (has("FITS_BUDGET")) add("FITS_BUDGET", "within budget");
  if (has("SUNSET_WINDOW")) add("SUNSET_WINDOW", "sunset window");
  if (has("WEATHER_SUITABLE")) add("WEATHER_SUITABLE", "good weather for it");
  if (has("OUTDOOR_SEATING")) add("OUTDOOR_SEATING", "good weather to sit outside");
  if (has("ACCESSIBLE_RESTROOM")) add("ACCESSIBLE_RESTROOM", "an accessible restroom");
  // What it has for children, as much as its record says: a "limited" one reads as what it is.
  const kids = kidFacilityLevels(e.candidate);
  if (has("HIGH_CHAIRS")) add("HIGH_CHAIRS", "high chairs", { level: kids.highchair ?? null });
  if (has("CHANGING_TABLE")) add("CHANGING_TABLE", kids.changing_table === "limited" ? "somewhere to change a diaper" : "a changing table", { level: kids.changing_table ?? null });
  if (has("KIDS_AREA")) add("KIDS_AREA", kids.kids_area === "limited" ? "a limited kids' area" : "a kids' area", { level: kids.kids_area ?? null });
  if (has("FRESH_REPORT")) add("FRESH_REPORT", "recent report");
  if (has("LANDMARK")) add("LANDMARK", "a landmark");
  return out;
}

/**
 * What to check before going: one note per unresolved code, none dropped. A code without its own
 * wording still appears (as its name) so a new engine caveat can never silently vanish from a card.
 */
export function caveatNotes(e: Evaluation): Note[] {
  const age = ageLimitOf(e.candidate)?.minAge ?? 0;
  // The forecast's own words for rain: "70% chance of rain between 3 and 5pm".
  const rain = e.timing?.conditions.find((x) => x.kind === "weather" && x.level === "rain");
  const own: Partial<Record<ReasonCode, string>> = { AGE_LIMIT_LIKELY: `probably ${age}+ only`, AGE_LIMIT_UNCERTAIN: `${age}+ only; check your group's ages`, ...(rain?.brief ? { RAIN_LIKELY: rain.brief } : {}) };
  return e.unresolved.map((code) => ({
    code,
    text: own[code] ?? UNRESOLVED_TEXT[code] ?? code.toLowerCase().replace(/_/g, " "),
    params:
      code === "AGE_LIMIT_LIKELY" || code === "AGE_LIMIT_UNCERTAIN"
        ? { minAge: age }
        : code === "WAIT_MAY_NOT_FIT"
          ? { waitMinutes: waitCeilingMinutes(e.timing?.conditions ?? []) }
          : code === "RAIN_LIKELY"
            ? { chance: rain?.chance ?? null }
            : {},
  }));
}

export function explain(e: Evaluation, tz: string, cuisines: readonly string[] = []): CardCopy {
  if (e.class === "ineligible" || !e.timing) {
    return { factLine: "", sentence: "", caveat: e.excludedBy ? `Excluded: ${e.excludedBy.toLowerCase().replace(/_/g, " ")}` : null, cta: null };
  }
  const t = e.timing;
  // What a food place serves leads, the cuisine asked for first: "Thai · ~12 min walk · …".
  const cuisine = e.candidate.kind === "occurrence" ? null : leadCuisine(e.candidate, cuisines);
  const parts: string[] = [...(cuisine ? [cuisine] : []), t.travel.basis];
  if (e.candidate.kind === "occurrence" && e.candidate.occurrence) {
    const o = e.candidate.occurrence;
    parts.push(`starts ${fmtTime(o.start, tz)}${o.end ? `, ends ${fmtTime(o.end, tz)}` : ""}`);
  } else {
    // What the visit takes, not how long the user may stay: their time is theirs.
    parts.push(t.visit.style === "takeout" ? `to go, about ${fmtDuration(t.visit.typicalMinutes)}` : `takes about ${fmtDuration(t.visit.typicalMinutes)}`);
    // A wait is time the visit costs on top: its usual range, or what a report saw.
    const wait = t.conditions.find((x) => x.kind === "wait");
    if (wait?.minutes) parts.push(`~${wait.minutes.min}–${wait.minutes.max} min wait`);
    else if (wait && wait.basis === "report" && wait.level !== "none") parts.push(`${wait.level} line reported`);
    if (t.closesAt) parts.push(e.reasons.includes("DAWN_TO_DUSK") ? `until dusk (${fmtTime(t.closesAt, tz)})` : `until ${fmtTime(t.closesAt, tz)}`);
  }
  // Cold or heat outdoors is worth knowing before leaving; rain is a caveat of its own.
  const weather = t.conditions.find((x) => x.kind === "weather" && (x.level === "cold" || x.level === "hot"));
  if (weather?.brief) parts.push(weather.brief);
  parts.push(e.price.unknown ? "price unknown" : e.price.isEstimate && e.price.text === "free" ? "usually free" : e.price.text);
  // An age limit is always on the card, whoever is asking; an estimated one says so.
  const limit = ageLimitOf(e.candidate);
  if (limit && limit.minAge > 0) parts.push(`${limit.isEstimate ? "usually " : ""}${limit.minAge}+`);
  const factLine = parts.join(" · ");

  const s = reasonNotes(e, tz).map((n) => n.text);
  const sentence = s.length ? s[0]!.charAt(0).toUpperCase() + s.join(", ").slice(1) + "." : "";

  const caveats = caveatNotes(e).map((n) => n.text);
  const caveat = caveats.length ? `Check first: ${caveats.join("; ")}` : null;
  const cta = e.cta === "go" ? "Go now" : e.cta === "book" ? "Book" : e.cta === "check" ? "Check first" : null;
  return { factLine, sentence, caveat, cta };
}

/** One step of the plan, in order: when to leave, arrive, order or get in, wrap up, be back. */
export interface PlanStep {
  kind: "leave" | "park" | "arrive" | "event_starts" | "order_by" | "last_entry" | "entry_by" | "wrap_up" | "back_by";
  at: Date;
  /** True when the time rests on an estimate (travel today; a guessed last entry). */
  isEstimate: boolean;
  /** Default wording, sentence case. */
  text: string;
}

/**
 * The plan behind a card as timed steps. Built from the same timing the engine checked, so the steps
 * never promise more than feasibility allowed.
 */
export function planSteps(e: Evaluation, ctx: Pick<RequestContext, "timezone" | "backBy">): PlanStep[] {
  const t = e.timing;
  if (e.class === "ineligible" || !t) return [];
  const tz = ctx.timezone;
  const at = (d: Date) => fmtTime(d, tz);
  const steps: PlanStep[] = [{ kind: "leave", at: t.departAt, isEstimate: false, text: `Leave at ${at(t.departAt)}` }];
  // A drive with public parking nearby: the car is parked the walk before arriving.
  if (t.parking && t.travel.mode === "drive") steps.push({ kind: "park", at: addMinutes(t.departAt, t.travel.minutes - t.parking.walkMinutes), isEstimate: true, text: parkStepText(t.parking) });
  const opensThen = e.reasons.includes("WAIT_FOR_OPENING");
  const o = e.candidate.kind === "occurrence" ? e.candidate.occurrence : undefined;
  // A start or cutoff already behind the arrival is not an instruction: it becomes a note on arriving.
  const startedBefore = o !== undefined && o.start < t.arrival;
  const la = t.latestArrival && t.latestArrival >= t.arrival ? t.latestArrival : null;
  const missed = t.latestArrival && !la ? t.latestArrivalKind : null;
  const note = startedBefore ? ` (it started at ${at(o!.start)}; joining late)` : missed === "last_entry" ? " (last entry may have passed)" : missed === "event_entry" ? " (the entry cutoff may have passed)" : "";
  steps.push({ kind: "arrive", at: t.arrival, isEstimate: t.travel.isEstimate, text: opensThen ? `Arrive as it opens at ${at(t.arrival)}` : `Arrive around ${at(t.arrival)}${note}` });
  if (o && !startedBefore) steps.push({ kind: "event_starts", at: o.start, isEstimate: false, text: `Starts at ${at(o.start)}` });
  if (la && t.latestArrivalKind) {
    if (t.latestArrivalKind === "last_order") steps.push({ kind: "order_by", at: la, isEstimate: t.latestArrivalIsEstimate, text: `Order by ${at(la)}` });
    else if (t.latestArrivalKind === "last_entry") steps.push({ kind: "last_entry", at: la, isEstimate: t.latestArrivalIsEstimate, text: t.latestArrivalIsEstimate ? `Last entry likely around ${at(la)}` : `Last entry ${at(la)}` });
    else steps.push({ kind: "entry_by", at: la, isEstimate: false, text: `Get in by ${at(la)}` });
  }
  const f = t.latestFinish;
  const byClose = t.closesAt !== null && f.getTime() === t.closesAt.getTime();
  // With a back-by time, the deadline already leaves room for the (estimated) trip back.
  const forTripBack = !byClose && Boolean(ctx.backBy && t.returnTravel) && f < ctx.backBy!;
  const byDeadline = f.getTime() === t.deadline.getTime();
  const why = byClose ? (o ? ", when it ends" : ", when it closes") : forTripBack ? " to get back in time" : "";
  // Otherwise the finish is a guess, like a kitchen's usual last orders before a posted close.
  const isEstimate = byClose ? false : forTripBack ? t.returnTravel!.isEstimate : !byDeadline;
  steps.push({ kind: "wrap_up", at: f, isEstimate, text: `Wrap up by ${at(f)}${why}` });
  if (ctx.backBy && t.returnTravel) steps.push({ kind: "back_by", at: ctx.backBy, isEstimate: t.returnTravel.isEstimate, text: `Back by ${at(ctx.backBy)}` });
  // In time order, always (a stable sort keeps the listed order for steps at the same minute).
  return steps.sort((a, b) => a.at.getTime() - b.at.getTime());
}

