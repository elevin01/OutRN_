import { fromLocal } from "@outrn/core";
import { currentUserAgent, FetchBlocked, FetchFailed, guardedFetch } from "./fetch.js";
import { fetchRobots, robotsAllows, type RobotsPolicy } from "./robots.js";

/**
 * Libraries' and towns' own event calendars, in the three shapes most of them publish (a survey of
 * 104 calendars around the launch areas, October 2026):
 * - iCalendar (RFC 5545): Springshare LibCal's per-calendar feed, WordPress Events Manager, Plone.
 * - The Events Calendar's REST API (WordPress), paged: Westchester County Parks, nature centers.
 * - CivicPlus's calendar RSS: most towns and villages, about two weeks ahead, dates written out.
 * Each read asks the host's robots.txt first, as our agent, and keeps its crawl delay (10 s at least
 * between requests to a host; CivicPlus sites share one pace, as they share servers). What a feed
 * says is kept as data: title, times, where, categories, its link, a cost when it states one, and
 * a little of its description for whether it is free or needs registering. Nothing else.
 */

export type CalendarFormat = "ical" | "tec" | "civicplus";

export interface CalendarEvent {
  /** The feed's own id for it (UID, post id, guid). */
  uid: string;
  title: string;
  /** ISO 8601, UTC. An all-day event starts at local midnight. */
  start: string;
  end: string | null;
  allDay: boolean;
  /** Where, as the feed writes it, a line each, most specific first ("Pine Ridge Park", "32 Garibaldi Pl"). */
  location: string[];
  categories: string[];
  url: string | null;
  cancelled: boolean;
  /** Repeats by a rule the feed does not expand (RRULE): only its first time is known. */
  recurring: boolean;
  /** The price as written ("Free", "$10"), when the feed has a field for it. */
  cost: string | null;
  /** The start of its description, as plain text. */
  text: string;
}

const MAX_TEXT = 1000;
const MAX_EVENTS = 2000;

const ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”", ndash: "–", mdash: "—", hellip: "…" };

function decodeEntities(s: string): string {
  return s.replace(/&#(\d{1,7});|&#x([0-9a-f]{1,6});|&([a-z]{2,8});/gi, (m, dec: string | undefined, hex: string | undefined, name: string | undefined) => {
    const code = dec ? Number(dec) : hex ? parseInt(hex, 16) : null;
    if (code !== null) return code > 0x1f && code <= 0x10ffff && !(code >= 0x7f && code <= 0x9f) ? String.fromCodePoint(code) : " ";
    return ENTITIES[name!.toLowerCase()] ?? m;
  });
}

/** HTML as plain text, a line per break or block: tags dropped, entities decoded, spaces collapsed. */
export function plainLines(html: string): string[] {
  return decodeEntities(html.replace(/<(?:br|\/p|\/div|\/li|\/h\d)\b[^>]{0,200}>/gi, "\n").replace(/<[^>]{0,2000}>/g, " "))
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function plain(html: string, max = MAX_TEXT): string {
  return plainLines(html).join(" ").slice(0, max);
}

/** A time zone name Intl knows ("America/New_York"); Windows names ("Eastern Standard Time") are not. */
function knownZone(tz: string | undefined): tz is string {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// iCalendar

interface IcsProperty {
  name: string;
  params: Record<string, string>;
  value: string;
}

/** NAME;PARAM=x;PARAM="y:z":VALUE, with the value split off at the first colon outside quotes. */
function icsProperty(line: string): IcsProperty | null {
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') quoted = !quoted;
    else if (ch === ":" && !quoted) {
      const [name, ...rest] = line.slice(0, i).split(";");
      const params: Record<string, string> = {};
      for (const p of rest) {
        const eq = p.indexOf("=");
        if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, "");
      }
      return { name: name!.toUpperCase(), params, value: line.slice(i + 1) };
    }
  }
  return null;
}

/** RFC 5545 TEXT: \\n, \\, \\; and \\\\ unescaped. */
function icsText(v: string): string {
  return v.replace(/\\([nN,;\\])/g, (_, c: string) => (c === "n" || c === "N" ? "\n" : c));
}

/** A TEXT list ("A, B\\, C") split at its unescaped commas. */
function icsList(v: string): string[] {
  return v
    .split(/(?<!\\),/)
    .map((x) => icsText(x).trim())
    .filter(Boolean);
}

