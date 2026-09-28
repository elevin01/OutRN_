import { z } from "zod/v4";
import { AgeLimit, Budget, IsoDateTime, LatLon, Note, Option, Price, TravelMode } from "./common.js";

/** POST /v1/recommendations — a short, ordered list of things that fit the time the user has. */

/** A new search. Unknown fields are rejected. */
export const RecommendationRequest = z.strictObject({
  areaId: z.string().min(1),
  /** Free time from `at`, in minutes. */
  windowMinutes: z.int().min(30).max(480),
  /** Omit for the area's default. */
  travelMode: TravelMode.optional(),
  /** Omit for any budget. */
  budget: Budget.optional(),
  /** One of AreasResponse.filters.moods. */
  mood: z.string().min(1).optional(),
  /** One of AreasResponse.filters.companies. */
  company: z.string().min(1).optional(),
  /** Age of the youngest person going. Age limits are checked against it. */
  youngestAge: z.int().min(0).max(120).optional(),
  /** Narrow to these AreasResponse.filters.categories ids. */
  categories: z.array(z.string().min(1)).max(5).optional(),
  /** Plan for this instant instead of now. */
  at: IsoDateTime.optional(),
  /**
   * Where the user is. Travel is planned from here instead of the area's center. The API rounds it
   * to ~100 m before using or storing it; it must be inside the area.
   */
  origin: LatLon.optional(),
  /** Be back where you started by this instant: the return trip counts against the plan. */
  backBy: IsoDateTime.optional(),
  /** Item ids (RecommendationItem.id, a UUID) this device showed recently. Ranked lower, never hidden. */
  seenIds: z.array(z.uuid()).max(200).optional(),
  /** Item ids (RecommendationItem.id, a UUID) the user dismissed. Never shown. */
  dismissedIds: z.array(z.uuid()).max(200).optional(),
});
export type RecommendationRequest = z.infer<typeof RecommendationRequest>;

/** Another page of an earlier search: pass a `nextCursor` or `prevCursor` exactly as received. */
export const PageRequest = z.strictObject({ cursor: z.string().min(1) });
export type PageRequest = z.infer<typeof PageRequest>;

export const RecommendationsBody = z.union([RecommendationRequest, PageRequest]);
export type RecommendationsBody = z.infer<typeof RecommendationsBody>;

/** The request as the backend applied it: every default filled in. */
export const ResolvedRequest = z.object({
  areaId: z.string(),
  windowMinutes: z.int(),
  travelMode: TravelMode,
  /** True when `travelMode` came from the area default rather than the request. */
  travelModeIsDefault: z.boolean(),
  budget: Budget,
  mood: z.string().nullable(),
  company: z.string().nullable(),
  youngestAge: z.int().nullable(),
  categories: z.array(z.string()),
  /** The instant planned for (the request's `at`, or when it arrived). */
  at: IsoDateTime,
  /** True when the request gave `at` explicitly. */
  atIsExplicit: z.boolean(),
  /** Where travel is planned from: the request's `origin` (rounded), or the area's center. */
  origin: LatLon,
  /** True when `origin` is the area's center because the request gave none. */
  originIsDefault: z.boolean(),
  /** The request's `backBy`, if any. */
  backBy: IsoDateTime.nullable(),
});
export type ResolvedRequest = z.infer<typeof ResolvedRequest>;

export const Travel = z.object({
  mode: TravelMode,
  minutes: z.int().min(0),
  /** Straight-line estimates today; routed times later. Show as "~12 min". */
  isEstimate: z.boolean(),
  /** Minutes of `minutes` allowed for parking (drive only). */
  parkingMinutes: z.int().min(0).nullable(),
});

export const Timing = z.object({
  travel: Travel,
  leaveAt: IsoDateTime,
  arriveAt: IsoDateTime,
  /** Time there that actually counts, after entry buffers. */
  usefulMinutes: z.int().min(0),
  /** When the visit has to end: closing, the event's end, or the end of the user's window. */
  finishBy: IsoDateTime,
  /** Closing time, when known. */
  closesAt: IsoDateTime.nullable(),
});
export type Timing = z.infer<typeof Timing>;

