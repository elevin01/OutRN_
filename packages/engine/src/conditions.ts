import { addMinutes, localClock, minutesBetween, type Category } from "@outrn/core";
import { isPublicHolidayOn } from "@outrn/facts";
import { fmtTime } from "./format.js";
import type { Candidate, Condition, RequestContext, TimingBase, Visit } from "./types.js";

/**
 * What to expect when the user gets there: how busy it usually is, and whether there is usually a
 * wait. Without a fresh report these are priors for the kind of place at that day and hour ("places
 * like this are usually busy on Friday evenings"), never claims about the venue. A fresh report (a
 * crowd or queue observation) replaces them. Like every estimate, an expected wait never excludes a
 * place: one that could leave too little time downgrades it to Check first.
 */

type Busy = "moderate" | "busy";

/** A busy stretch for a kind of place: local days (0 = Sunday), minutes from local midnight. `to` past 24:00 runs into the next day. */
interface BusyWindow {
  days: readonly number[];
  from: number;
  to: number;
  level: Busy;
}

const WEEKDAYS = [1, 2, 3, 4, 5];
const WEEKEND = [0, 6];
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];
const SUN_THU = [0, 1, 2, 3, 4];
const FRI_SAT = [5, 6];

/** "18:00"-"21:30" as minutes; an end before the start runs past midnight. */
function span(days: readonly number[], from: string, to: string, level: Busy): BusyWindow {
  const m = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
  const a = m(from);
  const b = m(to);
  return { days, from: a, to: b <= a ? b + 1440 : b, level };
}

/**
 * When each kind of place is usually busy. Policy, not fact: broad patterns for New York City and
 * Westchester, outside which a place counts as usually quiet. Public holidays follow Sunday. Kinds
 * whose crowd is the programme (cinema, theatre, live music) or too varied to guess have no entry.
 */
const BUSY_HOURS: Partial<Record<Category, BusyWindow[]>> = {
  restaurant: [
    span(WEEKDAYS, "12:00", "13:30", "moderate"),
    span(WEEKEND, "10:30", "14:30", "busy"), // brunch
    span(SUN_THU, "18:00", "20:30", "moderate"),
    span(FRI_SAT, "18:00", "21:30", "busy"),
  ],
  cafe: [
    span(WEEKDAYS, "07:30", "09:30", "busy"), // the morning rush
    span(WEEKDAYS, "12:00", "14:00", "moderate"),
    span(WEEKEND, "09:30", "13:00", "busy"),
    span(WEEKEND, "13:00", "16:00", "moderate"),
  ],
  dessert: [
    span(WEEKEND, "13:00", "18:00", "moderate"),
    span(SUN_THU, "19:00", "21:30", "moderate"),
    span(FRI_SAT, "19:00", "22:30", "busy"),
  ],
  bar: [
    span(WEEKDAYS, "17:00", "19:30", "moderate"), // after work
    span(FRI_SAT, "18:00", "21:00", "moderate"),
    span([0, 1, 2, 3], "20:00", "23:00", "moderate"),
    span([4], "21:00", "01:00", "busy"),
    span(FRI_SAT, "21:00", "02:30", "busy"),
  ],
  nightclub: [span([4], "23:00", "02:00", "moderate"), span(FRI_SAT, "23:00", "03:00", "busy")],
  museum: [span(WEEKDAYS, "11:00", "15:00", "moderate"), span(WEEKEND, "11:00", "16:00", "busy")],
  attraction: [span(WEEKDAYS, "11:00", "15:00", "moderate"), span(WEEKEND, "11:00", "16:00", "busy")],
  gallery: [span(WEEKEND, "12:00", "17:00", "moderate")],
  park: [span(WEEKDAYS, "12:00", "13:00", "moderate"), span(EVERY_DAY, "17:00", "19:00", "moderate"), span(WEEKEND, "11:00", "17:00", "busy")],
  garden: [span(WEEKEND, "11:00", "16:00", "busy")],
  waterfront: [span(WEEKDAYS, "17:00", "20:00", "moderate"), span(WEEKEND, "11:00", "19:00", "busy")],
  viewpoint: [span(WEEKEND, "12:00", "19:00", "moderate")],
  market: [span(WEEKDAYS, "12:00", "14:00", "moderate"), span(WEEKEND, "10:00", "14:00", "busy"), span(WEEKEND, "14:00", "16:00", "moderate")],
  library: [span(WEEKDAYS, "15:00", "18:00", "moderate"), span(WEEKEND, "11:00", "16:00", "moderate")],
  bookshop: [span(WEEKEND, "12:00", "17:00", "moderate")],
  bowling: [span(SUN_THU, "18:00", "21:00", "moderate"), span(WEEKEND, "12:00", "18:00", "busy"), span(FRI_SAT, "18:00", "23:00", "busy")],
  arcade: [span(SUN_THU, "18:00", "21:00", "moderate"), span(WEEKEND, "12:00", "18:00", "busy"), span(FRI_SAT, "18:00", "23:00", "busy")],
  activity: [span(SUN_THU, "18:00", "21:00", "moderate"), span(WEEKEND, "12:00", "18:00", "busy"), span(FRI_SAT, "18:00", "23:00", "busy")],
};

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** The local calendar day before `date` ("YYYY-MM-DD"). */
function dayBefore(date: string): string {
  const t = Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))) - 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/** An arrival's local minute: which day's pattern applies today and for the night before, and how to name it. */
