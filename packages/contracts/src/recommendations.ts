import { z } from "zod/v4";
import { AgeLimit, Budget, IsoDateTime, LatLon, NearbyParking, Note, Option, Photo, Price, TravelMode, VenueLink } from "./common.js";

/** POST /v1/recommendations — a short, ordered list of things that fit the time the user has. */

/** A new search. Unknown fields are rejected. */
/** One interest's weight in a taste: -1 skip, 0 no view, 1 love. */
export const TasteWeight = z.strictObject({
  interest: z.string().min(1).max(40),
  weight: z.number().min(-1).max(1),
});
export type TasteWeight = z.infer<typeof TasteWeight>;

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
  /**
   * Only food places serving one of these (AreasResponse.filters.cuisines ids): "japanese" finds
   * sushi bars and ramen shops too. With `categories`, only those of them that serve food.
   */
  cuisines: z.array(z.string().min(1)).max(5).optional(),
  /**
   * Only food places known to serve every one of these (AreasResponse.filters.diets ids): a vegan and
   * a gluten-free diner eat together. Places whose record says nothing are not options.
   */
  diets: z.array(z.string().min(1)).max(5).optional(),
  /**
   * Only places whose record states every one of these (AreasResponse.filters.features ids): tables
   * outside, wifi, wheelchair access (step-free; "limited" access is Check first).
   */
  features: z.array(z.string().min(1)).max(3).optional(),
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
  /**
   * For food places: "takeout" plans a quick stop to order and collect (about 15 minutes), and
   * leaves out places that do not do takeout. Omit to sit down; takeout-only counters are then left out.
   */
  visitStyle: z.enum(["dine_in", "takeout"]).optional(),
  /**
   * What this person likes and skips: weights from -1 (skip) to 1 (love) for interests
   * (AreasResponse.filters.interests ids), kept on the device and sent with each search. Ranking only:
   * a taste never hides a place. Ids not offered are ignored, so a stored profile outlives a change to
   * the list; `request.taste` in the response lists what was applied. An id may appear once.
   */
  taste: z.array(TasteWeight).max(32).optional(),
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
  /** The request's `cuisines`, or none. */
  cuisines: z.array(z.string()),
  /** The request's `diets`, or none. */
  diets: z.array(z.string()),
  /** The request's `features`, or none. */
  features: z.array(z.string()),
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
  /** The request's `visitStyle`, or "dine_in". */
  visitStyle: z.enum(["dine_in", "takeout"]),
  /** The taste applied: the request's weights for offered interests, without zeros, and without a like of drinks or nightlife when a minor is in the party. */
  taste: z.array(TasteWeight),
});
export type ResolvedRequest = z.infer<typeof ResolvedRequest>;

export const Travel = z.object({
  mode: TravelMode,
  minutes: z.int().min(0),
  /** Straight-line estimates today; routed times later. Show as "~12 min". */
  isEstimate: z.boolean(),
  /**
   * Minutes of `minutes` allowed for parking (drive only): finding a space and, when `parking` is
   * known, at least the walk from it.
   */
  parkingMinutes: z.int().min(0).nullable(),
});

/**
 * What the visit takes. Show `typicalMinutes` as "takes about 1h20": how long it usually takes, not
 * a limit on the user's time. The engine already checked that at least `minMinutes` fit.
 */
export const Visit = z.object({
  /** "dine_in" | "counter" | "takeout" | "visit" | "event". Open-ended: fall back to `label`. */
  style: z.string().min(1),
  /** "Sit-down meal", "Counter service", "Takeout", "Visit", "Event". */
  label: z.string(),
  minMinutes: z.int().min(0),
  typicalMinutes: z.int().min(0),
  /** False only for an event with a published end. */
  isEstimate: z.boolean(),
});
export type Visit = z.infer<typeof Visit>;

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
  visit: Visit,
});
export type Timing = z.infer<typeof Timing>;

/**
 * One step of the plan, in order: leave, park, arrive, order by or last entry, wrap up, be back.
 * `kind` is open-ended ("leave", "park", "arrive", "event_starts", "order_by", "last_entry",
 * "entry_by", "wrap_up", "back_by"); `text` is the default wording.
 */
export const PlanStep = z.object({
  kind: z.string().min(1),
  at: IsoDateTime,
  /** True when the time rests on an estimate (travel; a guessed last entry). Show "~7:42pm". */
  isEstimate: z.boolean(),
  text: z.string(),
});
export type PlanStep = z.infer<typeof PlanStep>;

/**
 * What to expect there at the arrival. Render `text`; style `kind` and `level` when you know them.
 * Basis "typical" is what's usual for this kind of place at that day and hour (an estimate, never a
 * claim about the place: show it as "usually"); "report" is a recent report of the place itself,
 * used only while it is still valid at the arrival.
 */
export const Condition = z.object({
  /** "crowd" | "wait". Open-ended (traffic, transit and weather may follow): fall back to `text`. */
  kind: z.string().min(1),
  /** crowd: "quiet" | "moderate" | "busy". wait: "none" | "short" (up to 15 min) | "long". Open-ended. */
  level: z.string().min(1),
  /** "typical" | "report". Open-ended. */
  basis: z.string().min(1),
  isEstimate: z.boolean(),
  /** What it may cost, as a range: a wait for a table is usually 15–30 minutes. Null when unknown. */
  minutes: z.object({ min: z.int().min(0), max: z.int().min(0) }).nullable(),
  /** When it was reported (basis "report"), if known. */
  reportedAt: IsoDateTime.nullable(),
  /** "Places like this are usually busy on Friday evenings", "Reported a short line at 7:12pm". */
  text: z.string(),
});
export type Condition = z.infer<typeof Condition>;

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
  /** "~12 min walk · takes about 1h20 · ~15–30 min wait · until 10pm · $15–35" */
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
  /** Up to 3 photos of the place, lead first. Empty when none is known: show the category's artwork. */
  photos: z.array(Photo).max(3),
  category: Option,
  subtype: Option.nullable(),
  /**
   * What a food place serves, as its map entry lists it (or, without one, as its name says: "Joe's
   * Pizza"), lead first, at most 3: `{ id: "thai", label: "Thai" }`. Empty when unknown, and for
   * places that are not about food.
   */
  cuisines: z.array(Option).max(3),
  /**
   * What a food place serves for diets, as its record says ("Vegan" for a vegan place, "Vegan options"
   * where there are some). Empty when unknown, and for places that are not about food.
   */
  diets: z.array(Option).max(5),
  /** Must-haves the place's record states: `outdoor_seating`, `wifi`, `wheelchair` (step-free). */
  features: z.array(Option).max(3),
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
  /** The plan behind the card as timed steps; always starts with "leave" and "arrive". */
  plan: z.array(PlanStep),
  /** How busy it is and any wait, at the arrival: crowd first, then wait. Empty when nothing is known. */
  conditions: z.array(Condition),
  /**
   * Drive plans only: the nearest public parking within a short walk, where the plan leaves the
   * car. Null when not driving, or when none is known nearby (the plan then allows the area's usual
   * time to find a space).
   */
  parking: NearbyParking.nullable(),
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
    /** The place's own pages (Instagram, Facebook, menu), when OSM lists them. */
    links: z.array(VenueLink),
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
