import { type Category, type FactInput, type LatLon } from "@outrn/core";
import { parseOsmHours } from "@outrn/facts";
import { categoryEvidence, categoryFromOsmTags } from "@outrn/sources";

/**
 * OSM tags → controlled category + facts. Pure function so it is trivially testable.
 *
 * Evidence classes:
 *  - published: the tag states it (name, opening_hours, website, phone, wheelchair, fee, reservation, disused)
 *  - estimate : inferred from category (walk-in for cafés, outdoor for parks)
 *
 * Confidence on opening_hours decays with the age of the OSM edit. The edit timestamp covers
 * ANY tag on the element, so it is an upper bound on how recently hours were touched, never a
 * verification date.
 */

export interface OsmRecord {
  externalId: string;
  point: LatLon;
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
  facts: Omit<FactInput, "subjectId" | "subjectKind" | "fetchedAt" | "ingestionRunId">[];
}

/** Tag → category lives in @outrn/sources (OSM_TAG_CATEGORIES) so the Overpass query can never drift from it. */
export function categoryFromTags(tags: Record<string, string>): Category | null {
  return categoryFromOsmTags(tags);
}

/** 0.62 for a fresh edit, decaying ~0.06 per year of age, floor 0.3. */
export function hoursConfidence(sourceUpdatedAt: Date | null, now: Date): number {
  if (!sourceUpdatedAt) return 0.45;
  const years = Math.max(0, (now.getTime() - sourceUpdatedAt.getTime()) / (365.25 * 86_400_000));
  return Math.max(0.3, +(0.62 - 0.06 * years).toFixed(3));
}

const OUTDOOR: ReadonlySet<Category> = new Set(["park", "garden", "waterfront", "viewpoint"]);

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

  // Closure signals are conservative: any disused:/abandoned: key, or hours "off", marks closed.
  const disused = Object.keys(t).some((k) => k.startsWith("disused:") || k.startsWith("abandoned:") || k.startsWith("was:"));
  const hours = t["opening_hours"]?.trim();
  if (disused || hours === "off" || hours === "closed") {
    pub("business_status", { status: "closed_permanently" }, disused ? Object.keys(t).find((k) => /^(disused|abandoned|was):/.test(k))! : `opening_hours=${hours}`, 0.75);
  } else {
    // Presence in OSM is weak evidence of operating; the source_updated_at age matters here too.
    est("business_status", { status: "operating" }, rec.sourceUpdatedAt && now.getTime() - rec.sourceUpdatedAt.getTime() < 2 * 365 * 86_400_000 ? 0.5 : 0.35);
  }

  if (hours && hours !== "off" && hours !== "closed") {
    const { oh, error } = parseOsmHours(hours, rec.point.lat, rec.point.lon);
    if (oh) pub("opening_hours", { osm: hours }, `opening_hours=${hours}`, hoursConfidence(rec.sourceUpdatedAt, now));
    else rejects.push(`unparseable opening_hours (${error})`); // record kept; hours fact omitted
  }

  const website = t["website"] ?? t["contact:website"] ?? t["url"];
  if (website) pub("website", { value: website }, `website=${website}`, 0.8);
  const phone = t["phone"] ?? t["contact:phone"];
  if (phone) pub("phone", { value: phone }, `phone=${phone}`, 0.8);
  if (t["wheelchair"] && ["yes", "limited", "no"].includes(t["wheelchair"])) pub("wheelchair", { value: t["wheelchair"] }, `wheelchair=${t["wheelchair"]}`, 0.7);

  // Admission
  if (t["reservation"] === "required") pub("admission", { requirement: "reservation" }, "reservation=required", 0.7);
  else if (t["fee"] === "yes" && category && ["museum", "attraction", "gallery", "garden"].includes(category)) pub("admission", { requirement: "ticket" }, "fee=yes", 0.6);
  else if (t["leisure"] === "escape_game") est("admission", { requirement: "reservation" }, 0.6); // escape rooms are booked by the slot
  else if (t["amenity"] === "karaoke_box") est("admission", { requirement: "reservation_available" }, 0.45);
  else if (category && ["cafe", "bar", "dessert", "bookshop", "library", "park", "viewpoint", "waterfront", "market", "community"].includes(category)) est("admission", { requirement: "walk_in" }, 0.55);
  else if (category && ["bowling", "arcade", "nightclub", "activity"].includes(category)) est("admission", { requirement: "walk_in" }, 0.45);
  else if (category === "restaurant") est("admission", { requirement: t["reservation"] === "yes" || t["reservation"] === "recommended" ? "reservation_available" : "walk_in" }, 0.45);
  else if (category && ["theatre", "cinema", "live_music"].includes(category)) est("admission", { requirement: "ticket" }, 0.6);
  else est("admission", { requirement: "unknown" }, 0.2);

  // Price: only what the tags actually say. Beaches are not assumed free (many are resident-permit or paid).
  if (t["fee"] === "no") pub("price", { currency: "USD", free: true, basis: "per_person" }, "fee=no", 0.7);
  else if (t["fee"] === "yes") pub("price", { currency: "USD", basis: "per_person", unknown: true, paid: true }, "fee=yes", 0.6);
  else if (category && OUTDOOR.has(category) && t["natural"] !== "beach") est("price", { currency: "USD", free: true, basis: "per_person" }, 0.6);

  const outdoor = (category && OUTDOOR.has(category)) || t["leisure"] === "miniature_golf";
  if (category) est("indoor_outdoor", { value: outdoor ? "outdoor" : t["outdoor_seating"] === "yes" ? "mixed" : "indoor" }, 0.6);

  if (t["parking"] || t["amenity"] === "parking") pub("parking", { kind: t["parking"] ?? "lot", cost: t["parking:fee"] === "no" ? "free" : t["parking:fee"] === "yes" ? "paid" : "unknown" }, `parking=${t["parking"] ?? "yes"}`, 0.6);

  return {
    name,
    category: category ?? "other",
    point: rec.point,
    websiteKey: website ?? null,
    phone: phone ?? null,
    rejects,
    facts,
  };
}
