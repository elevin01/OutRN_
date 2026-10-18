import type { WeeklyIntervals } from "@outrn/core";

/**
 * Opening hours a venue's own page states without schema.org JSON-LD (rung 2 of the ladder, after
 * JSON-LD and before any LLM): microdata (`itemprop="openingHours"`), and hours written out in the
 * page's text ("Monday – Friday: 11am – 10pm"). The text reader is strict: whole statements of days
 * and times only, nothing it would have to guess (a time without am or pm, a season, a holiday,
 * happy hour or delivery hours), and it gives up when the page states two different sets of hours
 * for one day (a page listing several locations). Pages are untrusted and up to 3 MB: every scan is
 * linear.
 */

const SKIP_ELEMENTS = ["script", "style", "noscript", "svg", "template", "head"] as const;
const BLOCK_TAGS = new Set(["br", "p", "div", "li", "tr", "td", "th", "h1", "h2", "h3", "h4", "h5", "h6", "section", "article", "header", "footer", "dt", "dd", "table", "ul", "ol", "dl", "address", "main", "aside", "nav", "blockquote", "pre", "hr", "option"]);
const NAMED_ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", rsquo: "’", lsquo: "‘", hellip: "…", middot: "·", bull: "•", thinsp: " ", ensp: " ", emsp: " " };
const MAX_LINES = 6000;
const MAX_LINE = 300;

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, e.toLowerCase()) ? NAMED_ENTITIES[e.toLowerCase()]! : m;
  });
}

/** The page's visible text, one line per block: scripts, styles and the like left out. */
export function visibleLines(html: string): string[] {
  return visibleText(html).lines;
}

/** Elements whose end closes what a heading inside them was about. */
const SECTION_TAGS = new Set(["section", "article", "aside", "header", "footer", "main", "nav", "table"]);
const HEADING = /^h[1-6]$/;
/** Marks in the text while it is built: a heading's start and end, and a section's end (none can appear in a decoded page). */
const [H_OPEN, H_CLOSE, BREAK] = ["\u0001", "\u0002", "\u0003"];

/**
 * The page's visible lines, and for each whether it is a heading (h1–h6), and whether a section
 * (section, article, header, footer, a table…) ended just before it: what the lines are about.
 */
export function visibleText(html: string): { lines: string[]; heading: boolean[]; breakBefore: boolean[] } {
  let out = "";
  let i = 0;
  const lower = html.toLowerCase();
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      out += html.slice(i);
      break;
    }
    out += html.slice(i, lt).replace(/[\u0001-\u0003]/g, " ");
    // Comments, then elements whose content is never shown.
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      i = end === -1 ? html.length : end + 3;
      continue;
    }
    const gt = html.indexOf(">", lt + 1);
    if (gt === -1) break;
    const m = /^<\/?([a-z][a-z0-9]*)/i.exec(html.slice(lt, Math.min(gt + 1, lt + 40)));
    const name = m?.[1]?.toLowerCase() ?? "";
    const closing = html[lt + 1] === "/";
    if (!closing && (SKIP_ELEMENTS as readonly string[]).includes(name)) {
      const end = lower.indexOf(`</${name}`, gt + 1);
      i = end === -1 ? html.length : (lower.indexOf(">", end) + 1 || html.length);
      out += "\n";
      continue;
    }
    if (HEADING.test(name)) out += closing ? `${H_CLOSE}\n` : `\n${H_OPEN}`;
    else if (closing && SECTION_TAGS.has(name)) out += `\n${BREAK}\n`;
    else out += BLOCK_TAGS.has(name) ? "\n" : " ";
    i = gt + 1;
  }
  const lines: string[] = [];
  const heading: boolean[] = [];
  const breakBefore: boolean[] = [];
  let pendingBreak = false;
  let inHeading = false;
  for (const raw of decodeEntities(out).split("\n")) {
    if (raw.includes(BREAK)) {
      pendingBreak = true;
      continue;
    }
    const opens = raw.includes(H_OPEN);
    const closes = raw.includes(H_CLOSE);
    const line = raw.replace(/[\u0001\u0002]/g, "").replace(/[\s\u00a0\u200b]+/g, " ").trim();
    const isHeading = inHeading || opens;
    if (opens) inHeading = true;
    if (closes) inHeading = false;
    if (!line) continue;
    lines.push(line.slice(0, MAX_LINE));
    heading.push(isHeading);
    breakBefore.push(pendingBreak);
    pendingBreak = false;
    if (lines.length >= MAX_LINES) break;
  }
  return { lines, heading, breakBefore };
}

