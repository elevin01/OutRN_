import { CUISINE_CATEGORIES, cuisineFromName, cuisineSlugs, dietsFromName, dietsFromTags, hasDietTags, fromLocal, isMenuUrlFor, ownValue, type Category, type FactInput, type LatLon } from "@outrn/core";
import { parseOsmHours } from "@outrn/facts";
import { categoryEvidence, categoryFromOsmTags, subtypeFromOsmTags } from "@outrn/sources";

/**
 * OSM tags → controlled category + facts. Pure function so it is trivially testable.
 *
 * Evidence classes:
 *  - published: the tag states it (name, opening_hours, website, phone, wheelchair, fee, charge,
 *    reservation, disused, end_date, opening_date, a mapper's check_date)
 *  - estimate : inferred from category (walk-in for cafés, outdoor for parks, 21+ for bars)
 *
 * Dates. The element's edit timestamp covers ANY tag, so a name fix makes six-year-old hours look
 * fresh: it is an upper bound on when hours were touched, never a verification. A mapper's survey
 * (check_date:opening_hours for hours; check_date or survey:date for the place as a whole) is a
 * real "seen on this day" and is carried as the fact's observed_at. It raises confidence, but it is
 * the mapper's check, not ours: it never makes hours "confirmed".
 */

/**
 * Version of the rules below. Bump it whenever a change would turn the same tags into different
 * facts, or store them differently (per-record claims): the next ingest then re-normalizes every
 * record in its capture, not only the edited ones.
 */
export const OSM_NORMALIZE_VERSION = "2026-09-29.12";

export interface OsmRecord {
  externalId: string;
  point: LatLon;
  /** IANA timezone of the place (its area's): lifecycle dates take effect at its local midnight. */
  timezone: string;
  tags: Record<string, string>;
  sourceUpdatedAt: Date | null;
}

export interface OsmNormalized {
  name: string;
  category: Category;
  point: LatLon;
  websiteKey: string | null;
  phone: string | null;
  /** Reasons a record cannot become a venue (empty = ok). */
  rejects: string[];
  /**
   * The next instant these same tags would say something different about the place being open for
   * business (a closing or opening date arrives, a survey stops counting); null when nothing is
   * scheduled. Ingest re-normalizes the record then, even if nothing upstream changed.
   */
  changesAt: Date | null;
  facts: Omit<FactInput, "subjectId" | "subjectKind" | "fetchedAt" | "ingestionRunId">[];
}

/** Tag → category lives in @outrn/sources (OSM_TAG_CATEGORIES) so the Overpass query can never drift from it. */
export function categoryFromTags(tags: Record<string, string>): Category | null {
  return categoryFromOsmTags(tags);
}

const YEAR_MS = 365.25 * 86_400_000;
const yearsSince = (d: Date, now: Date) => Math.max(0, (now.getTime() - d.getTime()) / YEAR_MS);

/** 0.62 for a fresh edit, decaying ~0.06 per year of age, floor 0.3. */
export function hoursConfidence(sourceUpdatedAt: Date | null, now: Date): number {
  if (!sourceUpdatedAt) return 0.45;
  return Math.max(0.3, +(0.62 - 0.06 * yearsSince(sourceUpdatedAt, now)).toFixed(3));
}

/** A mapper's survey of the hours: 0.72 fresh, decaying ~0.06 per year, floor 0.3. Still below a venue's own site. */
export function surveyedHoursConfidence(checkedAt: Date, now: Date): number {
  return Math.max(0.3, +(0.72 - 0.06 * yearsSince(checkedAt, now)).toFixed(3));
}

/**
 * An opening date further ahead than this is not believed: anyone can edit OSM, and
 * opening_date=9999-12-31 would otherwise hide a place for good. Like a future survey date, it is ignored.
 */
const OPENING_HORIZON_DAYS = 366;

/** A survey that saw the place operating counts for this long; after that, presence in OSM is all we have. */
const SURVEY_STATUS_YEARS = 3;

