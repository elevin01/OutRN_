/**
 * Local-time helpers. Everything scheduled is reasoned about in the venue's IANA
 * timezone; instants are stored in UTC.
 */

export interface LocalClock {
  /** 0 = Sunday … 6 = Saturday, in the venue's timezone */
  weekday: number;
  /** minutes since local midnight */
  minutes: number;
  /** YYYY-MM-DD in the venue's timezone */
  date: string;
  hour: number;
}

// Building an Intl.DateTimeFormat costs far more than formatting with one, and these run for every
// candidate on every request: keep one per zone.
const clockFormats = new Map<string, Intl.DateTimeFormat>();
const offsetFormats = new Map<string, Intl.DateTimeFormat>();

function cached(cache: Map<string, Intl.DateTimeFormat>, timeZone: string, make: () => Intl.DateTimeFormat): Intl.DateTimeFormat {
  let fmt = cache.get(timeZone);
  if (!fmt) {
    fmt = make();
    cache.set(timeZone, fmt);
  }
  return fmt;
}

export function localClock(at: Date, timeZone: string): LocalClock {
  const fmt = cached(clockFormats, timeZone, () =>
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }),
  );
  const parts = Object.fromEntries(fmt.formatToParts(at).map((p) => [p.type, p.value]));
  const wd: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const hour = Number(parts["hour"]);
  const minute = Number(parts["minute"]);
  return {
    weekday: wd[parts["weekday"] as string] ?? 0,
    minutes: hour * 60 + minute,
    date: `${parts["year"]}-${parts["month"]}-${parts["day"]}`,
    hour,
  };
}

/** Offset in minutes of `timeZone` from UTC at instant `at` (positive east of UTC). */
export function tzOffsetMinutes(at: Date, timeZone: string): number {
  const fmt = cached(offsetFormats, timeZone, () =>
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }),
  );
  const p = Object.fromEntries(fmt.formatToParts(at).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p["year"]!, +p["month"]! - 1, +p["day"]!, +p["hour"]!, +p["minute"]!, +p["second"]!);
  return Math.round((asUtc - at.getTime()) / 60_000);
}

/** Build an instant from a local wall-clock time in a timezone. Handles DST by two-pass correction. */
export function fromLocal(date: string, minutes: number, timeZone: string): Date {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const guess = new Date(Date.UTC(y, m - 1, d, Math.floor(minutes / 60), minutes % 60));
  const off1 = tzOffsetMinutes(guess, timeZone);
  const t1 = new Date(guess.getTime() - off1 * 60_000);
  const off2 = tzOffsetMinutes(t1, timeZone);
  return off2 === off1 ? t1 : new Date(guess.getTime() - off2 * 60_000);
}

export function addMinutes(d: Date, minutes: number): Date {
  return new Date(d.getTime() + minutes * 60_000);
}

export function minutesBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 60_000);
}

/** An open interval on a specific local date, resolved to instants. */
export interface OpenInterval {
  open: Date;
  close: Date;
}

/** Interval [start,end) in minutes since local midnight; end may exceed 1440 for overnight. */
export interface DayInterval {
  weekday: number;
  startMin: number;
  endMin: number;
}
export type WeeklyIntervals = DayInterval[];