/** `itemprop="openingHours"` values (content= or datetime=, else the element's text), as schema.org's OSM-like strings. */
export function microdataHours(html: string): string[] {
  const out: string[] = [];
  const re = /itemprop\s*=\s*["']openingHours["']/gi;
  let m: RegExpExecArray | null;
  let seen = 0;
  // The tag around each attribute is looked for nearby only, and only so many are looked at: a scan
  // of the whole page per match is quadratic (a 1 MB page of bare attributes took 26 s).
  while ((m = re.exec(html)) && out.length < 14 && seen++ < 200) {
    const before = html.slice(Math.max(0, m.index - 512), m.index);
    const lt = before.lastIndexOf("<");
    const gt = html.slice(m.index, m.index + 512).indexOf(">");
    if (lt === -1 || gt === -1) continue;
    const start = m.index - before.length + lt;
    const end = m.index + gt;
    const tag = html.slice(start, end + 1);
    const attr = /\b(?:content|datetime)\s*=\s*["']([^"']{1,120})["']/i.exec(tag);
    let value = attr?.[1];
    if (!value) {
      const close = html.indexOf("<", end + 1);
      value = close === -1 ? undefined : html.slice(end + 1, Math.min(close, end + 121));
    }
    const v = value ? decodeEntities(value).replace(/\s+/g, " ").trim() : "";
    if (/\d/.test(v) && /[a-z]{2}/i.test(v)) out.push(v);
  }
  return [...new Set(out)];
}

const DAY_NAMES: ReadonlyArray<readonly [RegExp, number]> = [
  [/^sun(?:day)?s?$/, 0],
  [/^mon(?:day)?s?$/, 1],
  [/^tue(?:s|sday)?s?$/, 2],
  [/^wed(?:s|nesday)?s?$/, 3],
  [/^thu(?:r|rs|rsday)?s?$/, 4],
  [/^fri(?:day)?s?$/, 5],
  [/^sat(?:urday)?s?$/, 6],
];
// Each spelling of a day has one reading only ("tues" is tue+s, never tue + plural s): a list of
// days a regex could split two ways is matched in 2^n tries ("Tues, Tues, …" on one line hung a run).
const DAY = "(?:mon(?:days?|s)?|tue(?:sdays?|s)?|wed(?:nesdays?|s)?|thu(?:rsdays?|rs|r|s)?|fri(?:days?|s)?|sat(?:urdays?|s)?|sun(?:days?|s)?)\\.?";
const DAY_SPEC = `(?:daily|every ?day|7 days(?: a week)?|seven days(?: a week)?|weekdays|weekends|${DAY}(?:\\s*(?:-|to|thru|through)\\s*${DAY})?(?:\\s*(?:,|&|and|/|\\+)\\s*${DAY}(?:\\s*(?:-|to|thru|through)\\s*${DAY})?)*)`;
const TIME = "(?:noon|midnight|\\d{1,2}(?::\\d{2})?\\s*(?:a\\.?m\\.?|p\\.?m\\.?|a|p)?)";
const RANGE = `${TIME}\\s*(?:-|to|until|till|'til)\\s*${TIME}`;
const STATEMENT = new RegExp(`\\b(${DAY_SPEC})\\s*:?\\s*(?:-\\s*)?(?:(closed)|(${RANGE}(?:\\s*(?:,|&|and|/)\\s*${RANGE})*))`, "gi");
const DAYS_ONLY = new RegExp(`^(?:open\\s+)?(${DAY_SPEC})\\s*:?$`, "i");
const TIMES_ONLY = new RegExp(`^(?:(closed)|(${RANGE}(?:\\s*(?:,|&|and|/)\\s*${RANGE})*))$`, "i");
/** Hours of something else than the doors: a block of hours with this in it, just above it or just below it is not the venue's. */
const NOT_OPENING = /happy\s*hour|deliver|take\s*-?\s*out|pick\s*-?\s*up|curbside|catering|office|phone|call\b|kitchen|box office|ticket|reservation line|order online|online ordering|front desk|lessons?\b|classes\b|registration|mass\b|service times|worship|sermon|specials?\b|brunch menu|late night menu/i;
/** Hours for part of the year: a block of them is not this week's. */
const SEASONAL = /\b(?:summer|winter|fall|autumn|spring|seasonal|school year|academic year|semester|intersession)\b/i;
/** A holiday or a date: that line is an exception, not the week. */
const EXCEPTION = /\b(?:holiday|thanksgiving|christmas|easter|memorial day|labor day|new year|july 4|independence day|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.? \d{1,2}\b|\d{1,2}\/\d{1,2})/i;

function daysOf(spec: string): number[] {
  const s = spec.toLowerCase().replace(/\./g, "").trim();
  if (/^(?:daily|every ?day|7 days(?: a week)?|seven days(?: a week)?)$/.test(s)) return [0, 1, 2, 3, 4, 5, 6];
  if (s === "weekdays") return [1, 2, 3, 4, 5];
  if (s === "weekends") return [0, 6];
  const out = new Set<number>();
  for (const part of s.split(/\s*(?:,|&|\band\b|\/|\+)\s*/)) {
    const [a, b] = part.split(/\s*(?:-|\bto\b|\bthru\b|\bthrough\b)\s*/);
    const da = dayIndex(a);
    if (da === null) return [];
    if (b === undefined) {
      out.add(da);
      continue;
    }
    const db = dayIndex(b);
    if (db === null) return [];
    for (let d = da; ; d = (d + 1) % 7) {
      out.add(d);
      if (d === db) break;
    }
  }
  return [...out];
}

function dayIndex(word: string | undefined): number | null {
  const w = (word ?? "").trim();
  for (const [re, i] of DAY_NAMES) if (re.test(w)) return i;
  return null;
}

/** Minutes after midnight, with the meridiem when the time says it (null: it doesn't). */
function readTime(t: string): { min: number; meridiem: "a" | "p" | null; hasColon: boolean } | null {
  const s = t.toLowerCase().replace(/\s|\./g, "");
  if (s === "noon") return { min: 720, meridiem: "p", hasColon: true };
  if (s === "midnight") return { min: 0, meridiem: "a", hasColon: true };
  const m = /^(\d{1,2})(?::(\d{2}))?(am|pm|a|p)?$/.exec(s);
  if (!m) return null;
  const h = Number(m[1]);
  const mi = m[2] ? Number(m[2]) : 0;
  if (mi > 59 || h > 24) return null;
  const mer = m[3] ? (m[3][0] as "a" | "p") : null;
  if (mer) {
    if (h < 1 || h > 12) return null;
    return { min: ((h % 12) + (mer === "p" ? 12 : 0)) * 60 + mi, meridiem: mer, hasColon: !!m[2] };
  }
  return { min: h * 60 + mi, meridiem: null, hasColon: !!m[2] };
}

/** A time range as an interval (minutes, the end past midnight as more than 1440), or null when it is a guess. */
function readRange(range: string): { startMin: number; endMin: number } | null {
  const [a, b] = range.split(/\s*(?:-|\bto\b|\buntil\b|\btill\b|'til)\s*/i);
  const open = readTime(a ?? "");
  const close = readTime(b ?? "");
  if (!open || !close) return null;
  let start = open.min;
  let end = close.min;
  if (!open.meridiem && !close.meridiem) {
    // 24-hour times only when they are unmistakably so ("11:00-22:00").
    if (!open.hasColon || !close.hasColon || (open.min < 13 * 60 && close.min < 13 * 60)) return null;
  } else if (!open.meridiem) {
    // "5-10pm" is 5pm; "11-10pm" is 11am (11pm to 10pm would be most of a day).
    const asClose = open.min % 720 + (close.meridiem === "p" ? 720 : 0);
    start = asClose < end ? asClose : open.min % 720;
  } else if (!close.meridiem) {
    return null;
  }
  if (end <= start) end += 1440;
  const length = end - start;
  // "12am-12am", "9am-9am": all day or a typo, either way not read.
  if (length < 30 || length >= 1440) return null;
  return { startMin: start, endMin: end };
}

export interface TextHours {
  weekly: WeeklyIntervals;
  /** The statements read, as the page wrote them. */
  evidence: string;
}

interface Statement {
  days: number[];
  closed: boolean;
  ranges: Array<{ startMin: number; endMin: number }>;
  said: string;
}

/** The statements of days and times a line makes (with the next line, when it holds the times for this one's days). */
function statementsOf(line: string, next: string | undefined): { statements: Statement[]; usesNext: boolean } | null {
  const l = line.replace(/[–—]/g, "-");
  const daysOnly = DAYS_ONLY.exec(l);
  const timesNext = daysOnly && next ? TIMES_ONLY.exec(next.replace(/[–—]/g, "-")) : null;
  const read = (spec: string, closedWord: string | undefined, ranges: string | undefined, said: string): Statement | null => {
    const days = daysOf(spec);
    if (!days.length) return null;
    if (closedWord) return { days, closed: true, ranges: [], said };
    const rs = (ranges ?? "").split(/\s*(?:,|&|\band\b|\/)\s*(?=\d|noon|midnight)/i).map(readRange);
    if (!rs.length || rs.some((r) => r === null)) return null;
    return { days, closed: false, ranges: rs as Array<{ startMin: number; endMin: number }>, said };
  };
  if (timesNext) {
    const st = read(daysOnly![1]!, timesNext[1], timesNext[2], `${line} ${next}`);
    return st ? { statements: [st], usesNext: true } : null;
  }
  STATEMENT.lastIndex = 0;
  const statements = [...l.matchAll(STATEMENT)].map((m) => read(m[1]!, m[2], m[3], m[0])).filter((x): x is Statement => x !== null);
  return statements.length ? { statements, usesNext: false } : null;
}

/**
 * Hours written out in a page's lines, or null when there are none it can read without guessing.
 * Lines of hours next to each other are one block; every block on the page counts (lunch and dinner
 * on separate lines join), except one whose own lines, the line just above or below it, or the
 * heading it is under (until the next heading or the end of its section) say it is the hours of
 * something else (happy hour, delivery, the box office) or of a season. A line about a
 * holiday or a date is an exception and is left out. Nothing is read from a page that gives two
 * different sets of hours for one day (several locations), or hours for weekdays only, saying
 * nothing of the weekend (an office's hours, more often than a venue's).
 */
export function hoursFromText(lines: readonly string[], scope?: { heading: readonly boolean[]; breakBefore: readonly boolean[] }): TextHours | null {
  const byDay = new Map<number, Array<{ startMin: number; endMin: number }>>();
  const closed = new Set<number>();
  const evidence: string[] = [];
  // The heading each line is under: from a heading until the next one, or the end of its section.
  const under: string[] = [];
  let current = "";
  for (let k = 0; k < lines.length; k++) {
    if (scope?.breakBefore[k]) current = "";
    if (scope?.heading[k]) current = lines[k]!;
    under.push(current);
  }
  let i = 0;
  while (i < lines.length) {
    const first = statementsOf(lines[i]!, lines[i + 1]);
    if (!first) {
      i++;
      continue;
    }
    // The block: this line and the lines of hours right after it.
    const block: Statement[] = [];
    const blockLines: string[] = [];
    const start = i;
    let cur: ReturnType<typeof statementsOf> = first;
    while (cur) {
      blockLines.push(lines[i]!);
      if (cur.usesNext) blockLines.push(lines[i + 1]!);
      if (!EXCEPTION.test(lines[i]!)) block.push(...cur.statements);
      i += cur.usesNext ? 2 : 1;
      cur = i < lines.length ? statementsOf(lines[i]!, lines[i + 1]) : null;
    }
    const above = lines[start - 1] ?? "";
    const below = lines[i] ?? "";
    // The lines around the block, and the heading it sits under however far above ("Delivery Hours",
    // a line of copy, then the hours).
    const context = [above, below, under[start] ?? "", ...blockLines];
    if (context.some((l) => NOT_OPENING.test(l) || SEASONAL.test(l))) continue;
    for (const st of block) {
      for (const d of st.days) {
        if (st.closed) closed.add(d);
        else byDay.set(d, [...(byDay.get(d) ?? []), ...st.ranges]);
      }
      evidence.push(st.said);
    }
  }
  const weekly: WeeklyIntervals = [];
  for (const [d, list] of byDay) {
    if (closed.has(d)) return null;
    const uniq = [...new Map(list.map((r) => [`${r.startMin}-${r.endMin}`, r])).values()].sort((a, b) => a.startMin - b.startMin);
    // Two different sets of hours for one day (several locations on one page): not read.
    for (let j = 1; j < uniq.length; j++) if (uniq[j]!.startMin < uniq[j - 1]!.endMin) return null;
    for (const r of uniq) weekly.push({ weekday: d, startMin: r.startMin, endMin: r.endMin });
  }
  // A week's hours: at least three days stated, open or closed, and the weekend among them.
  const stated = new Set([...byDay.keys(), ...closed]);
  if (byDay.size === 0 || stated.size < 3 || (!stated.has(0) && !stated.has(6))) return null;
  weekly.sort((a, b) => a.weekday - b.weekday || a.startMin - b.startMin);
  return { weekly, evidence: [...new Set(evidence)].join(" | ").slice(0, 600) };
}

/** Links on a page to where a site states its hours, best first ("Hours", then "Visit", "Location", "Contact"): same site only. */
export function hoursLinks(html: string, pageUrl: string): string[] {
  const base = new URL(pageUrl);
  const site = base.hostname.replace(/^www\./, "");
  const scored: Array<{ url: string; score: number }> = [];
  const re = /<a\b([^>]{0,500})>/gi;
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = re.exec(html)) && n++ < 2000) {
    const href = /\bhref\s*=\s*["']([^"'#]{1,300})/i.exec(m[1]!)?.[1];
    if (!href || /^(?:mailto|tel|javascript):/i.test(href)) continue;
    const textEnd = html.indexOf("</a", re.lastIndex);
    const text = textEnd === -1 ? "" : html.slice(re.lastIndex, Math.min(textEnd, re.lastIndex + 200)).replace(/<[^>]*>/g, " ");
    const key = `${href} ${text}`.toLowerCase();
    const score = /hours/.test(key) ? 4 : /\bvisit\b|plan your visit|find us|directions/.test(key) ? 3 : /locations?\b/.test(key) ? 2 : /contact/.test(key) ? 1 : 0;
    if (!score) continue;
    let u: URL;
    try {
      u = new URL(decodeEntities(href), base);
    } catch {
      continue;
    }
    if (!/^https?:$/.test(u.protocol) || u.hostname.replace(/^www\./, "") !== site) continue;
    if (/\.(?:pdf|jpe?g|png|gif|webp|zip|docx?)$/i.test(u.pathname)) continue;
    u.hash = "";
    if (u.toString() === base.toString()) continue;
    scored.push({ url: u.toString(), score });
  }
  scored.sort((a, b) => b.score - a.score);
  return [...new Set(scored.map((s) => s.url))];
}