interface Slot {
  /** Pattern day for today and for the day before (0 = Sunday; a public holiday counts as Sunday). */
  today: number;
  yesterday: number;
  minutes: number;
  /** "Friday evenings", "holiday afternoons", "Saturday nights" (before 5am is the night before). */
  when: string;
}

const slots = new Map<string, Slot>();
const SLOTS_MAX = 4_096;

/** Candidates share arrival minutes, so each local minute is worked out once. */
function slotAt(at: Date, timeZone: string): Slot {
  const key = `${timeZone}\u0000${Math.floor(at.getTime() / 60_000)}`;
  const hit = slots.get(key);
  if (hit) return hit;
  const clock = localClock(at, timeZone);
  const prevDate = dayBefore(clock.date);
  const holidayToday = isPublicHolidayOn(clock.date);
  const holidayBefore = isPublicHolidayOn(prevDate);
  const lateNight = clock.minutes < 300;
  const part = lateNight || clock.minutes >= 21 * 60 ? "nights" : clock.minutes < 12 * 60 ? "mornings" : clock.minutes < 17 * 60 ? "afternoons" : "evenings";
  const named = lateNight ? (holidayBefore ? "holiday" : DAY_NAMES[(clock.weekday + 6) % 7]) : holidayToday ? "holiday" : DAY_NAMES[clock.weekday];
  const slot: Slot = { today: holidayToday ? 0 : clock.weekday, yesterday: holidayBefore ? 0 : (clock.weekday + 6) % 7, minutes: clock.minutes, when: `${named} ${part}` };
  if (slots.size >= SLOTS_MAX) slots.delete(slots.keys().next().value as string);
  slots.set(key, slot);
  return slot;
}

/** How busy this kind of place usually is at `at`, and the words for when ("Friday evenings"). */
export function typicalCrowd(category: Category, at: Date, timeZone: string): { level: "quiet" | Busy; when: string } | null {
  const windows = BUSY_HOURS[category];
  if (!windows) return null;
  const { today, yesterday, minutes, when } = slotAt(at, timeZone);
  let level: "quiet" | Busy = "quiet";
  for (const w of windows) {
    const hit = (w.days.includes(today) && minutes >= w.from && minutes < w.to) || (w.days.includes(yesterday) && minutes + 1440 >= w.from && minutes + 1440 < w.to);
    if (hit && (level === "quiet" || w.level === "busy")) level = w.level;
  }
  return { level, when };
}

const CROWD_WORDS: Record<"quiet" | Busy, string> = { quiet: "quiet", moderate: "fairly busy", busy: "busy" };

/** How long a busy place usually keeps people waiting, by what they came for. Policy, not fact. */
function typicalWait(c: Candidate, visit: Visit): { minutes: { min: number; max: number }; text: string } | null {
  const requirement = (c.facts.admission?.value as { requirement?: unknown } | undefined)?.requirement;
  const booked = c.facts.admission?.evidenceClass !== "estimate" && (requirement === "reservation" || requirement === "ticket");
  if (visit.style === "dine_in" && !booked) return { minutes: { min: 15, max: 30 }, text: "Without a reservation, expect a wait for a table" };
  if (visit.style === "counter" || visit.style === "takeout") return { minutes: { min: 5, max: 15 }, text: "Expect a line to order" };
  // Lanes are the one activity with a well-known walk-in wait; "activity" is too broad to guess (casinos, escape rooms).
  if (c.category === "bowling" && !booked) return { minutes: { min: 20, max: 45 }, text: "Without a booking, expect a wait for a lane" };
  if (c.category === "nightclub") return { minutes: { min: 10, max: 30 }, text: "Expect a line at the door" };
  return null;
}

