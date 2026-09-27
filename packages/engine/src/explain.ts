import { localClock } from "@outrn/core";
import { ageLimitOf } from "./feasibility.js";
import type { Evaluation, ReasonCode } from "./types.js";

/**
 * Explanations are rendered from reason codes and timing facts, never free text. A sentence
 * appears only when its inputs are valid. Estimates keep their tilde.
 */

export function fmtTime(d: Date, tz: string): string {
  const c = localClock(d, tz);
  const h12 = c.hour % 12 === 0 ? 12 : c.hour % 12;
  const m = c.minutes % 60;
  return `${h12}${m ? ":" + String(m).padStart(2, "0") : ""}${c.hour < 12 ? "am" : "pm"}`;
}

export function fmtDuration(min: number): string {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}h${String(m).padStart(2, "0")}` : `${h}h`;
}

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
};

export interface CardCopy {
  /** e.g. "~12 min walk · until 10pm, you'd have 1h40 · $15–35" */
  factLine: string;
  /** e.g. "Short walk, plenty of time, free." */
  sentence: string;
  /** e.g. "Check first: hours not checked recently" */
  caveat: string | null;
  cta: "Go now" | "Check first" | "Book" | null;
}

export function explain(e: Evaluation, tz: string): CardCopy {
  if (e.class === "ineligible" || !e.timing) {
    return { factLine: "", sentence: "", caveat: e.excludedBy ? `Excluded: ${e.excludedBy.toLowerCase().replace(/_/g, " ")}` : null, cta: null };
  }
  const t = e.timing;
  const parts: string[] = [t.travel.basis];
  if (e.candidate.kind === "occurrence" && e.candidate.occurrence) {
    const o = e.candidate.occurrence;
    parts.push(`starts ${fmtTime(o.start, tz)}${o.end ? `, ends ${fmtTime(o.end, tz)}` : ""}`);
  } else if (t.closesAt) {
    parts.push(`until ${fmtTime(t.closesAt, tz)}, you'd have ${fmtDuration(t.usefulMinutes)}`);
  } else {
    parts.push(`you'd have ${fmtDuration(t.usefulMinutes)}`);
  }
  parts.push(e.price.unknown ? "price unknown" : e.price.isEstimate && e.price.text === "free" ? "usually free" : e.price.text);
  // An age limit is always on the card, whoever is asking; an estimated one says so.
  const limit = ageLimitOf(e.candidate);
  if (limit && limit.minAge > 0) parts.push(`${limit.isEstimate ? "usually " : ""}${limit.minAge}+`);
  const factLine = parts.join(" · ");

  const s: string[] = [];
  if (e.reasons.includes("EVENT_STARTS_SOON")) s.push("starts soon");
  if (e.reasons.includes("SHORT_TRAVEL")) s.push(t.travel.mode === "walk" ? "a short walk" : "a short drive");
  if (e.reasons.includes("WAIT_FOR_OPENING")) s.push(`opens at ${fmtTime(t.arrival, tz)}`);
  if (e.reasons.includes("ENOUGH_TIME")) s.push("plenty of time");
  else if (e.reasons.includes("CLOSES_SOON")) s.push("closes soon");
  if (e.reasons.includes("OPEN_LATE")) s.push("open late");
  if (e.reasons.includes("HOURS_CONFIRMED")) s.push("hours confirmed");
  if (e.reasons.includes("FREE")) s.push("free");
  else if (e.reasons.includes("FITS_BUDGET")) s.push("within budget");
  if (e.reasons.includes("SUNSET_WINDOW")) s.push("sunset window");
  if (e.reasons.includes("WEATHER_SUITABLE")) s.push("good weather for it");
  if (e.reasons.includes("FRESH_REPORT")) s.push("recent report");
  if (e.reasons.includes("LANDMARK")) s.push("a landmark");
  const sentence = s.length ? s[0]!.charAt(0).toUpperCase() + s.join(", ").slice(1) + "." : "";

  const age = limit?.minAge ?? 0;
  const ageText: Partial<Record<ReasonCode, string>> = { AGE_LIMIT_LIKELY: `probably ${age}+ only`, AGE_LIMIT_UNCERTAIN: `${age}+ only; check your group's ages` };
  const caveats = e.unresolved.map((u) => ageText[u] ?? UNRESOLVED_TEXT[u]).filter((x): x is string => Boolean(x));
  const caveat = caveats.length ? `Check first: ${caveats.join("; ")}` : null;
  const cta = e.cta === "go" ? "Go now" : e.cta === "book" ? "Book" : e.cta === "check" ? "Check first" : null;
  return { factLine, sentence, caveat, cta };
}
