import { z } from "zod/v4";
import { Budget, LatLon, Option, TravelMode } from "./common.js";

/** GET /v1/areas — where OutRN works and what a request can ask for. */

export const Area = z.object({
  /** Stable slug, e.g. "les". Send it as `areaId`. */
  id: z.string().min(1),
  name: z.string(),
  /** IANA zone; format every time for this area in it. */
  timezone: z.string(),
  /** Used when a request leaves `travelMode` out. */
  defaultTravelMode: TravelMode,
  center: LatLon,
});
export type Area = z.infer<typeof Area>;

export const WindowOption = z.object({ minutes: z.int().min(1), label: z.string() });
export const TravelModeOption = z.object({ id: TravelMode, label: z.string() });
/** A budget choice; send its `budget` value in the request. */
export const BudgetOption = z.object({ id: z.string().min(1), label: z.string(), budget: Budget });

const Range = z.object({ min: z.int(), max: z.int() });

export const AreasResponse = z.object({
  areas: z.array(Area),
  defaultAreaId: z.string(),
  /**
   * The choices a request may use, with default labels. Build the search form from these: when the
   * backend adds a category or a mood it appears here, and requests using it are valid.
   */
  filters: z.object({
    windows: z.array(WindowOption),
    defaultWindowMinutes: z.int(),
    travelModes: z.array(TravelModeOption),
    budgets: z.array(BudgetOption),
    moods: z.array(Option),
    companies: z.array(Option),
    categories: z.array(Option),
    /** Cuisines a request may ask for (`cuisines`), each taking in its kinds: Japanese includes sushi and ramen. */
    cuisines: z.array(Option),
    /** Diets a request may ask for (`diets`): vegetarian, vegan, gluten-free, halal, kosher. */
    diets: z.array(Option),
    /** Must-haves a request may ask for (`features`): outdoor seating, wifi, wheelchair access. */
    features: z.array(Option),
    /** Interests a taste may weigh (`taste`): live music, comedy, art, the outdoors… Offer them as quick picks. */
    interests: z.array(Option),
  }),
  limits: z.object({
    windowMinutes: Range,
    youngestAge: Range,
    maxCategories: z.int(),
    /** Most cuisines a request may ask for (`cuisines`). */
    maxCuisines: z.int(),
    /** Most diets a request may ask for (`diets`). */
    maxDiets: z.int(),
    /** Most must-haves a request may ask for (`features`). */
    maxFeatures: z.int(),
    /** Most interests a taste may weigh (`taste`). */
    maxTaste: z.int(),
    /** Items per page of recommendations. */
    pageSize: z.int(),
  }),
});
export type AreasResponse = z.infer<typeof AreasResponse>;
