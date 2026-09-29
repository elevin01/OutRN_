/**
 * Evidence classes decide what a card may claim. An estimate is never rendered
 * as a fact; a fetch date is never rendered as a verification date.
 */
export const EVIDENCE_CLASSES = ["published", "observation", "estimate"] as const;
export type EvidenceClass = (typeof EVIDENCE_CLASSES)[number];

/**
 * Attributes a fact can carry. Values are JSON; the shape per attribute is
 * documented here and validated in @outrn/facts.
 *
 *  - opening_hours      : { osm: string } | { weekly: WeeklyIntervals }  (see time.ts)
 *  - kitchen_hours      : same shape as opening_hours; when food is served (last orders at the close)
 *  - happy_hours        : same shape as opening_hours; when drinks (and often food) are discounted
 *  - outdoor_seating    : { value: "yes"|"no" }  tables outside (a sidewalk, a garden, a roof)
 *  - last_entry_offset  : { minutes: number }  minutes before close that admission stops
 *  - admission          : { requirement: "walk_in"|"reservation"|"ticket"|"tour_only"|"members_only"|"unknown" }
 *                         members_only: not open to the public (a private club, a university library)
 *  - admission_status   : { status: "confirmed"|"unconfirmed"|"sold_out"|"cancelled" }
 *  - price              : { min?: number, max?: number, currency: string, free?: boolean, basis: "per_person"|"per_group" }
 *  - min_useful_minutes : { minutes: number }
 *  - business_status    : { status: "operating"|"closed_permanently"|"closed_temporarily" }
 *  - scheduled_closure  : { at: ISO instant }  a permanent closure a source announces ahead (OSM end_date);
 *                         in force from `at` at request time, before any ingest records the closed status
 *  - website, phone     : { value: string }
 *  - name               : { value: string }
 *  - category           : { value: Category }
 *  - indoor_outdoor     : { value: "indoor"|"covered"|"outdoor"|"mixed" }
 *  - parking            : { kind: "lot"|"street"|"garage"|"none"|"unknown", cost?: "free"|"paid"|"unknown", note?: string }
 *  - wheelchair         : { value: "yes"|"limited"|"no"|"unknown" }
 *  - takeout            : { value: "yes"|"no"|"only" }  food to go (OSM takeaway); "only" has no seats
 *  - links              : { instagram?, facebook?, menu? }  the venue's own pages, as https URLs
 *  - subtype            : { value: string }  the kind within a broad category ("casino", "miniature_golf", "zoo")
 *  - cuisine            : { values: string[] }  what a place serves, as OSM cuisine slugs ("italian", "pizza")
 *  - age_limit          : { minAge: number }  minimum admission age; 0 = no age limit; absent = unknown
 *  - crowd_level        : { value: "quiet"|"moderate"|"busy" }        (observation only)
 *  - queue              : { value: "none"|"short"|"long" }             (observation only)
 *  - open_state         : { value: "open"|"closed" }                   (observation only)
 */
export const ATTRIBUTES = [
  "name",
  "category",
  "opening_hours",
  "kitchen_hours",
  "happy_hours",
  "outdoor_seating",
  "last_entry_offset",
  "admission",
  "admission_status",
  "price",
  "min_useful_minutes",
  "business_status",
  "scheduled_closure",
  "website",
  "phone",
  "indoor_outdoor",
  "parking",
  "wheelchair",
  "takeout",
  "links",
  "subtype",
  "cuisine",
  "age_limit",
  "crowd_level",
  "queue",
  "open_state",
] as const;
export type Attribute = (typeof ATTRIBUTES)[number];

/** Attributes whose value changes minute to minute; only observations may carry them. */
export const DYNAMIC_ATTRIBUTES: ReadonlySet<Attribute> = new Set(["crowd_level", "queue", "open_state"]);

/** Attributes the engine treats as material: unknown here forces "Check first". */
export const MATERIAL_ATTRIBUTES: ReadonlySet<Attribute> = new Set(["opening_hours", "admission", "business_status"]);

