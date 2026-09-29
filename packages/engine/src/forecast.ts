import { fmtTime } from "./format.js";
import type { Candidate, Condition, RequestContext } from "./types.js";

/**
 * What the forecast means for a place. Weather matters where people are outside: parks, gardens,
 * waterfronts, viewpoints, and anything whose record says it is outdoors. Policy, not fact.
 */

/** Kinds of place that are outdoors by nature. */
const OUTDOOR_CATEGORIES: ReadonlySet<string> = new Set(["park", "garden", "waterfront", "viewpoint"]);

/** Where the weather is the visit: an outdoor kind of place, or one whose record says it is outdoors. */
export function isOutdoor(c: Candidate): boolean {
  return OUTDOOR_CATEGORIES.has(c.category) || (c.facts.indoor_outdoor?.value as { value?: unknown } | undefined)?.value === "outdoor";
}

/**
 * When the weather changes a plan: rain likely at a 50% chance or more (NWS's own "chance" becomes
 * "likely" around there), cold at 38°F or below, hot at 90°F or above (a heat advisory is near).
 */
export const WEATHER_LIMITS = { rainChance: 50, coldF: 38, hotF: 90 } as const;

/** The forecast for a plan, read against the limits. Everything false when there is no forecast. */
export interface WeatherReading {
  /** Chance of rain over the span, when known for all of it (see weatherFor). */
  chance: number | null;
  rainy: boolean;
  /** A chance of rain is known for the whole span, and it is below the limit. */
  dry: boolean;
  cold: boolean;
  hot: boolean;
}

export function readWeather(w: RequestContext["weather"]): WeatherReading {
  const chance = w?.precipProbability ?? null;
  return {
    chance,
    rainy: chance !== null && chance >= WEATHER_LIMITS.rainChance,
    dry: chance !== null && chance < WEATHER_LIMITS.rainChance,
    cold: w ? w.temperatureF <= WEATHER_LIMITS.coldF : false,
    hot: w?.highF !== undefined ? w.highF >= WEATHER_LIMITS.hotF : false,
  };
}

const deg = (f: number) => `${Math.round(f)}°F`;

/** "between 3 and 5pm", or nothing when the forecast doesn't say which hours it read. */
function hoursOf(w: NonNullable<RequestContext["weather"]>, tz: string): string {
  if (!w.from || !w.until) return "";
  const a = fmtTime(w.from, tz);
  const b = fmtTime(w.until, tz);
  // "3pm" and "5pm" share their half of the day: "between 3 and 5pm".
  const sameHalf = a.slice(-2) === b.slice(-2);
  return ` between ${sameHalf ? a.slice(0, -2) : a} and ${b}`;
}

/**
 * The weather at an outdoor place over the start of the plan, as a condition: rain, cold or heat
 * when the forecast crosses a limit, or dry when it is known to be. Null indoors, without a
 * forecast, or when a mild forecast doesn't say whether it will rain. A forecast, so an estimate.
 */
export function weatherCondition(c: Candidate, ctx: RequestContext): Condition | null {
  const w = ctx.weather;
  if (!w || !isOutdoor(c)) return null;
  const r = readWeather(w);
  const when = hoursOf(w, ctx.timezone);
  const base = { kind: "weather", basis: "forecast", isEstimate: true, minutes: null, reportedAt: null, ...(r.chance !== null ? { chance: r.chance } : {}) } as const;
  if (r.rainy) {
    const brief = `${r.chance}% chance of rain${when}`;
    return { ...base, level: "rain", brief, text: `${brief}${r.cold ? `, down to ${deg(w.temperatureF)}` : ""}` };
  }
  if (r.cold) return { ...base, level: "cold", brief: `down to ${deg(w.temperatureF)}`, text: `Cold: down to ${deg(w.temperatureF)}${when}` };
  if (r.hot) return { ...base, level: "hot", brief: `up to ${deg(w.highF!)}`, text: `Hot: up to ${deg(w.highF!)}${when}` };
  if (r.dry) {
    const range = w.highF !== undefined && Math.round(w.highF) !== Math.round(w.temperatureF) ? `${Math.round(w.temperatureF)}–${deg(w.highF)}` : deg(w.temperatureF);
    return { ...base, level: "fair", brief: `dry, ${range}`, text: `Dry${when}, ${range}` };
  }
  return null;
}
