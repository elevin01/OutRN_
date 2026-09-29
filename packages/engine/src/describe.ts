import { DIETS, dietLabel, isFreshConfirmation, KID_FACILITIES, localClock, ownValue, type Diet, type KidFacility, type LatLon } from "@outrn/core";
import { evaluateHours, isHoursValue } from "@outrn/facts";
import { fmtTime } from "./explain.js";

/**
 * Detail-page copy for a venue's current facts. Same rules as the cards: an estimate is labelled
 * as one, a fetch date is never called a verification, and "confirmed" is reserved for a check
 * (the founder, or a visitor's report). An OSM mapper's survey is named as one, never as
 * "confirmed". Hours come first and are always present.
 */

export interface FactRecord {
  value: unknown;
  confidence: number;
  evidenceClass: "published" | "observation" | "estimate";
  /** Sources behind the value, winner first (current_facts.source_ids). */
  sources: string[];
  conflict?: boolean;
  /** When the source says it last changed (OSM edit), when it was checked (founder), or when it was observed. */
  asOf: Date | null;
  /** When we retrieved it. Never rendered as a verification. */
  fetchedAt: Date | null;
  /** Latest verification (founder check or observation). The only date that may read as "confirmed". */
  verifiedAt?: Date | null;
  /** Latest survey date a published source gives (OSM check_date). Reads as "checked by an OSM mapper". */
  surveyedAt?: Date | null;
}

export interface FactRow {
  attribute: string;
  label: string;
  value: string;
  /** Hours and kitchen hours only: the state today, e.g. "Open now until 4am". */
  detail: string | null;
  source: string;
  age: string | null;
  evidence: "published" | "reported" | "estimate" | "missing";
  conflict: boolean;
}

const LABEL: Record<string, string> = {
  opening_hours: "Hours",
  kitchen_hours: "Kitchen",
  happy_hours: "Happy hour",
  outdoor_seating: "Outdoor seating",
  diets: "Diets",
  internet_access: "Internet",
  business_status: "Status",
  scheduled_closure: "Closing",
  admission: "Admission",
  admission_status: "Admission status",
  price: "Price",
  last_entry_offset: "Last entry",
  min_useful_minutes: "Time to allow",
  wheelchair: "Wheelchair",
  restroom: "Restroom",
  kid_facilities: "For kids",
  takeout: "Takeout",
  subtype: "Kind",
  cuisine: "Cuisine",
  age_limit: "Age limit",
  parking: "Parking",
  indoor_outdoor: "Setting",
  crowd_level: "Crowd",
  queue: "Line",
  open_state: "Open right now",
};
const NET_LABEL: Readonly<Record<string, string>> = { wlan: "Wi-Fi", yes: "Yes", wired: "Wired", terminal: "Computers to use", no: "None" };
const ORDER = ["opening_hours", "kitchen_hours", "business_status", "scheduled_closure", "subtype", "cuisine", "age_limit", "admission", "admission_status", "takeout", "happy_hours", "outdoor_seating", "diets", "internet_access", "price", "last_entry_offset", "min_useful_minutes", "wheelchair", "restroom", "kid_facilities", "parking", "indoor_outdoor", "open_state", "queue", "crowd_level"];
/** Shown elsewhere on the page (title, category, contact panel). */
const HIDDEN = new Set(["name", "category", "website", "phone", "links"]);