/** DTSTART/DTEND: UTC ("…Z"), local in its TZID, floating (the feed's zone), or a date (all day). */
function icsTime(p: IcsProperty, timeZone: string): { at: Date; allDay: boolean } | null {
  const v = p.value.trim();
  const d = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (d || p.params["VALUE"] === "DATE") {
    if (!d) return null;
    const at = fromLocal(`${d[1]}-${d[2]}-${d[3]}`, 0, timeZone);
    return Number.isNaN(at.getTime()) ? null : { at, allDay: true };
  }
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/.exec(v);
  if (!m) return null;
  const [, y, mo, da, h, mi, , z] = m;
  const at = z ? new Date(Date.UTC(Number(y), Number(mo) - 1, Number(da), Number(h), Number(mi))) : fromLocal(`${y}-${mo}-${da}`, Number(h) * 60 + Number(mi), knownZone(p.params["TZID"]) ? p.params["TZID"] : timeZone);
  return Number.isNaN(at.getTime()) ? null : { at, allDay: false };
}

/** An RFC 5545 duration ("PT1H30M", "P1D") in minutes. */
function icsDuration(v: string): number | null {
  const m = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v.trim());
  if (!m || v.trim() === "P" || v.trim() === "PT") return null;
  const [, w, d, h, mi] = m.map((x) => (x === undefined ? 0 : Number(x)));
  return w! * 10_080 + d! * 1440 + h! * 60 + mi!;
}

function icsEvent(props: Map<string, IcsProperty[]>, timeZone: string): CalendarEvent | null {
  const one = (name: string) => props.get(name)?.[0];
  const title = one("SUMMARY");
  const dtstart = one("DTSTART");
  if (!title || !dtstart) return null;
  const start = icsTime(dtstart, timeZone);
  if (!start) return null;
  let end: Date | null = null;
  const dtend = one("DTEND");
  if (dtend) end = icsTime(dtend, timeZone)?.at ?? null;
  else if (one("DURATION")) {
    const minutes = icsDuration(one("DURATION")!.value);
    if (minutes !== null) end = new Date(start.at.getTime() + minutes * 60_000);
  }
  const summary = icsText(title.value).replace(/\s+/g, " ").trim();
  if (!summary) return null;
  const uid = one("UID")?.value.trim() || `${summary}@${start.at.toISOString()}`;
  const url = one("URL")?.value.trim() ?? null;
  return {
    uid: uid.slice(0, 500),
    title: summary,
    start: start.at.toISOString(),
    end: end && end > start.at ? end.toISOString() : null,
    allDay: start.allDay,
    // A TEXT value: its commas, escaped or not, part the place from its address.
    location: icsText(one("LOCATION")?.value ?? "").split(",").map((x) => x.replace(/\s+/g, " ").trim()).filter(Boolean),
    categories: (props.get("CATEGORIES") ?? []).flatMap((p) => icsList(p.value)),
    url: url || null,
    cancelled: one("STATUS")?.value.trim().toUpperCase() === "CANCELLED",
    recurring: props.has("RRULE"),
    cost: null,
    text: plain(icsText(one("DESCRIPTION")?.value ?? "")),
  };
}

/** The events of an iCalendar feed (VEVENTs; anything nested in one, an alarm, is not the event). */
export function parseICalendar(text: string, timeZone: string): CalendarEvent[] {
  const out: CalendarEvent[] = [];
  let props: Map<string, IcsProperty[]> | null = null;
  let nested = 0;
  // Lines folded at 75 octets continue after a CRLF and a space or tab.
  for (const line of text.replace(/\r?\n[ \t]/g, "").split(/\r\n|\n|\r/)) {
    const upper = line.toUpperCase();
    if (upper === "BEGIN:VEVENT" && !props) {
      props = new Map();
      nested = 0;
      continue;
    }
    if (!props) continue;
    if (upper.startsWith("BEGIN:")) {
      nested++;
      continue;
    }
    if (upper.startsWith("END:")) {
      if (nested > 0) {
        nested--;
        continue;
      }
      if (upper === "END:VEVENT") {
        const e = icsEvent(props, timeZone);
        if (e) out.push(e);
        if (out.length >= MAX_EVENTS) break;
      }
      props = null;
      continue;
    }
    if (nested > 0) continue;
    const p = icsProperty(line);
    if (!p) continue;
    const list = props.get(p.name) ?? [];
    list.push(p);
    props.set(p.name, list);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// The Events Calendar (WordPress) REST API

/** "2026-10-20 13:30:00" in UTC, as utc_start_date gives it. */
function tecUtc(s: unknown): Date | null {
  const m = typeof s === "string" ? /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/.exec(s) : null;
  if (!m) return null;
  const at = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])));
  return Number.isNaN(at.getTime()) ? null : at;
}

