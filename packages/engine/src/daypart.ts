import { addMinutes, localClock, ownValue, type Category } from "@outrn/core";

/**
 * Time-of-day fit: open isn't the same as a good idea. A café at 8am, a bar at 11pm or a museum at
 * 2pm is what people go for then; a park after dark, a bar at 10am or a café at 9pm is open but a
 * poor suggestion. Policy, not fact: it moves ranking only, never excludes and never shows as a claim.
 */

export type DayPart = "prime" | "fair" | "off";

/** A stretch of local time, minutes from midnight; `to` past 24:00 runs into the next day. */
interface Span {
  from: number;
  to: number;
}

const h = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
const span = (from: string, to: string): Span => {
  const a = h(from);
  const b = h(to);
  return { from: a, to: b <= a ? b + 1440 : b };
};

interface Hours {
  prime: Span[];
  fair: Span[];
  /** On weekends: extra prime time (brunch). */
  weekendPrime?: Span[];
}

/**
 * When each kind of place is a good idea. Outside prime and fair it is off. For a cinema, theatre or
 * music venue a listed event is its own time; these hours apply only when nothing is listed.
 */
const HOURS: Partial<Record<Category, Hours>> = {
  cafe: { prime: [span("07:00", "11:30")], weekendPrime: [span("08:00", "14:00")], fair: [span("11:30", "18:30")] },
  dessert: { prime: [span("13:00", "22:30")], fair: [span("11:00", "13:00"), span("22:30", "23:30")] },
  restaurant: { prime: [span("11:30", "14:30"), span("17:30", "22:00")], weekendPrime: [span("10:00", "14:30")], fair: [span("08:00", "11:30"), span("14:30", "17:30"), span("22:00", "01:00")] },
  bar: { prime: [span("17:00", "02:00")], fair: [span("16:00", "17:00")] },
  nightclub: { prime: [span("22:00", "04:00")], fair: [span("20:00", "22:00")] },
  museum: { prime: [span("10:00", "17:00")], fair: [span("17:00", "20:30")] },
  gallery: { prime: [span("11:00", "18:00")], fair: [span("18:00", "21:00")] },
  arts_centre: { prime: [span("10:00", "18:00")], fair: [span("18:00", "22:00")] },
  attraction: { prime: [span("10:00", "17:00")], fair: [span("09:00", "10:00"), span("17:00", "21:00")] },
  library: { prime: [span("10:00", "18:00")], fair: [span("08:00", "10:00"), span("18:00", "21:00")] },
  bookshop: { prime: [span("10:00", "19:00")], fair: [span("19:00", "22:00")] },
  cinema: { prime: [span("17:00", "23:00")], weekendPrime: [span("12:00", "23:00")], fair: [span("12:00", "17:00")] },
  theatre: { prime: [span("18:00", "22:00")], weekendPrime: [span("13:00", "15:00")], fair: [span("13:00", "18:00")] },
  live_music: { prime: [span("19:00", "01:00")], fair: [span("17:00", "19:00")] },
  market: { prime: [span("08:00", "15:00")], fair: [span("15:00", "19:00")] },
  bowling: { prime: [span("12:00", "23:00")], fair: [span("10:00", "12:00"), span("23:00", "01:00")] },
  arcade: { prime: [span("12:00", "23:00")], fair: [span("10:00", "12:00"), span("23:00", "01:00")] },
  activity: { prime: [span("12:00", "23:00")], fair: [span("10:00", "12:00"), span("23:00", "01:00")] },
  // Outdoors follows the light: see OUTDOOR_AFTER_DARK.
  park: { prime: [span("08:00", "19:00")], fair: [span("06:00", "08:00"), span("19:00", "20:00")] },
  garden: { prime: [span("09:00", "18:00")], fair: [span("07:00", "09:00"), span("18:00", "19:30")] },
  waterfront: { prime: [span("09:00", "20:30")], fair: [span("07:00", "09:00"), span("20:30", "23:00")] },
  viewpoint: { prime: [span("09:00", "20:30")], fair: [span("07:00", "09:00"), span("20:30", "23:00")] },
};

/** Places whose appeal ends with the light: fair in the last 45 minutes before sunset, off after it, whatever the clock table says. */
const OUTDOOR_AFTER_DARK: ReadonlySet<Category> = new Set(["park", "garden"]);

/** Candidates share arrival minutes, so each local minute's clock is read once. */
const clocks = new Map<string, { minutes: number; weekday: number }>();
function clockAt(at: Date, timeZone: string): { minutes: number; weekday: number } {
  const key = `${timeZone}\u0000${Math.floor(at.getTime() / 60_000)}`;
  let c = clocks.get(key);
  if (!c) {
    const { minutes, weekday } = localClock(at, timeZone);
    c = { minutes, weekday };
    if (clocks.size >= 4_096) clocks.delete(clocks.keys().next().value as string);
    clocks.set(key, c);
  }
  return c;
}

const inSpan = (minutes: number, s: Span) => (minutes >= s.from && minutes < s.to) || (minutes + 1440 >= s.from && minutes + 1440 < s.to);

/** How good an idea this kind of place is at `at`, or null when there is no rule for it. */
export function dayPart(category: Category, at: Date, timeZone: string, sunset?: Date | null): DayPart | null {
  const hours = ownValue(HOURS, category);
  if (!hours) return null;
  const { minutes, weekday } = clockAt(at, timeZone);
  // After dark until the morning: the sunset given is today's, so a pre-dawn arrival still reads from the table.
  if (sunset && OUTDOOR_AFTER_DARK.has(category) && minutes >= 12 * 60) {
    if (at > sunset) return "off";
    if (at > addMinutes(sunset, -45)) return "fair";
  }
  const weekend = weekday === 0 || weekday === 6;
  if (hours.prime.some((s) => inSpan(minutes, s)) || (weekend && hours.weekendPrime?.some((s) => inSpan(minutes, s)))) return "prime";
  if (hours.fair.some((s) => inSpan(minutes, s))) return "fair";
  return "off";
}
