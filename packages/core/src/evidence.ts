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
 *  - last_entry_offset  : { minutes: number }  minutes before close that admission stops
 *  - admission          : { requirement: "walk_in"|"reservation"|"ticket"|"tour_only"|"unknown" }
 *  - admission_status   : { status: "confirmed"|"unconfirmed"|"sold_out"|"cancelled" }
 *  - price              : { min?: number, max?: number, currency: string, free?: boolean, basis: "per_person"|"per_group" }
 *  - min_useful_minutes : { minutes: number }
 *  - business_status    : { status: "operating"|"closed_permanently"|"closed_temporarily" }
 *  - website, phone     : { value: string }
 *  - name               : { value: string }
 *  - category           : { value: Category }
 *  - indoor_outdoor     : { value: "indoor"|"covered"|"outdoor"|"mixed" }
 *  - parking            : { kind: "lot"|"street"|"garage"|"none"|"unknown", cost?: "free"|"paid"|"unknown", note?: string }
 *  - wheelchair         : { value: "yes"|"limited"|"no"|"unknown" }
 *  - crowd_level        : { value: "quiet"|"moderate"|"busy" }        (observation only)
 *  - queue              : { value: "none"|"short"|"long" }             (observation only)
 *  - open_state         : { value: "open"|"closed" }                   (observation only)
 */
export const ATTRIBUTES = [
  "name",
  "category",
  "opening_hours",
  "last_entry_offset",
  "admission",
  "admission_status",
  "price",
  "min_useful_minutes",
  "business_status",
  "website",
  "phone",
  "indoor_outdoor",
  "parking",
  "wheelchair",
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
  /** When a human observed it. Observations only. */
  observedAt?: Date | null;
  validFrom?: Date | null;
  validUntil?: Date | null;
  /** 0..1 */
  confidence: number;
  /** Sources sharing an upstream share a lineage group and count as one. */
  lineageGroup?: string | null;
  ingestionRunId?: string | null;
}

/** Default usefulness windows by attribute, in minutes. Policy, not fact. */
export const DEFAULT_VALIDITY_MINUTES: Partial<Record<Attribute, number>> = {
  crowd_level: 30,
  queue: 20,
  open_state: 45,
};