const str = (v: unknown, max = 500): string => (typeof v === "string" ? v.slice(0, max * 4) : "");

/** One page of /wp-json/tribe/events/v1/events: its events, and the next page's URL. */
export function parseTecPage(json: unknown): { events: CalendarEvent[]; next: string | null } {
  const o = json && typeof json === "object" ? (json as Record<string, unknown>) : {};
  const rows = Array.isArray(o["events"]) ? (o["events"] as unknown[]).slice(0, MAX_EVENTS) : [];
  const events: CalendarEvent[] = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const title = plain(str(r["title"]), 300);
    const start = tecUtc(r["utc_start_date"]);
    if (!title || !start) continue;
    const end = tecUtc(r["utc_end_date"]);
    const venue = r["venue"] && typeof r["venue"] === "object" && !Array.isArray(r["venue"]) ? (r["venue"] as Record<string, unknown>) : null;
    const location = venue ? [str(venue["venue"]), str(venue["address"]), str(venue["city"])].map((x) => plain(x, 200)).filter(Boolean) : [];
    const categories = Array.isArray(r["categories"]) ? (r["categories"] as unknown[]).map((c) => (c && typeof c === "object" ? plain(str((c as Record<string, unknown>)["name"]), 100) : "")).filter(Boolean) : [];
    const url = str(r["url"], 2000);
    const cost = plain(str(r["cost"], 100), 100);
    events.push({
      uid: String(r["id"] ?? `${title}@${start.toISOString()}`).slice(0, 500),
      title,
      start: start.toISOString(),
      end: end && end > start ? end.toISOString() : null,
      allDay: r["all_day"] === true,
      location,
      categories,
      url: url || null,
      cancelled: false,
      recurring: false,
      cost: cost || null,
      text: plain(str(r["description"], 20_000)),
    });
  }
  const next = typeof o["next_rest_url"] === "string" ? (o["next_rest_url"] as string) : null;
  return { events, next };
}

// ---------------------------------------------------------------------------------------------
// CivicPlus calendar RSS