const addYears = (d: Date, years: number) => {
  const out = new Date(d);
  out.setUTCFullYear(out.getUTCFullYear() + years);
  return out;
};

/**
 * An OSM date (YYYY, YYYY-MM or YYYY-MM-DD) as the first and last instant of the period it names,
 * in UTC. Anything else (ranges, "~1990", "before 2010", impossible dates) is null: never guess.
 * Years outside 1000–9998 are null too: "9999-12-31" means "never" rather than a date, its next day
 * is not a four-digit date, and Date.UTC reads years below 100 as 19xx.
 */
export function osmDate(value: string | undefined): { start: Date; end: Date } | null {
  const m = value?.trim().match(/^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/);
  if (!m) return null;
  const y = Number(m[1]);
  if (y < 1000 || y > 9998) return null;
  const mo = m[2] === undefined ? null : Number(m[2]) - 1;
  const d = m[3] === undefined ? null : Number(m[3]);
  if (mo !== null && (mo < 0 || mo > 11)) return null;
  const start = new Date(Date.UTC(y, mo ?? 0, d ?? 1));
  if (d !== null && (d < 1 || start.getUTCDate() !== d)) return null; // 2025-02-30
  const next = d !== null ? Date.UTC(y, mo!, d + 1) : mo !== null ? Date.UTC(y, mo + 1, 1) : Date.UTC(y + 1, 0, 1);
  return { start, end: new Date(next - 1) };
}

/**
 * A survey's calendar day, kept as an instant for display: midday UTC falls on the same date in every
 * US timezone, so it never reads as the day before. Display only; lifecycle dates use localPeriod.
 */
const midday = (d: Date) => new Date(d.getTime() + 12 * 3_600_000);

/** When an OSM date's period begins and ends in the place's timezone: local midnight, DST-aware. */
function localPeriod(d: { start: Date; end: Date }, tz: string): { from: Date; until: Date } {
  const day = (x: Date) => x.toISOString().slice(0, 10);
  return { from: fromLocal(day(d.start), 0, tz), until: fromLocal(day(new Date(d.end.getTime() + 1)), 0, tz) };
}

/**
 * A mapper's survey date from a check-date tag, as that day's midday. Ignored when it is in the future, before OSM
 * existed, or later than the edit that carries it (a check_date cannot postdate its own edit).
 */
function surveyDate(value: string | undefined, sourceUpdatedAt: Date | null, now: Date): Date | null {
  const d = osmDate(value);
  if (!d || d.start.getUTCFullYear() < 2004 || d.start.getTime() > now.getTime() + 86_400_000) return null;
  if (sourceUpdatedAt && d.start.getTime() > sourceUpdatedAt.getTime() + 86_400_000) return null;
  return midday(d.start);
}

/**
 * OSM charge=* as a per-visit price in dollars: "12 USD", "USD 12", "$12", "12.50 USD",
 * "10-15 USD", "12 USD/person", "20 USD;10 USD" (several prices become a range). A charge per
 * hour, day, vehicle or night is not the price of a visit, and a currency other than dollars is
 * not ours to convert: both are null, like anything that does not parse.
 */
export function parseCharge(value: string | undefined): { min: number; max: number; basis: "per_person" | "per_group" } | null {
  if (!value?.trim()) return null;
  const AMOUNT = String.raw`(\d{1,4}(?:\.\d{1,2})?)`;
  const one = new RegExp(String.raw`^(?:(USD)\s*|\$\s*)?${AMOUNT}(?:\s*[-–]\s*\$?\s*${AMOUNT})?\s*(USD)?(?:\s*/\s*([a-z]+))?$`, "i");
  const amounts: number[] = [];
  const bases = new Set<"per_person" | "per_group">();
  for (const part of value.split(";")) {
    const m = part.trim().match(one);
    if (!m) return null;
    const hasDollar = /^\s*\$/.test(part) || m[1] !== undefined || m[4] !== undefined;
    if (!hasDollar) return null; // a bare number names no currency
    const unit = m[5]?.toLowerCase();
    if (unit && !["person", "ticket", "entry", "adult", "visit", "group"].includes(unit)) return null;
    bases.add(unit === "group" ? "per_group" : "per_person");
    amounts.push(Number(m[2]));
    if (m[3] !== undefined) amounts.push(Number(m[3]));
  }
  const min = Math.min(...amounts);
  const max = Math.max(...amounts);
  return { min, max, basis: bases.size === 1 && bases.has("per_group") ? "per_group" : "per_person" };
}