const SOURCE_LABEL: Record<string, string> = {
  founder: "OutRN",
  firstparty: "venue website",
  osm: "OpenStreetMap",
  overture: "Overture Maps",
  user_observation: "visitor report",
  category_policy: "category default",
  google_places: "Google",
  foursquare_os: "Foursquare",
};

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function sentenceCase(s: string): string {
  const t = s.replace(/_/g, " ");
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function hm(min: number): string {
  const m = ((min % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}${mm ? ":" + String(mm).padStart(2, "0") : ""}${h < 12 ? "am" : "pm"}`;
}

/** `tz` places dated values (a closing date) on the venue's calendar. */
export function formatFactValue(attribute: string, value: unknown, isEstimate = false, tz = "UTC"): string {
  const v = (value ?? {}) as Record<string, unknown>;
  const tilde = isEstimate ? "~" : "";
  switch (attribute) {
    case "opening_hours":
    case "kitchen_hours":
    case "happy_hours": {
      if (typeof v["osm"] === "string") return v["osm"];
      if (Array.isArray(v["weekly"])) {
        const byDay = new Map<number, string[]>();
        for (const iv of v["weekly"] as { weekday: number; startMin: number; endMin: number }[]) byDay.set(iv.weekday, [...(byDay.get(iv.weekday) ?? []), `${hm(iv.startMin)}–${hm(iv.endMin)}`]);
        return [1, 2, 3, 4, 5, 6, 0].filter((d) => byDay.has(d)).map((d) => `${WEEKDAY[d]} ${byDay.get(d)!.join(", ")}`).join("; ");
      }
      break;
    }
    case "takeout": {
      const t = v["value"];
      if (t === "yes") return "Available";
      if (t === "no") return "Not offered";
      if (t === "only") return "Takeout only (no seating)";
      break;
    }
    case "scheduled_closure": {
      // The instant the closure takes effect, as the venue's calendar day (its local midnight).
      const at = typeof v["at"] === "string" ? new Date(v["at"]) : null;
      if (at && !Number.isNaN(at.getTime())) return `Closes permanently ${new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "short", day: "numeric", year: "numeric" }).format(at)}`;
      break;
    }
    case "business_status": {
      const s = String(v["status"] ?? "");
      return s === "operating" ? "Operating" : s === "closed_permanently" ? "Closed permanently" : s === "closed_temporarily" ? "Temporarily closed" : sentenceCase(s || "unknown");
    }
    case "admission": {
      const r = String(v["requirement"] ?? "unknown");
      const text: Record<string, string> = { walk_in: "Walk in", reservation: "Reservation required", reservation_available: "Walk in; reservations taken", ticket: "Ticket required", tour_only: "Guided tour only", unknown: "Unknown" };
      return text[r] ?? sentenceCase(r);
    }
    case "admission_status":
      return sentenceCase(String(v["status"] ?? "unknown"));
    case "price": {
      if (v["free"] === true) return isEstimate ? "Usually free" : "Free";
      const min = typeof v["min"] === "number" ? v["min"] : undefined;
      const max = typeof v["max"] === "number" ? v["max"] : undefined;
      if (min !== undefined || max !== undefined) {
        const lo = min ?? max!;
        const hi = max ?? min!;
        const range = lo === hi ? `$${lo}` : `$${lo}–${hi}`;
        const tier = typeof v["tier"] === "number" ? ` (price tier ${"$".repeat(v["tier"])})` : "";
        return `${tilde}${range} per ${v["basis"] === "per_group" ? "group" : "person"}${tier}`;
      }
      return v["paid"] === true ? "Paid, amount unknown" : "Unknown";
    }
    case "last_entry_offset":
      return `${tilde}${Number(v["minutes"])} min before closing`;
    case "min_useful_minutes":
      return `${tilde}${Number(v["minutes"])} min or more`;
    case "wheelchair": {
      const w = String(v["value"] ?? "unknown");
      return w === "yes" ? "Accessible" : w === "limited" ? "Limited access" : w === "no" ? "Not accessible" : "Unknown";
    }
    case "restroom": {
      // "Yes, not wheelchair accessible"; "None for visitors"; only an access tag: "Wheelchair accessible".
      if (v["available"] === "no") return "None for visitors";
      const w = v["wheelchair"];
      const access = w === "yes" ? "wheelchair accessible" : w === "limited" ? "limited wheelchair access" : w === "no" ? "not wheelchair accessible" : null;
      if (v["available"] === "yes") return access ? `Yes, ${access}` : "Yes";
      if (access) return sentenceCase(access);
      break;
    }
    case "kid_facilities": {
      // "High chairs; no changing table": each facility the record names, in card order.
      const parts = (Object.keys(KID_FACILITIES) as KidFacility[]).flatMap((k) => {
        const name = KID_FACILITIES[k].toLowerCase();
        return v[k] === "yes" ? [name] : v[k] === "no" ? [`no ${name}`] : [];
      });
      if (parts.length) return sentenceCase(parts.join("; "));
      break;
    }
    case "subtype":
      return sentenceCase(String(v["value"] ?? "unknown"));
    case "diets": {
      // "Vegan; gluten-free options; no halal options": each diet the record names, in DIETS order.
      const parts = (Object.keys(DIETS) as Diet[]).flatMap((d) => {
        const level = v[d];
        const name = DIETS[d];
        if (level === "only" || level === "yes") return [dietLabel(d, level)!.toLowerCase()];
        if (level === "limited") return [`some ${name.toLowerCase()} dishes`];
        if (level === "no") return [`no ${name.toLowerCase()} options`];
        return [];
      });
      // Only a name says so: a guess, and it reads like one.
      if (parts.length) return isEstimate ? `Probably ${parts.join("; ")}` : sentenceCase(parts.join("; "));
      break;
    }
    case "internet_access": {
      const net = ownValue(NET_LABEL, String(v["value"] ?? ""));
      if (net) return net;
      break;
    }
    case "cuisine": {
      // "Italian, pizza": the mapper's words, in their order.
      const values = Array.isArray(v["values"]) ? v["values"].filter((x): x is string => typeof x === "string") : [];
      if (values.length) return sentenceCase(values.join(", "));
      break;
    }
    case "age_limit": {
      const n = typeof v["minAge"] === "number" ? v["minAge"] : null;
      if (n === null) return "Unknown";
      if (n === 0) return isEstimate ? "Usually all ages" : "All ages";
      return `${isEstimate ? "Usually " : ""}${n}+${n >= 18 ? " (adults only)" : ""}`;
    }
    case "parking": {
      const kind = sentenceCase(String(v["kind"] ?? "unknown"));
      const cost = v["cost"] && v["cost"] !== "unknown" ? `, ${String(v["cost"])}` : "";
      return `${kind}${cost}${typeof v["note"] === "string" ? ` (${v["note"]})` : ""}`;
    }
  }
  if (typeof v["value"] === "string") return sentenceCase(v["value"]);
  if (typeof v["status"] === "string") return sentenceCase(v["status"]);
  return Object.entries(v)
    .map(([k, x]) => `${k.replace(/_/g, " ")}: ${typeof x === "object" ? "…" : String(x)}`)
    .join(", ");
}

function fmtDate(d: Date, tz: string, now: Date): string {
  const sameYear = localClock(d, tz).date.slice(0, 4) === localClock(now, tz).date.slice(0, 4);
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) }).format(d);
}

function fmtMonth(d: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "short", year: "numeric" }).format(d);
}

/** Display name of one source id ("osm" → "OpenStreetMap"). */
export function sourceName(source: string): string {
  return SOURCE_LABEL[source] ?? source;
}

export function sourceLabel(sources: string[]): string {
  return sources.map(sourceName).join(" + ") || "unknown source";
}

/** Age wording by what the date actually means for the winning source. */
export function ageLabel(f: FactRecord, tz: string, now: Date): string | null {
  const primary = f.sources[0];
  if (f.verifiedAt && primary !== "user_observation") {
    const recheck = !isFreshConfirmation(f.verifiedAt, false, now) ? " · due for recheck" : "";
    return `confirmed ${fmtDate(f.verifiedAt, tz, now)}${recheck}`;
  }
  if (primary === "user_observation" && f.asOf) {
    const mins = Math.round((now.getTime() - f.asOf.getTime()) / 60_000);
    return mins < 90 ? `reported ${Math.max(1, mins)} min ago` : `reported ${fmtDate(f.asOf, tz, now)}`;
  }
  if (primary === "osm" && f.surveyedAt) {
    // An edit well after the survey may have changed the value since it was checked.
    const edited = f.asOf && f.asOf.getTime() - f.surveyedAt.getTime() > 31 * 86_400_000 ? ` · last edited ${fmtMonth(f.asOf, tz)}` : "";
    return `checked by an OSM mapper ${fmtMonth(f.surveyedAt, tz)}${edited}`;
  }
  if (primary === "osm" && f.asOf) return `last edited in OSM ${fmtMonth(f.asOf, tz)}`;
  if (f.asOf) return `source updated ${fmtDate(f.asOf, tz, now)}`;
  if (f.fetchedAt) return `retrieved ${fmtDate(f.fetchedAt, tz, now)}`;
  return null;
}

/** "Open now until 4am", "Opens 4pm today", "Closed now · opens Tue 11am", "Open 24/7". */
export function hoursToday(value: unknown, now: Date, tz: string, point: LatLon): string | null {
  if (!isHoursValue(value)) return null;
  const ev = evaluateHours(value, now, tz, point);
  if (ev.parseError) return null;
  if (ev.always) return "Open 24/7";
  if (ev.openNow && ev.interval) return `Open now until ${fmtTime(ev.interval.close, tz)}`;
  if (ev.interval) {
    const opens = localClock(ev.interval.open, tz);
    const today = localClock(now, tz);
    return opens.date === today.date ? `Closed now · opens ${fmtTime(ev.interval.open, tz)} today` : `Closed now · opens ${WEEKDAY[opens.weekday]} ${fmtTime(ev.interval.open, tz)}`;
  }
  return "Closed today";
}

/** "On now until 7pm", "Today from 5pm", or nothing when there is none today. */
export function happyHourToday(value: unknown, now: Date, tz: string, point: LatLon): string | null {
  if (!isHoursValue(value)) return null;
  const ev = evaluateHours(value, now, tz, point);
  if (ev.parseError || ev.always || !ev.interval) return null;
  if (ev.openNow) return `On now until ${fmtTime(ev.interval.close, tz)}`;
  return localClock(ev.interval.open, tz).date === localClock(now, tz).date ? `Today from ${fmtTime(ev.interval.open, tz)}` : null;
}

export function describeFacts(facts: Record<string, FactRecord>, ctx: { tz: string; point: LatLon; now: Date }): FactRow[] {
  const rows: FactRow[] = [];
  const hours = facts["opening_hours"];
  if (!hours) {
    rows.push({ attribute: "opening_hours", label: "Hours", value: "Not listed", detail: "Check before you go", source: "no source lists hours", age: null, evidence: "missing", conflict: false });
  }
  const keys = Object.keys(facts)
    .filter((k) => !HIDDEN.has(k))
    .sort((a, b) => (ORDER.indexOf(a) === -1 ? 99 : ORDER.indexOf(a)) - (ORDER.indexOf(b) === -1 ? 99 : ORDER.indexOf(b)));
  for (const attribute of keys) {
    const f = facts[attribute]!;
    const isEstimate = f.evidenceClass === "estimate";
    rows.push({
      attribute,
      label: LABEL[attribute] ?? sentenceCase(attribute),
      value: formatFactValue(attribute, f.value, isEstimate, ctx.tz),
      detail: attribute === "opening_hours" || attribute === "kitchen_hours" ? hoursToday(f.value, ctx.now, ctx.tz, ctx.point) : attribute === "happy_hours" ? happyHourToday(f.value, ctx.now, ctx.tz, ctx.point) : null,
      source: sourceLabel(f.sources),
      age: ageLabel(f, ctx.tz, ctx.now),
      evidence: f.evidenceClass === "observation" ? "reported" : f.evidenceClass,
      conflict: f.conflict ?? false,
    });
  }
  return rows;
}
