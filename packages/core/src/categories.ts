/**
 * Controlled category vocabulary. Every source taxonomy (OSM tags, Foursquare
 * categories, first-party JSON-LD @type) maps INTO this set; the engine and the
 * cards only ever see these values.
 *
 * Keep it small. A category earns its place by needing different feasibility
 * defaults or a different card treatment, not by being a nicer label.
 */
export const CATEGORIES = [
  "restaurant",
  "cafe",
  "bar",
  "dessert",
  "museum",
  "gallery",
  "theatre",
  "cinema",
  "live_music",
  "arts_centre",
  "community",
  "market",
  "park",
  "garden",
  "waterfront",
  "viewpoint",
  "attraction",
  "library",
  "bookshop",
  "bowling",
  "arcade",
  "nightclub",
  "activity",
  "other",
] as const;

export type Category = (typeof CATEGORIES)[number];

/** Broad activity type used by the diversity step. Three cards should span these. */
export const ACTIVITY_TYPES = ["food", "drink", "culture", "outdoors", "entertainment", "browse"] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

export const ACTIVITY_OF_CATEGORY: Record<Category, ActivityType> = {
  restaurant: "food",
  cafe: "food",
  dessert: "food",
  bar: "drink",
  museum: "culture",
  gallery: "culture",
  arts_centre: "culture",
  theatre: "entertainment",
  cinema: "entertainment",
  live_music: "entertainment",
  community: "culture",
  market: "browse",
  bookshop: "browse",
  library: "culture",
  park: "outdoors",
  garden: "outdoors",
  waterfront: "outdoors",
  viewpoint: "outdoors",
  attraction: "culture",
  bowling: "entertainment",
  arcade: "entertainment",
  activity: "entertainment",
  nightclub: "drink",
  other: "browse",
};

/**
 * Programme venues are visited through a dated occurrence (a screening, a show, a set, a community
 * centre's class or event), never as a flexible visit: a cinema with nothing on is not an option,
 * whatever its door hours say, and neither is a community centre at 1am.
 */
export const PROGRAMME_CATEGORIES: ReadonlySet<Category> = new Set<Category>(["cinema", "theatre", "live_music", "community"]);

export function isCategory(x: string): x is Category {
  return (CATEGORIES as readonly string[]).includes(x);
}