/** The text of the first <tag>…</tag> in `block` (CDATA unwrapped, XML entities decoded once). */
function xmlTag(block: string, tag: string): string | null {
  const open = block.indexOf(`<${tag}`);
  if (open < 0) return null;
  const gt = block.indexOf(">", open);
  const close = block.indexOf(`</${tag}>`, gt);
  if (gt < 0 || close < 0) return null;
  let v = block.slice(gt + 1, close).trim();
  if (v.startsWith("<![CDATA[") && v.endsWith("]]>")) return v.slice(9, -3);
  v = v.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
  return v;
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/** "October 22, 2026" → "2026-10-22". */
function writtenDate(s: string): string | null {
  const m = /([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/.exec(s);
  if (!m) return null;
  const month = MONTHS.indexOf(m[1]!.toLowerCase());
  if (month < 0) return null;
  return `${m[3]}-${String(month + 1).padStart(2, "0")}-${m[2]!.padStart(2, "0")}`;
}

/** "06:30 PM" → minutes from midnight. */
function writtenTimes(s: string): number[] {
  return [...s.matchAll(/(\d{1,2}):(\d{2})\s*([AP])\.?M\.?/gi)].map((m) => ((Number(m[1]) % 12) + (m[3]!.toUpperCase() === "P" ? 12 : 0)) * 60 + Number(m[2]));
}

/** The events of a CivicPlus calendar RSS feed (Calendar.aspx's RSSFeed.aspx?ModID=58). */
export function parseCivicPlusRss(xml: string, timeZone: string): CalendarEvent[] {
  const out: CalendarEvent[] = [];
  let at = 0;
  while (out.length < MAX_EVENTS) {
    const open = xml.indexOf("<item>", at);
    if (open < 0) break;
    const close = xml.indexOf("</item>", open);
    if (close < 0) break;
    at = close + 7;
    const block = xml.slice(open, close);
    const title = plain(xmlTag(block, "title") ?? "", 300);
    const dates = xmlTag(block, "calendarEvent:EventDates") ?? "";
    const times = writtenTimes(xmlTag(block, "calendarEvent:EventTimes") ?? "");
    const days = [...dates.matchAll(/[A-Za-z]+\s+\d{1,2},\s*\d{4}/g)].map((m) => writtenDate(m[0])).filter((d): d is string => d !== null);
    if (!title || !days.length) continue;
    const allDay = times.length === 0;
    const start = fromLocal(days[0]!, times[0] ?? 0, timeZone);
    let end: Date | null = times.length >= 2 || days.length >= 2 ? fromLocal(days[days.length - 1]!, times[1] ?? times[0] ?? 0, timeZone) : null;
    if (Number.isNaN(start.getTime())) continue;
    if (end && (Number.isNaN(end.getTime()) || end <= start)) end = null;
    // Where: the description's "Location:" lines (the Location tag runs them together).
    const description = xmlTag(block, "description") ?? "";
    const loc = /Location:\s*<\/strong>([\s\S]*)$/i.exec(description);
    // Some descriptions go on past the place ("Description: …"): that is not where.
    const lines = loc ? plainLines(loc[1]!) : plainLines(xmlTag(block, "calendarEvent:Location") ?? "");
    const stop = lines.findIndex((l) => /^description:/i.test(l));
    const location = (stop >= 0 ? lines.slice(0, stop) : lines).slice(0, 6);
    const link = xmlTag(block, "link")?.trim() ?? null;
    out.push({
      uid: (xmlTag(block, "guid") ?? link ?? `${title}@${start.toISOString()}`).trim().slice(0, 500),
      title,
      start: start.toISOString(),
      end: end ? end.toISOString() : null,
      allDay,
      location,
      categories: [],
      url: link || null,
      cancelled: false,
      recurring: false,
      cost: null,
      text: plain(description.replace(/<strong>[^<]{0,40}<\/strong>/gi, " ")),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Reading a feed

export interface CalendarFeedRef {
  id: string;
  url: string;
  format: CalendarFormat;
}

export interface CalendarRead {
  feed: string;
  url: string;
  /** ok: read; robots: robots.txt keeps our agent out (or could not be read); failed: an error. */
  status: "ok" | "robots" | "failed";
  error?: string;
  pages: number;
  events: CalendarEvent[];
}

/** What `ingest calendars --save` writes and a replay reads: each feed's events as parsed, no raw bodies. */
export interface CalendarCapture {
  outrn_capture: "calendars";
  fetchedAt: string;
  reads: CalendarRead[];
}

export function parseCalendarCapture(data: unknown, label: string): CalendarCapture {
  const d = data as Partial<CalendarCapture> | null;
  if (!d || d.outrn_capture !== "calendars" || typeof d.fetchedAt !== "string" || !Array.isArray(d.reads)) throw new Error(`${label} is not a calendars capture (outrn ingest calendars --save)`);
  return d as CalendarCapture;
}

/** The least time between requests to one host; a robots.txt crawl delay longer than this is kept. */
export const CALENDAR_MIN_INTERVAL_MS = 10_000;
/** The most pages of one paged feed read in a run. */
export const CALENDAR_MAX_PAGES = 12;
const MAX_FEED_BYTES = 8 * 1024 * 1024;

const CONTENT_TYPES: Readonly<Record<CalendarFormat, string[]>> = {
  ical: ["text/calendar", "text/plain", "application/octet-stream", "application/ics"],
  tec: ["application/json"],
  civicplus: ["text/xml", "application/xml", "application/rss+xml"],
};

/** A CivicPlus town site: they share servers, so they share one pace. */
function isCivicPlus(feed: CalendarFeedRef): boolean {
  return feed.format === "civicplus" || /\/RSSFeed\.aspx\b/i.test(feed.url);
}

export interface CalendarReadOptions {
  timeZone: string;
  /** Events from this instant on. */
  from: Date;
  /** …up to this one (a paged feed is asked for this range). */
  until: Date;
  /** robots.txt policies by origin, shared across the feeds of a run. */
  robots: Map<string, RobotsPolicy>;
  /** For tests: what reads a URL (default: guardedFetch). */
  get?: (url: string, opts: { accept: string; contentTypes: string[]; throttleKey: string; minIntervalMs: number }) => Promise<string>;
  /** For tests: what reads a robots.txt (default: fetchRobots). */
  robotsFor?: (origin: string) => Promise<RobotsPolicy>;
}

const day = (d: Date) => d.toISOString().slice(0, 10);

/** Read one feed (every page of a paged one, up to CALENDAR_MAX_PAGES) as robots.txt allows. */
export async function readCalendar(feed: CalendarFeedRef, opts: CalendarReadOptions): Promise<CalendarRead> {
  const read: CalendarRead = { feed: feed.id, url: feed.url, status: "ok", pages: 0, events: [] };
  const first = new URL(feed.url);
  const throttleKey = isCivicPlus(feed) ? "calendars:civicplus" : `calendars:${first.host}`;
  const robotsOf = async (u: URL): Promise<RobotsPolicy> => {
    let policy = opts.robots.get(u.origin);
    if (!policy) {
      policy = await (opts.robotsFor ?? ((origin: string) => fetchRobots(origin, { userAgent: currentUserAgent(), throttleKey, sourceId: "calendars" })))(u.origin);
      opts.robots.set(u.origin, policy);
    }
    return policy;
  };
  const get =
    opts.get ??
    (async (url: string, o: { accept: string; contentTypes: string[]; throttleKey: string; minIntervalMs: number }) =>
      (await guardedFetch(url, { sourceId: "calendars", throttleKey: o.throttleKey, minIntervalMs: o.minIntervalMs, accept: o.accept, allowedContentTypes: o.contentTypes, maxBytes: MAX_FEED_BYTES, timeoutMs: 30_000, retries: 1, sameSiteRedirects: true })).text);
  try {
    // A paged feed is asked for the run's range, fifty to a page; where robots.txt forbids query
    // strings (some sites do), only its bare address.
    let url = feed.url;
    if (feed.format === "tec") {
      const ranged = new URL(feed.url);
      ranged.searchParams.set("per_page", "50");
      ranged.searchParams.set("start_date", day(opts.from));
      ranged.searchParams.set("end_date", day(opts.until));
      if (robotsAllows(await robotsOf(ranged), ranged.pathname + ranged.search)) url = ranged.toString();
    }
    for (let page = 0; page < CALENDAR_MAX_PAGES && url; page++) {
      const u = new URL(url);
      // A next page elsewhere is not this feed's.
      if (u.origin !== first.origin) break;
      const policy = await robotsOf(u);
      if (!robotsAllows(policy, u.pathname + u.search)) {
        if (page === 0) {
          read.status = "robots";
          read.error = policy.status === "unreachable" ? "robots.txt could not be read" : "robots.txt disallows it";
        }
        break;
      }
      const minIntervalMs = Math.max(CALENDAR_MIN_INTERVAL_MS, (policy.crawlDelayS ?? 0) * 1000);
      const body = await get(url, { accept: feed.format === "tec" ? "application/json" : feed.format === "ical" ? "text/calendar, text/plain;q=0.5" : "application/rss+xml, text/xml;q=0.9", contentTypes: CONTENT_TYPES[feed.format], throttleKey, minIntervalMs });
      read.pages++;
      if (feed.format === "ical") read.events.push(...parseICalendar(body, opts.timeZone));
      else if (feed.format === "civicplus") read.events.push(...parseCivicPlusRss(body, opts.timeZone));
      else {
        let json: unknown;
        try {
          json = JSON.parse(body);
        } catch {
          throw new FetchFailed(`not JSON from ${u.host}`);
        }
        const p = parseTecPage(json);
        read.events.push(...p.events);
        url = p.next ?? "";
        continue;
      }
      break;
    }
  } catch (e) {
    read.status = "failed";
    read.error = e instanceof FetchBlocked || e instanceof FetchFailed ? e.message : String((e as Error).message ?? e);
  }
  read.events = read.events.slice(0, MAX_EVENTS);
  return read;
}
