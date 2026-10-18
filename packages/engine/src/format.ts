import { localClock } from "@outrn/core";

/** "7pm", "7:30pm", in the area's time zone. */
export function fmtTime(d: Date, tz: string): string {
  const c = localClock(d, tz);
  const h12 = c.hour % 12 === 0 ? 12 : c.hour % 12;
  const m = c.minutes % 60;
  return `${h12}${m ? ":" + String(m).padStart(2, "0") : ""}${c.hour < 12 ? "am" : "pm"}`;
}

/**
 * When a place closes, as seen from the arrival: "10pm", "2am" past midnight, but "7pm tomorrow"
 * or "Sun 7pm" for a close later than the night (hours that run on past a day).
 */
export function fmtUntil(close: Date, arrival: Date, tz: string): string {
  const c = localClock(close, tz);
  const a = localClock(arrival, tz);
  if (c.date === a.date || (close.getTime() - arrival.getTime() < 86_400_000 && c.hour < 6)) return fmtTime(close, tz);
  const days = Math.round((Date.parse(`${c.date}T00:00:00Z`) - Date.parse(`${a.date}T00:00:00Z`)) / 86_400_000);
  return days === 1 ? `${fmtTime(close, tz)} tomorrow` : `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][c.weekday]} ${fmtTime(close, tz)}`;
}

/** "45 min", "1h", "1h20". */
export function fmtDuration(min: number): string {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}h${String(m).padStart(2, "0")}` : `${h}h`;
}
