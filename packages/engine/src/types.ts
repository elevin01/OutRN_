import type { Attribute, Category, EvidenceClass, LatLon, TravelEstimate, TravelMode } from "@outrn/core";

export const ENGINE_VERSION = "0.1.0";
export const WEIGHTS_VERSION = "2026-09-27.3";

export type Mood = "relaxed" | "active" | "food" | "culture";
export type Company = "alone" | "date" | "friends" | "family";

export interface RequestContext {
  origin: LatLon;
  now: Date;
  /** Free time from now, in minutes. Ignored when endAt is given. */
  windowMinutes?: number;
  /** Hard end of the window (user's deadline). */
  endAt?: Date;
  /** "Back by": the user must be back at origin by this time; return travel is subtracted. */
  backBy?: Date;
  mode: TravelMode;
  /** Max one-way travel, minutes. Defaults by mode. */
  maxTravelMinutes?: number;
  /** Drive parking buffer for this departure (from the area's parking rule). Default 8 min. */
  parkingBufferMinutes?: number;
  /** Per-person cap in USD, or "free". Missing = any. */
  budget?: number | "free";
  mood?: Mood;
  company?: Company;
  requireWheelchair?: boolean;
  /** Narrow to these categories (user tapped a chip). Diversity across activity types is skipped. */
  categories?: Category[];
  /** Items shown recently on this device, and items dismissed. */
  seenIds?: string[];
  dismissedIds?: string[];
  timezone: string;
  /** Weather at roughly the arrival hour, if a forecast is loaded. */
  weather?: { temperatureF: number; precipProbability: number | null } | null;
  sunset?: Date | null;
}

export interface FactView {
  value: unknown;
  confidence: number;
  evidenceClass: EvidenceClass;
  validUntil: Date | null;
  independentSources: number;
  /** Sources behind the winning value (current_facts.source_ids), e.g. ["founder"], ["osm"]. */
  sources?: string[];
  /** Disagreement inside the winning evidence class (current_facts.conflict). */
  conflict?: boolean;
  /** Latest verification of the winning value (founder check or observation); never a fetch time. */
  verifiedAt?: Date | null;
}

export interface OccurrenceView {
  id: string;
  title: string;
  start: Date;
  end: Date | null;
  entryCutoff: Date | null;
  lateEntry: boolean | null;
  status: "scheduled" | "cancelled" | "sold_out" | "ended";
}

export interface Candidate {
  kind: "venue" | "occurrence";
  /** Venue id for venues; occurrence id for occurrences. */
  id: string;
  venueId: string;
  name: string;
  category: Category;
  point: LatLon;
  timezone: string;
  facts: Partial<Record<Attribute, FactView>>;
  occurrence?: OccurrenceView;
  parentVenueId?: string | null;
  boost: number;
  excluded: boolean;
  hasLandmarkId: boolean;
  /** Chain brand from the source record (OSM `brand`), if any. */
  brand?: string | null;
}

export interface CategoryPolicy {
  category: string;
  minUsefulMinutes: number;
  admissionBufferMinutes: number;
  kitchenCloseOffsetMinutes: number | null;
  lastEntryDefaultMinutes: number | null;
  activityType: string;
}

export type ResultClass = "ready" | "check_first" | "ineligible";

export type ReasonCode =
  | "SHORT_TRAVEL"
  | "ENOUGH_TIME"
  | "OPEN_LATE"
  | "CLOSES_SOON"
  | "FITS_BUDGET"
  | "FREE"
  | "EVENT_STARTS_SOON"
  | "WEATHER_SUITABLE"
  | "SUNSET_WINDOW"
  | "LANDMARK"
  | "FRESH_REPORT"
  | "HOURS_UNVERIFIED"
  | "HOURS_UNKNOWN"
  | "HOURS_APPROXIMATE"
  | "ADMISSION_UNCONFIRMED"
  | "ADMISSION_UNKNOWN"
  | "TOUR_ONLY"
  | "PRICE_UNKNOWN"
  | "LATE_ENTRY_UNCERTAIN"
  | "ACCESS_LIMITED"
  | "WAIT_FOR_OPENING"
  | "HOURS_CONFIRMED";

export type ExclusionCode =
  | "CLOSED_PERMANENTLY"
  | "EXCLUDED_BY_OVERRIDE"
  | "NOT_REQUESTED"
  | "TOO_FAR"
  | "CLOSED_ON_ARRIVAL"
  | "NOT_ENOUGH_TIME"
  | "LAST_ENTRY_PASSED"
  | "EVENT_CANCELLED"
  | "EVENT_SOLD_OUT"
  | "EVENT_STARTED"
  | "EVENT_ENDS_AFTER_DEADLINE"
  | "OVER_BUDGET"
  | "NOT_FREE"
  | "ACCESS_UNKNOWN"
  | "NOT_ACCESSIBLE"
  | "DISMISSED"
  | "CHILD_OF_SHOWN_PARENT"
  | "NO_PROGRAMME";

export interface Timing {
  travel: TravelEstimate;
  departAt: Date;
  arrival: Date;
  latestArrival: Date | null;
  latestArrivalIsEstimate: boolean;
  latestFinish: Date;
  usefulMinutes: number;
  minUsefulMinutes: number;
  minUsefulIsEstimate: boolean;
  closesAt: Date | null;
  deadline: Date;
  returnTravel: TravelEstimate | null;
}

export interface Scores {
  evidence: number;
  fit: number;
  appeal: number;
  novelty: number;
}

export interface Evaluation {
  candidate: Candidate;
  class: ResultClass;
  excludedBy: ExclusionCode | null;
  reasons: ReasonCode[];
  unresolved: ReasonCode[];
  timing: Timing | null;
  scores: Scores;
  cta: "go" | "check" | "book" | null;
  price: { text: string; isEstimate: boolean; unknown: boolean };
}

export interface Shortlist {
  items: Evaluation[];
  /** Everything evaluated, for the "eligible right now" debug view. */
  all: Evaluation[];
  /** Position of items[0] in the display order ("More options" pages by offset). */
  offset: number;
  /** More eligible options exist after this page. */
  hasMore: boolean;
  fewerThanThree: boolean;
  /** Specific relaxations to offer when fewer than three qualify. */
  relaxations: string[];
  engineVersion: string;
  weightsVersion: string;
}