export const EventTimes = z.object({
  startsAt: IsoDateTime,
  endsAt: IsoDateTime.nullable(),
  /** Last admission, when the source gives one. */
  entryCutoffAt: IsoDateTime.nullable(),
  lateEntry: z.boolean().nullable(),
});

/**
 * The backend's suggested card text. Rendering it verbatim reproduces today's cards; the structured
 * fields next to it carry the same meaning for a UI that composes its own.
 */
export const CardCopy = z.object({
  /** "~12 min walk · until 10pm, you'd have 1h40 · $15–35" */
  summary: z.string(),
  /** "A short walk, plenty of time, free." */
  sentence: z.string().nullable(),
  /** "Check first: hours not listed" — present whenever `caveats` is non-empty. */
  caveat: z.string().nullable(),
  /** "Go now" | "Check first" | "Book" */
  action: z.string(),
});

export const RecommendationItem = z.object({
  /** Stable id of this option (a place, or a scheduled event). */
  id: z.string().min(1),
  kind: z.enum(["venue", "event"]),
  /** The place's id, for GET /v1/places/:id. For an event, where it happens. */
  placeId: z.string().min(1),
  /** The place's name, or the event's title. */
  name: z.string(),
  /** The place's name (equal to `name` for a venue). */
  placeName: z.string(),
  category: Option,
  subtype: Option.nullable(),
  /**
   * `ready`: everything that matters checks out. `check_first`: worth going, but something in
   * `caveats` needs checking. Never recompute or upgrade this in the UI.
   */
  status: z.enum(["ready", "check_first"]),
  callToAction: z.enum(["go", "check", "book"]),
  location: LatLon,
  /** Present for kind "event". */
  event: EventTimes.nullable(),
  timing: Timing,
  price: Price,
  /** Must be shown when present. */
  ageLimit: AgeLimit.nullable(),
  /** Why it is a good option, strongest first. */
  reasons: z.array(Note),
  /** What to check before going. All are required; each explains `check_first`. */
  caveats: z.array(Note),
  copy: CardCopy,
  actions: z.object({
    /** Directions from the area in the item's travel mode. */
    directionsUrl: z.url(),
    websiteUrl: z.url().nullable(),
    phone: z.string().nullable(),
  }),
});
export type RecommendationItem = z.infer<typeof RecommendationItem>;

/** A specific change that would admit more options, e.g. "allow a longer walk" (+4). */
export const Relaxation = z.object({
  code: z.string().min(1),
  text: z.string(),
  admits: z.int().min(1),
});
export type Relaxation = z.infer<typeof Relaxation>;

export const RecommendationResponse = z.object({
  /**
   * Identifies this search. Every page of it shares the id and the same frozen result list, so
   * paging never reshuffles or repeats options.
   */
  requestId: z.uuid(),
  /** The instant the plans are computed for (== request.at). */
  asOf: IsoDateTime,
  /** When the result list was computed. */
  generatedAt: IsoDateTime,
  /** Cursors stop working after this; the plans' times would be stale. */
  expiresAt: IsoDateTime,
  area: z.object({ id: z.string(), name: z.string(), timezone: z.string() }),
  request: ResolvedRequest,
  items: z.array(RecommendationItem),
  page: z.object({
    /** Position of items[0] in the full list. */
    offset: z.int().min(0),
    size: z.int().min(1),
    nextCursor: z.string().nullable(),
    prevCursor: z.string().nullable(),
  }),
  /**
   * Set on the first page when fewer than `wanted` options qualify. The answer is never padded;
   * offer the relaxations instead.
   */
  insufficient: z
    .object({
      found: z.int().min(0),
      wanted: z.int().min(1),
      relaxations: z.array(Relaxation),
    })
    .nullable(),
  /** Credits the data sources require wherever their data is shown, e.g. "© OpenStreetMap contributors". */
  attributions: z.array(z.string()),
});
export type RecommendationResponse = z.infer<typeof RecommendationResponse>;