const INSTAGRAM_RESERVED = new Set(["p", "reel", "reels", "explore", "stories", "accounts", "tv"]);
const FACEBOOK_RESERVED = new Set(["profile.php", "pages", "groups", "events", "sharer", "share.php", "login", "l.php"]);
/** An account handle names something: it has a letter (".." or "__" is not an account). */
const isHandle = (h: string) => /[A-Za-z]/.test(h);

/**
 * The venue's own pages from OSM contact tags, as links we are willing to show: rebuilt from the
 * handle on the official host (never passed through raw), or an https menu on the venue's own site
 * or a known menu platform (never a stranger's page, a free site builder, another tenant of a host
 * the website shares by path, an IP literal or a network-local name).
 * Anything else is dropped.
 */
export function venueLinks(t: Record<string, string>): { links: { instagram?: string; facebook?: string; menu?: string }; evidence: string[] } | null {
  const links: { instagram?: string; facebook?: string; menu?: string } = {};
  const evidence: string[] = [];
  const ig = t["contact:instagram"]?.trim().match(/^(?:https?:\/\/(?:www\.)?instagram\.com\/)?@?([A-Za-z0-9._]{1,30})\/?(?:\?[^\s]*)?$/);
  if (ig && isHandle(ig[1]!) && !INSTAGRAM_RESERVED.has(ig[1]!.toLowerCase())) {
    links.instagram = `https://www.instagram.com/${ig[1]}/`;
    evidence.push(`contact:instagram=${t["contact:instagram"]!.trim()}`);
  }
  const fb = t["contact:facebook"]?.trim().match(/^(?:https?:\/\/(?:www\.|m\.)?facebook\.com\/)?([A-Za-z0-9.\-]{2,80})\/?(?:\?[^\s]*)?$/);
  if (fb && isHandle(fb[1]!) && !FACEBOOK_RESERVED.has(fb[1]!.toLowerCase())) {
    links.facebook = `https://www.facebook.com/${fb[1]}`;
    evidence.push(`contact:facebook=${t["contact:facebook"]!.trim()}`);
  }
  const menu = t["website:menu"]?.trim();
  if (menu && menu.length <= 500) {
    try {
      const u = new URL(menu);
      if (isMenuUrlFor(u.toString(), t["website"] ?? t["contact:website"] ?? t["url"] ?? null)) {
        links.menu = u.toString();
        evidence.push(`website:menu=${menu}`);
      }
    } catch {
      // not a URL: dropped
    }
  }
  return evidence.length ? { links, evidence } : null;
}

/** A bar says it serves food: food=yes, a cuisine, or kitchen hours. Without one, NY bars are usually 21+. */
function servesFood(t: Record<string, string>): boolean {
  return t["food"] === "yes" || Boolean(t["cuisine"]?.trim()) || Boolean(t["opening_hours:kitchen"]?.trim());
}

const OUTDOOR: ReadonlySet<Category> = new Set(["park", "garden", "waterfront", "viewpoint"]);

/** access=* values that close a place to the public: only its owners, members or permit holders get in. */
const MEMBERS_ACCESS = new Set(["private", "no", "members", "permit"]);
/** access=* values that say the public may come in: they outweigh any guess from the operator or building. */
const PUBLIC_ACCESS = new Set(["yes", "permissive", "public"]);

/**
 * A library for a university, college or school's own people. Nothing tags that directly, so the
 * signs are read: library=academic/school, a university or school building, or such an operator.
 * A public library system (New York Public Library, a village library) never matches.
 */
