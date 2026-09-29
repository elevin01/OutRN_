import type { Attribute, Category, EvidenceClass, LatLon, TravelEstimate, TravelMode } from "@outrn/core";

export const ENGINE_VERSION = "0.5.0";
export const WEIGHTS_VERSION = "2026-09-29.2";

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
  /**
   * Age of the youngest person going. Age limits are a gate against it. With company "family" and no
   * age given, the party is assumed to include a minor of unknown age.
   */
  youngestAge?: number;
  /** Narrow to these categories (user tapped a chip). Diversity across activity types is skipped. */
  categories?: Category[];
  /** Only food places serving one of these (CUISINE_FILTERS ids). Diversity across activity types is skipped. */
  cuisines?: string[];
  /** How the user wants to eat, for food places: to go is quick. Missing = sitting down. */
  visitStyle?: "dine_in" | "takeout";
  /** Items shown recently on this device, and items dismissed. */
  seenIds?: string[];
  dismissedIds?: string[];
  timezone: string;
  /**
   * The forecast over the start of the plan (see weatherFor), if one is loaded: the lowest and
   * highest temperature, the chance of rain when it is known for all of it, and the span it read.
   */
  weather?: { temperatureF: number; precipProbability: number | null; highF?: number; from?: Date; until?: Date } | null;
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

/** Public parking near a venue: where a drive plan leaves the car. */
export interface NearbyParking {
  name: string | null;
  kind: "lot" | "garage" | "street";
  fee: "free" | "paid" | "unknown";
  point: LatLon;
  /** Straight line to the venue. */
  distanceM: number;
  walkMinutes: number;
  /** OSM opening_hours as the lot lists them; null when it lists none. */
  openingHours: string | null;
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
  /** The venue's own name. For an occurrence `name` is the event title; this is where it happens. */
  venueName?: string;
  /** Public parking within a short walk, nearest first (loaded for drive requests). */
  parkingOptions?: NearbyParking[];
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
  | "HOURS_CONFIRMED"
  | "AGE_LIMIT_LIKELY"
  | "AGE_LIMIT_UNCERTAIN"
  | "WAIT_MAY_NOT_FIT"
  /** A bar that serves food, with children in the party: no age limit is known, but it's a bar first. */
  | "KIDS_UNCERTAIN"
  /** A cinema, theatre or music venue with nothing listed here: see what's on on its own site. */
  | "PROGRAMME_UNLISTED"
  /** Outdoors, and the forecast gives rain a 50% chance or more over the start of the plan. */
  | "RAIN_LIKELY";

export type ExclusionCode =
  | "CLOSED_PERMANENTLY"
  | "CLOSED_TEMPORARILY"
  | "EXCLUDED_BY_OVERRIDE"
  | "NOT_REQUESTED"
  | "OTHER_CUISINE"
  | "TOO_FAR"
  | "CLOSED_ON_ARRIVAL"
  | "NOT_ENOUGH_TIME"
  | "LAST_ENTRY_PASSED"
  | "KITCHEN_CLOSED"
  | "TAKEOUT_ONLY"
  | "NO_TAKEOUT"
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
  | "NO_PROGRAMME"
  | "AGE_RESTRICTED"
  | "MEMBERS_ONLY";

/** How a visit is done, what it needs at least, and how long it typically takes. */
export interface Visit {
  style: "dine_in" | "counter" | "takeout" | "visit" | "event";
  /** The minimum the engine required for the visit to be worthwhile. */
  minMinutes: number;
  /** How long people typically spend; never less than the minimum. */
  typicalMinutes: number;
  isEstimate: boolean;
}

export interface TimingBase {
  travel: TravelEstimate;
  departAt: Date;
  arrival: Date;
  latestArrival: Date | null;
  latestArrivalIsEstimate: boolean;
  /** What `latestArrival` is: last orders (kitchen), last entry, or an event's entry cutoff. */
  latestArrivalKind: "last_order" | "last_entry" | "event_entry" | null;
  latestFinish: Date;
  usefulMinutes: number;
  minUsefulMinutes: number;
  minUsefulIsEstimate: boolean;
  closesAt: Date | null;
  deadline: Date;
  returnTravel: TravelEstimate | null;
  /**
   * Drive only: minutes of `travel` allowed for parking, and where: the nearest public parking that
   * is open from parking until the car is collected (null: none nearby is known to be).
   */
  parkingMinutes: number | null;
  parking: NearbyParking | null;
}

/**
 * What to expect there at the arrival: how busy it is and whether there is a wait. Basis "typical" is
 * a prior for this kind of place at that day and hour, never a claim about the venue; "report" is a
 * fresh observation of it.
 */
export interface Condition {
  kind: "crowd" | "wait" | "weather";
  /** crowd: quiet, moderate, busy. wait: none, short (up to 15 min), long. weather: rain, cold, hot, fair. */
  level: "quiet" | "moderate" | "busy" | "none" | "short" | "long" | "rain" | "cold" | "hot" | "fair";
  /** typical: usual for the kind of place; report: a recent report of the place; forecast: the weather service's. */
  basis: "typical" | "report" | "forecast";
  isEstimate: boolean;
  /** What it may cost, as a range (a wait for a table: 15–30). Null when there is no estimate. */
  minutes: { min: number; max: number } | null;
  /** When the report was made (basis "report"). */
  reportedAt: Date | null;
  /** Default wording, sentence case. */
  text: string;
  /** Weather only: the chance of rain (percent), when the forecast gives one for the whole span. */
  chance?: number;
  /** Weather only: the words for a caveat or the fact line, e.g. "70% chance of rain between 3 and 5pm", "down to 35°F". */
  brief?: string;
}

export interface Timing extends TimingBase {
  visit: Visit;
  /** Crowd first, then any wait. Empty when nothing is known or usual for this kind of place. */
  conditions: Condition[];
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
  /** How good an idea this kind of place is at the arrival (null: no rule, or ineligible). */
  dayPart?: "prime" | "fair" | "off" | null;
}

/** A specific change that would admit more options: "allow a longer walk" (+4). */
export interface Relaxation {
  /** Stable id, e.g. "longer_travel". */
  code: string;
  /** Default wording, lower case so it reads inside a sentence. */
  text: string;
  /** How many currently excluded candidates this change alone would admit. */
  admits: number;
}

export interface Shortlist {
  items: Evaluation[];
  /** Everything evaluated, for the "eligible right now" debug view. */
  all: Evaluation[];
  /** Every eligible candidate in display order, up to the deepest page served. Pages are slices of this. */
  ordered: Evaluation[];
  /** Position of items[0] in the display order ("More options" pages by offset). */
  offset: number;
  /** More eligible options exist after this page (and within the served page limit). */
  hasMore: boolean;
  /** Offset of the next page, or null. Callers link to this rather than computing it. */
  nextOffset: number | null;
  fewerThanThree: boolean;
  /** Specific relaxations to offer when fewer than three qualify. */
  relaxations: Relaxation[];
  engineVersion: string;
  weightsVersion: string;
}
