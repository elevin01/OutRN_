import { minutesBetween } from "@outrn/core";
import { evaluateHours, isHoursValue } from "@outrn/facts";
import { isOutdoor, readWeather } from "./forecast.js";
import type { Candidate, RequestContext } from "./types.js";

/**
 * What a place offers at the hour of the visit, from its own record: happy hour, or tables outside
 * when the weather suits sitting there. Each lifts appeal a little and gives the card a reason; none
 * ever excludes or changes a class. Policy, not fact.
 */
export const OFFERS = {
  /** Happy hour counts when at least this much of it is left at the arrival… */
  happyHourMinLeft: 20,
  /** …or when it starts this soon after the arrival. */
  happyHourStartsWithin: 30,
  /** Sitting outside: dry (a rain chance known and below this), no colder than this, and not hot. */
  outdoorMaxRainChance: 30,
  outdoorMinF: 55,
  appeal: 0.05,
} as const;

/**
 * Happy hour at a visit arriving then and ending by `finish`: in progress (`until` when), or starting
 * soon after the arrival (`from` when). Null without a parseable happy hour, or for one that never ends.
 */
export function happyHourAt(c: Candidate, arrival: Date, finish: Date): { from: Date | null; until: Date } | null {
  const f = c.kind === "venue" ? c.facts.happy_hours : undefined;
  if (!f || !isHoursValue(f.value)) return null;
  const ev = evaluateHours(f.value, arrival, c.timezone, c.point);
  if (!ev.interval || ev.always) return null;
  const { open, close } = ev.interval;
  if (ev.openNow) return minutesBetween(arrival, close) >= OFFERS.happyHourMinLeft ? { from: null, until: close } : null;
  const startsIn = minutesBetween(arrival, open);
  if (startsIn > 0 && startsIn <= OFFERS.happyHourStartsWithin && minutesBetween(open, finish) >= OFFERS.happyHourMinLeft) return { from: open, until: close };
  return null;
}

/**
 * Tables outside, and a forecast that says it is dry and mild over the start of the plan. Not for a
 * place that is outdoors anyway (tables only outside): the weather is already the visit there.
 */
export function outdoorSeatingWeather(c: Candidate, ctx: RequestContext): boolean {
  if ((c.facts.outdoor_seating?.value as { value?: unknown } | undefined)?.value !== "yes" || isOutdoor(c)) return false;
  const w = ctx.weather;
  if (!w || w.precipProbability === null) return false;
  return w.precipProbability < OFFERS.outdoorMaxRainChance && w.temperatureF >= OFFERS.outdoorMinF && !readWeather(w).hot;
}