export interface FactInput {
  subjectKind: "venue" | "occurrence";
  subjectId: string;
  attribute: Attribute;
  value: unknown;
  evidenceClass: EvidenceClass;
  sourceId: string;
  /** Free text or URL that a reviewer can check. Required for published facts. */
  evidence?: string | null;
  /** When the SOURCE says it last changed this fact. Often unknown. */
  sourceUpdatedAt?: Date | null;
  /** When we fetched it. */
  fetchedAt: Date;
  /**
   * When a human observed it: an observation's time, or the survey date a published source gives
   * (OSM check_date). Only an observation's observed_at counts as our verification.
   */
  observedAt?: Date | null;
  validFrom?: Date | null;
  validUntil?: Date | null;
  /** 0..1 */
  confidence: number;
  /** Sources sharing an upstream share a lineage group and count as one. */
  lineageGroup?: string | null;
  /**
   * The source's own record the claim came from (OSM "node/123"). Claims are superseded and
   * retracted per record, so two records of one venue keep their own. Null: the source as a whole.
   */
  sourceRecord?: string | null;
  ingestionRunId?: string | null;
}

/**
 * A "confirmed" claim needs a verification event, not a retrieval: the founder's check date
 * (source_updated_at on a founder fact) or an observation's observed_at. It holds for this many days,
 * and never while the fact is in conflict; older checks go to the recheck queue.
 */
export const CONFIRMATION_MAX_AGE_DAYS = 90;

/** SQL for a current_facts row's verification time: latest founder check or observation among its agreeing inputs (never fetched_at). */
export const VERIFIED_AT_SQL = `(select max(case when f.source_id = 'founder' then f.source_updated_at when f.evidence_class = 'observation' then f.observed_at end) from facts f where f.id = any(cf.input_fact_ids))`;

/**
 * SQL for a venue's fact document: its current_facts rows by attribute, each with its verification
 * time (VERIFIED_AT_SQL), for the venue aliased `v`. Materialization keeps it on venues.facts_doc,
 * so a search reads one value per candidate instead of aggregating facts, and their inputs, for
 * each. Migration 0018 backfills with this same text.
 */
export const VENUE_FACTS_DOC_SQL = `coalesce((select jsonb_object_agg(cf.attribute, jsonb_build_object('value', cf.value, 'confidence', cf.confidence, 'evidence_class', cf.evidence_class, 'valid_until', cf.valid_until, 'independent_sources', cf.independent_sources, 'sources', cf.source_ids, 'conflict', cf.conflict, 'verified_at', ${VERIFIED_AT_SQL})) from current_facts cf where cf.subject_kind = 'venue' and cf.subject_id = v.id), '{}'::jsonb)`;

/** SQL for when a current_facts row's sources last changed it: an observation's time, else the source's own update time (an OSM edit). */
export const AS_OF_SQL = `(select max(case when f.evidence_class = 'observation' then f.observed_at else f.source_updated_at end) from facts f where f.id = any(cf.input_fact_ids))`;

/**
 * SQL for the latest survey date a published source gives for a current_facts row (OSM check_date).
 * A mapper's survey is evidence the value was right on that day, but it is not our verification:
 * it never reads as "confirmed" (VERIFIED_AT_SQL ignores it).
 */
export const SURVEYED_AT_SQL = `(select max(f.observed_at) from facts f where f.id = any(cf.input_fact_ids) and f.evidence_class <> 'observation')`;

export function isFreshConfirmation(verifiedAt: Date | null | undefined, conflict: boolean | undefined, now: Date): boolean {
  if (!verifiedAt || conflict) return false;
  const age = now.getTime() - verifiedAt.getTime();
  return age >= -86_400_000 && age <= CONFIRMATION_MAX_AGE_DAYS * 86_400_000;
}

/** Default usefulness windows by attribute, in minutes. Policy, not fact. */
export const DEFAULT_VALIDITY_MINUTES: Partial<Record<Attribute, number>> = {
  crowd_level: 30,
  queue: 20,
  open_state: 45,
};
