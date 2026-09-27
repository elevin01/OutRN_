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

/** One reason or caveat as data: a stable code, its inputs, and default wording. */
export interface Note {
  code: ReasonCode;
  /** Default wording, lower case so it can sit inside a sentence. */
  text: string;
  params: Record<string, string | number | boolean | null>;
}

export interface CardCopy {
  /** e.g. "~12 min walk · until 10pm, you'd have 1h40 · $15–35" */
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
  if (has("EVENT_STARTS_SOON")) add("EVENT_STARTS_SOON", "starts soon", { startsAt: iso(e.candidate.occurrence?.start) });
  if (has("SHORT_TRAVEL")) add("SHORT_TRAVEL", t.travel.mode === "walk" ? "a short walk" : t.travel.mode === "drive" ? "a short drive" : "a short trip", { mode: t.travel.mode, minutes: t.travel.minutes });
  if (has("WAIT_FOR_OPENING")) add("WAIT_FOR_OPENING", `opens at ${fmtTime(t.arrival, tz)}`, { opensAt: iso(t.arrival) });
  if (has("ENOUGH_TIME")) add("ENOUGH_TIME", "plenty of time", { usefulMinutes: t.usefulMinutes });
  else if (has("CLOSES_SOON")) add("CLOSES_SOON", "closes soon", { closesAt: iso(t.closesAt) });
  if (has("OPEN_LATE")) add("OPEN_LATE", "open late", { closesAt: iso(t.closesAt) });
  if (has("HOURS_CONFIRMED")) add("HOURS_CONFIRMED", "hours confirmed", { verifiedAt: iso(e.candidate.facts.opening_hours?.verifiedAt) });
  if (has("FREE")) add("FREE", "free");
  else if (has("FITS_BUDGET")) add("FITS_BUDGET", "within budget");
  if (has("SUNSET_WINDOW")) add("SUNSET_WINDOW", "sunset window");
  if (has("WEATHER_SUITABLE")) add("WEATHER_SUITABLE", "good weather for it");
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
  const ageText: Partial<Record<ReasonCode, string>> = { AGE_LIMIT_LIKELY: `probably ${age}+ only`, AGE_LIMIT_UNCERTAIN: `${age}+ only; check your group's ages` };
  return e.unresolved.map((code) => ({
    code,
    text: ageText[code] ?? UNRESOLVED_TEXT[code] ?? code.toLowerCase().replace(/_/g, " "),
    params: code === "AGE_LIMIT_LIKELY" || code === "AGE_LIMIT_UNCERTAIN" ? { minAge: age } : {},
  }));
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

  const s = reasonNotes(e, tz).map((n) => n.text);
  const sentence = s.length ? s[0]!.charAt(0).toUpperCase() + s.join(", ").slice(1) + "." : "";

  const caveats = caveatNotes(e).map((n) => n.text);
  const caveat = caveats.length ? `Check first: ${caveats.join("; ")}` : null;
  const cta = e.cta === "go" ? "Go now" : e.cta === "book" ? "Book" : e.cta === "check" ? "Check first" : null;
  return { factLine, sentence, caveat, cta };
}