function academicLibrary(t: Record<string, string>): boolean {
  if (t["amenity"] !== "library") return false;
  if (["academic", "university", "school"].includes(t["library"] ?? "")) return true;
  if (["university", "college", "school"].includes(t["building"] ?? "")) return true;
  return /\b(university|college|school|seminary|institute)\b/i.test(t["operator"] ?? "") && !/\bpublic\b/i.test(t["operator"] ?? "");
}

/** A library for its institution's own people, unless the record says the public may use it (access=yes). */
function membersOnlyLibrary(t: Record<string, string>): boolean {
  return academicLibrary(t) && !PUBLIC_ACCESS.has(t["access"] ?? "");
}
/** Categories that group several kinds of place; their subtype is what the category alone cannot say. */
const MULTI_KIND: ReadonlySet<Category> = new Set(["activity", "attraction"]);
/**
 * OSM internet_access → wlan | yes | wired | terminal | no. "wifi" is wlan, and wlan names the kind in
 * a list ("yes, wifi"). "yes" alone is internet of an unknown kind. A list that says "no" and
 * anything else contradicts itself, and anything unknown says nothing: null.
 */
const NET = new Set(["wlan", "yes", "wired", "terminal", "no"]);
export function internetAccess(raw: string | undefined): "wlan" | "yes" | "wired" | "terminal" | "no" | null {
  const parts = (raw ?? "").toLowerCase().split(/[;,]/).map((x) => (x.trim() === "wifi" ? "wlan" : x.trim())).filter(Boolean);
  if (!parts.length || !parts.every((x) => NET.has(x))) return null;
  if (parts.includes("no") && parts.some((x) => x !== "no")) return null;
  if (parts.includes("wlan")) return "wlan";
  return parts[0] as "yes" | "wired" | "terminal" | "no";
}

/** OSM outdoor_seating values that mean tables outside: "yes", "only" (no seats inside), or where they are. */
const OUTDOOR_SEATING_KINDS: ReadonlySet<string> = new Set(["yes", "only", "sidewalk", "pavement", "street", "parklet", "garden", "patio", "terrace", "veranda", "roof", "rooftop", "balcony", "pedestrian_zone", "courtyard", "backyard", "beach", "separate", "bench", "picnic_table"]);

/**
 * Where a place seats people, read once from outdoor_seating (and indoor_seating) so every fact
 * built from it agrees: tables outside or not (null when the tag says nothing we know), and whether
 * outside is all there is ("only", or tables outside with indoor_seating=no).
 */
export function seatingOf(t: Readonly<Record<string, string>>): { outside: "yes" | "no" | null; outdoorOnly: boolean; evidence: string | null } {
  const raw = t["outdoor_seating"]?.trim().toLowerCase();
  if (!raw) return { outside: null, outdoorOnly: false, evidence: null };
  if (raw === "no") return { outside: "no", outdoorOnly: false, evidence: "outdoor_seating=no" };
  const parts = raw.split(";").map((x) => x.trim());
  if (!parts.every((x) => OUTDOOR_SEATING_KINDS.has(x))) return { outside: null, outdoorOnly: false, evidence: null };
  const noSeatsInside = t["indoor_seating"]?.trim().toLowerCase() === "no";
  return { outside: "yes", outdoorOnly: parts.includes("only") || noSeatsInside, evidence: `outdoor_seating=${raw}${noSeatsInside ? "; indoor_seating=no" : ""}` };
}
/** Kinds with an age limit by default in NY (21+); an estimate until a min_age tag or a check says otherwise. */
const DEFAULT_AGE_LIMIT: Readonly<Record<string, number>> = { casino: 21, nightclub: 21 };

