import { localClock } from "@outrn/core";

/** "7pm", "7:30pm", in the area's time zone. */
export function fmtTime(d: Date, tz: string): string {
  const c = localClock(d, tz);
  const h12 = c.hour % 12 === 0 ? 12 : c.hour % 12;
  const m = c.minutes % 60;
  return `${h12}${m ? ":" + String(m).padStart(2, "0") : ""}${c.hour < 12 ? "am" : "pm"}`;
}

/** "45 min", "1h", "1h20". */
export function fmtDuration(min: number): string {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}h${String(m).padStart(2, "0")}` : `${h}h`;
}