/** A report counts for an arrival within this long of the request. */
const REPORT_REACH_MINUTES = 60;

/** A crowd or queue observation that still holds and speaks to this arrival. */
function freshReport(c: Candidate, attribute: "crowd_level" | "queue", ctx: RequestContext, arrival: Date): { value: string; at: Date | null } | null {
  const f = c.facts[attribute];
  const value = (f?.value as { value?: unknown } | undefined)?.value;
  if (!f || f.evidenceClass !== "observation" || typeof value !== "string") return null;
  if (!f.validUntil || f.validUntil <= ctx.now || minutesBetween(ctx.now, arrival) > REPORT_REACH_MINUTES) return null;
  return { value, at: f.verifiedAt ?? null };
}

const range = (m: { min: number; max: number }) => `${m.min}–${m.max} min`;

/** Crowd, then wait, at the arrival. Events have none: the programme is the crowd. */
export function conditionsFor(c: Candidate, ctx: RequestContext, t: TimingBase, visit: Visit): Condition[] {
  if (c.kind === "occurrence") return [];
  const out: Condition[] = [];
  const tz = ctx.timezone;
  const reported = (at: Date | null) => (at ? ` at ${fmtTime(at, tz)}` : " recently");

  const crowdReport = freshReport(c, "crowd_level", ctx, t.arrival);
  const typical = typicalCrowd(c.category, t.arrival, tz);
  let crowd: Condition["level"] | null = null;
  if (crowdReport && (crowdReport.value === "quiet" || crowdReport.value === "moderate" || crowdReport.value === "busy")) {
    crowd = crowdReport.value;
    out.push({ kind: "crowd", level: crowd, basis: "report", isEstimate: false, minutes: null, reportedAt: crowdReport.at, text: `Reported ${CROWD_WORDS[crowdReport.value]}${reported(crowdReport.at)}` });
  } else if (typical) {
    crowd = typical.level;
    out.push({ kind: "crowd", level: crowd, basis: "typical", isEstimate: true, minutes: null, reportedAt: null, text: `Places like this are usually ${CROWD_WORDS[typical.level]} on ${typical.when}` });
  }

  const queueReport = freshReport(c, "queue", ctx, t.arrival);
  if (queueReport && (queueReport.value === "none" || queueReport.value === "short" || queueReport.value === "long")) {
    const words = { none: "no line", short: "a short line", long: "a long line" }[queueReport.value];
    out.push({ kind: "wait", level: queueReport.value, basis: "report", isEstimate: false, minutes: null, reportedAt: queueReport.at, text: `Reported ${words}${reported(queueReport.at)}` });
  } else if (crowd === "busy") {
    const w = typicalWait(c, visit);
    if (w) out.push({ kind: "wait", level: w.minutes.max <= 15 ? "short" : "long", basis: "typical", isEstimate: true, minutes: w.minutes, reportedAt: null, text: `${w.text} (usually ${range(w.minutes)})` });
  }
  return out;
}

/** The least a wait is expected to take: the low end of its range, or a reported line's usual floor. */
export function waitFloorMinutes(conditions: readonly Condition[]): number {
  const w = conditions.find((x) => x.kind === "wait");
  if (!w) return 0;
  return w.minutes?.min ?? (w.level === "long" ? 15 : w.level === "short" ? 5 : 0);
}

/**
 * True when the expected wait could leave too little of the visit: less than its minimum, or past a
 * published last order or last entry. An estimate, so it only ever asks the user to check.
 */
export function waitMayNotFit(t: TimingBase, conditions: readonly Condition[]): boolean {
  const floor = waitFloorMinutes(conditions);
  if (floor === 0) return false;
  if (t.usefulMinutes - floor < t.minUsefulMinutes) return true;
  return t.latestArrival !== null && !t.latestArrivalIsEstimate && addMinutes(t.arrival, floor) > t.latestArrival;
}