/** OSM parking=* values → the controlled parking kinds (core fact-values). Unmapped values are "unknown", never passed through. */
const PARKING_KIND: Record<string, "lot" | "street" | "garage" | "none"> = {
  surface: "lot", lot: "lot", yes: "lot",
  "multi-storey": "garage", underground: "garage", rooftop: "garage", garage: "garage", garage_boxes: "garage", carports: "garage",
  street_side: "street", lane: "street", on_kerb: "street", half_on_kerb: "street", layby: "street", street: "street",
  no: "none",
};
export function parkingKind(tag: string | undefined): "lot" | "street" | "garage" | "none" | "unknown" {
  if (tag === undefined) return "lot"; // amenity=parking with no parking=* tag is a lot
  return ownValue(PARKING_KIND, tag) ?? "unknown";
}

export function normalizeOsm(rec: OsmRecord, now = new Date()): OsmNormalized {
  const t = rec.tags;
  const rejects: string[] = [];
  const name = (t["name"] ?? "").trim();
  if (!name) rejects.push("no name");
  const category = categoryFromTags(t);
  if (!category) rejects.push("no mapped category");
  const facts: OsmNormalized["facts"] = [];
  const base = { sourceId: "osm", sourceUpdatedAt: rec.sourceUpdatedAt, lineageGroup: "osm" } as const;
  const pub = (attribute: FactInput["attribute"], value: unknown, evidence: string, confidence: number) =>
    facts.push({ ...base, attribute, value, evidence, confidence, evidenceClass: "published" });
  const est = (attribute: FactInput["attribute"], value: unknown, confidence: number) =>
    facts.push({ ...base, attribute, value, evidence: null, confidence, evidenceClass: "estimate" });

  if (name) pub("name", { value: name }, `name=${name}`, 0.9);
  if (category) pub("category", { value: category }, categoryEvidence(t) ?? "category tag", 0.8);
  const subtype = subtypeFromOsmTags(t);
  if (category && subtype && MULTI_KIND.has(category)) pub("subtype", { value: subtype }, categoryEvidence(t) ?? subtype, 0.8);
  const cuisines = category && CUISINE_CATEGORIES.has(category) ? cuisineSlugs(t["cuisine"]) : [];
  if (cuisines.length) pub("cuisine", { values: cuisines }, `cuisine=${t["cuisine"]!.trim().slice(0, 200)}`, 0.8);
  // No cuisine tag: what the name says it serves ("Joe's Pizza", "Taqueria Diana"), as an estimate.
  else if (category && CUISINE_CATEGORIES.has(category) && name) {
    const named = cuisineFromName(name);
    if (named.length) facts.push({ ...base, attribute: "cuisine", value: { values: named }, evidence: `name=${name}`, confidence: 0.5, evidenceClass: "estimate" });
  }

  // Age limit: a published min_age wins (0 = none); otherwise kinds with a default limit get an estimate. Everything else stays unknown.
  const minAge = t["min_age"] && /^\d{1,2}$/.test(t["min_age"].trim()) ? Number(t["min_age"].trim()) : null;
  if (minAge !== null && minAge <= 25) pub("age_limit", { minAge }, `min_age=${t["min_age"]}`, 0.75);
  else if (subtype && ownValue(DEFAULT_AGE_LIMIT, subtype)) est("age_limit", { minAge: ownValue(DEFAULT_AGE_LIMIT, subtype)! }, 0.7);
  // A bar that serves no food is usually 21+ in practice, and so is a karaoke box, food or not (a bar with
  // private rooms, most of them 21+ at night). Low confidence: a family sees Check first, never an exclusion.
  else if ((category === "bar" && !servesFood(t)) || t["amenity"] === "karaoke_box") est("age_limit", { minAge: 21 }, 0.5);

  // Surveys: when a mapper last checked the hours, and when anyone last checked the place at all.
  const hoursCheckedAt = surveyDate(t["check_date:opening_hours"], rec.sourceUpdatedAt, now);
  const placeSurvey = (["check_date", "survey:date", "check_date:opening_hours"] as const)
    .map((tag) => ({ tag, at: surveyDate(t[tag], rec.sourceUpdatedAt, now) }))
    .filter((x): x is { tag: (typeof x)["tag"]; at: Date } => x.at !== null)
    .reduce<{ tag: string; at: Date } | null>((a, b) => (!a || b.at > a.at ? b : a), null);

  // Closure signals are conservative: any disused:/abandoned: key, or hours "off", marks closed.
  // A lifecycle date takes effect as its day begins: local midnight where the place is.
  const disused = Object.keys(t).some((k) => k.startsWith("disused:") || k.startsWith("abandoned:") || k.startsWith("was:"));
  const hours = t["opening_hours"]?.trim();
  const ended = osmDate(t["end_date"]);
  const opens = osmDate(t["opening_date"]);
  const endedPeriod = ended ? localPeriod(ended, rec.timezone) : null;
  const closesOn = endedPeriod?.from ?? null;
  const opensAt = opens ? localPeriod(opens, rec.timezone).from : null;
  const opensOn = opensAt && opensAt.getTime() - now.getTime() <= OPENING_HORIZON_DAYS * 86_400_000 ? opensAt : null;
  // Scheduled changes to what these tags say: the record is due for re-normalization at the first.
  const due: Date[] = [];
  // A closing date still ahead: announced as a fact the engine enforces from that day, before any
  // ingest records the closed status; and no "operating" claim outlives it.
  const operatingUntil = closesOn && closesOn > now ? closesOn : null;
  if (operatingUntil) {
    due.push(operatingUntil);
    pub("scheduled_closure", { at: operatingUntil.toISOString() }, `end_date=${t["end_date"]}`, 0.75);
  }
  if (disused || hours === "off" || hours === "closed") {
    pub("business_status", { status: "closed_permanently" }, disused ? Object.keys(t).find((k) => /^(disused|abandoned|was):/.test(k))! : `opening_hours=${hours}`, 0.75);
  } else if (ended && closesOn! <= now) {
    // Ended: certain once the whole period has passed; "end_date=2026" in September still means likely gone.
    pub("business_status", { status: "closed_permanently" }, `end_date=${t["end_date"]}`, endedPeriod!.until <= now ? 0.75 : 0.6);
    if (endedPeriod!.until > now) due.push(endedPeriod!.until);
  } else if (opensOn && opensOn > now) {
    // Not open yet: closed until the opening date, then the fact lapses and presence counts again.
    facts.push({ ...base, attribute: "business_status", value: { status: "closed_temporarily" }, evidence: `opening_date=${t["opening_date"]}`, confidence: 0.7, evidenceClass: "published", validUntil: opensOn });
    due.push(opensOn);
  } else if (placeSurvey && now < addYears(placeSurvey.at, SURVEY_STATUS_YEARS)) {
    // A mapper saw it operating on that day. It counts for three years, or until a closing date.
    const expires = addYears(placeSurvey.at, SURVEY_STATUS_YEARS);
    due.push(expires);
    facts.push({ ...base, attribute: "business_status", value: { status: "operating" }, evidence: `${placeSurvey.tag}=${t[placeSurvey.tag]}`, confidence: Math.max(0.45, +(0.65 - 0.06 * yearsSince(placeSurvey.at, now)).toFixed(3)), evidenceClass: "published", observedAt: placeSurvey.at, validUntil: operatingUntil && operatingUntil < expires ? operatingUntil : expires });
  } else {
    // Presence in OSM is weak evidence of operating; the source_updated_at age matters here too.
    facts.push({ ...base, attribute: "business_status", value: { status: "operating" }, evidence: null, confidence: rec.sourceUpdatedAt && now.getTime() - rec.sourceUpdatedAt.getTime() < 2 * 365 * 86_400_000 ? 0.5 : 0.35, evidenceClass: "estimate", ...(operatingUntil ? { validUntil: operatingUntil } : {}) });
  }

  if (hours && hours !== "off" && hours !== "closed") {
    const { oh, error } = parseOsmHours(hours, rec.point.lat, rec.point.lon);
    if (oh) {
      const edited = hoursConfidence(rec.sourceUpdatedAt, now);
      if (hoursCheckedAt) {
        facts.push({ ...base, attribute: "opening_hours", value: { osm: hours }, evidence: `opening_hours=${hours}; check_date:opening_hours=${t["check_date:opening_hours"]}`, confidence: Math.max(edited, surveyedHoursConfidence(hoursCheckedAt, now)), evidenceClass: "published", observedAt: hoursCheckedAt });
      } else pub("opening_hours", { osm: hours }, `opening_hours=${hours}`, edited);
    } else rejects.push(`unparseable opening_hours (${error})`); // record kept; hours fact omitted
  }

  // Kitchen hours: when food is served, last orders at the close. Only a parseable rule counts.
  const kitchen = t["opening_hours:kitchen"]?.trim();
  if (kitchen) {
    const { oh } = parseOsmHours(kitchen, rec.point.lat, rec.point.lon);
    if (oh) pub("kitchen_hours", { osm: kitchen }, `opening_hours:kitchen=${kitchen}`, hoursConfidence(rec.sourceUpdatedAt, now));
  }

  // Where food and drink are served: happy hour, in opening-hours syntax (only a parseable rule counts),
  // and tables outside, whatever kind ("sidewalk", "garden", "roof"; "only" has no seats inside).
  if (category && CUISINE_CATEGORIES.has(category)) {
    const happy = t["happy_hours"]?.trim();
    if (happy && parseOsmHours(happy, rec.point.lat, rec.point.lon).oh) pub("happy_hours", { osm: happy }, `happy_hours=${happy}`, hoursConfidence(rec.sourceUpdatedAt, now));
    const seats = seatingOf(t);
    if (seats.outside) pub("outdoor_seating", { value: seats.outside }, seats.evidence!, 0.7);
    // What it serves for diets: the diet:* tags when a mapper gave any (they say more than a name;
    // tags we can't read say nothing, and the name doesn't overrule them), else what its name says
    // ("Jisu Vegetarian", "Madina Halal"), as an estimate.
    const tagged = dietsFromTags(t);
    if (tagged) pub("diets", tagged.levels, tagged.evidence, 0.7);
    else if (name && !hasDietTags(t)) {
      const named = dietsFromName(name);
      if (Object.keys(named).length) facts.push({ ...base, attribute: "diets", value: named, evidence: `name=${name}`, confidence: 0.5, evidenceClass: "estimate" });
    }
  }
  // Internet access wherever it is tagged (a café, a library); "wifi" is wlan.
  const net = internetAccess(t["internet_access"]);
  if (category && net) pub("internet_access", { value: net }, `internet_access=${t["internet_access"]!.trim().slice(0, 100)}`, 0.7);

  // Food to go (OSM takeaway): "only" means no seats, "no" means it is not offered.
  const takeaway = t["takeaway"]?.trim();
  if (takeaway === "yes" || takeaway === "no" || takeaway === "only") pub("takeout", { value: takeaway }, `takeaway=${takeaway}`, 0.7);

  const own = venueLinks(t);
  if (own) pub("links", own.links, own.evidence.join("; "), 0.75);

  const website = t["website"] ?? t["contact:website"] ?? t["url"];
  if (website) pub("website", { value: website }, `website=${website}`, 0.8);
  const phone = t["phone"] ?? t["contact:phone"];
  if (phone) pub("phone", { value: phone }, `phone=${phone}`, 0.8);
  if (t["wheelchair"] && ["yes", "limited", "no"].includes(t["wheelchair"])) pub("wheelchair", { value: t["wheelchair"] }, `wheelchair=${t["wheelchair"]}`, 0.7);

  const charge = t["fee"] === "no" ? null : parseCharge(t["charge"]);

  // Admission. Not open to the public comes first: the tag says so, or it's a university or school's own library.
  if (MEMBERS_ACCESS.has(t["access"] ?? "")) pub("admission", { requirement: "members_only" }, `access=${t["access"]}`, 0.7);
  else if (membersOnlyLibrary(t)) est("admission", { requirement: "members_only" }, 0.7);
  else if (t["reservation"] === "required") pub("admission", { requirement: "reservation" }, "reservation=required", 0.7);
  else if ((t["fee"] === "yes" || (charge && charge.max > 0)) && category && ["museum", "attraction", "gallery", "garden"].includes(category)) pub("admission", { requirement: "ticket" }, t["fee"] === "yes" ? "fee=yes" : `charge=${t["charge"]}`, 0.6);
  else if (t["leisure"] === "escape_game") est("admission", { requirement: "reservation" }, 0.6); // escape rooms are booked by the slot
  else if (t["amenity"] === "karaoke_box") est("admission", { requirement: "reservation_available" }, 0.45);
  else if (category && ["cafe", "bar", "dessert", "bookshop", "library", "park", "viewpoint", "waterfront", "market", "community"].includes(category)) est("admission", { requirement: "walk_in" }, 0.55);
  else if (category && ["bowling", "arcade", "nightclub", "activity"].includes(category)) est("admission", { requirement: "walk_in" }, 0.45);
  // A commercial art gallery is open to walk in during its hours (a charge or fee=yes made it a ticket above).
  else if (category === "gallery" && t["tourism"] === "gallery") est("admission", { requirement: "walk_in" }, 0.5);
  else if (category === "restaurant") est("admission", { requirement: t["reservation"] === "yes" || t["reservation"] === "recommended" ? "reservation_available" : "walk_in" }, 0.45);
  else if (category && ["theatre", "cinema", "live_music"].includes(category)) est("admission", { requirement: "ticket" }, 0.6);
  else est("admission", { requirement: "unknown" }, 0.2);

  // Price: only what the tags actually say. Beaches are not assumed free (many are resident-permit or paid).
  if (t["fee"] === "no") pub("price", { currency: "USD", free: true, basis: "per_person" }, "fee=no", 0.7);
  else if (charge && charge.max === 0) pub("price", { currency: "USD", free: true, basis: charge.basis }, `charge=${t["charge"]}`, 0.65);
  else if (charge) pub("price", { currency: "USD", paid: true, basis: charge.basis, min: charge.min, max: charge.max }, `charge=${t["charge"]}`, 0.65);
  else if (t["fee"] === "yes") pub("price", { currency: "USD", basis: "per_person", unknown: true, paid: true }, "fee=yes", 0.6);
  else if (category && OUTDOOR.has(category) && t["natural"] !== "beach") est("price", { currency: "USD", free: true, basis: "per_person" }, 0.6);
  // A public library is free to walk into, and so is a commercial art gallery (it sells the art, not
  // the visit). Museums are not assumed either way.
  else if (category === "library" && !membersOnlyLibrary(t)) est("price", { currency: "USD", free: true, basis: "per_person" }, 0.7);
  else if (category === "gallery" && t["tourism"] === "gallery") est("price", { currency: "USD", free: true, basis: "per_person" }, 0.55);

  // The setting, from the same reading of the seats as the outdoor_seating fact: tables only outside
  // make the place outdoors (rain and cold count against it), tables inside and out make it mixed.
  const seats = seatingOf(t);
  const outdoor = (category && OUTDOOR.has(category)) || t["leisure"] === "miniature_golf" || seats.outdoorOnly;
  if (category) est("indoor_outdoor", { value: outdoor ? "outdoor" : seats.outside === "yes" ? "mixed" : "indoor" }, 0.6);

  if (t["parking"] || t["amenity"] === "parking") pub("parking", { kind: parkingKind(t["parking"]), cost: t["parking:fee"] === "no" ? "free" : t["parking:fee"] === "yes" ? "paid" : "unknown" }, `parking=${t["parking"] ?? "yes"}`, 0.6);

  return {
    name,
    category: category ?? "other",
    point: rec.point,
    websiteKey: website ?? null,
    phone: phone ?? null,
    rejects,
    facts,
    changesAt: due.reduce<Date | null>((a, b) => (!a || b < a ? b : a), null),
  };
}
