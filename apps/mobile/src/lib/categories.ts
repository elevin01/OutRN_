/**
 * Category shortcuts and icons. A shortcut narrows the search to a few related kinds of place in one
 * tap; "All" clears it. Kinds the area doesn't offer are left out, and a shortcut with none is hidden.
 */

/** A MaterialCommunityIcons glyph name. */
export type CategoryIcon =
  | "compass-outline"
  | "silverware-fork-knife"
  | "coffee-outline"
  | "glass-cocktail"
  | "pine-tree"
  | "palette-outline"
  | "ticket-outline"
  | "bowling"
  | "bookshelf"
  | "ice-cream"
  | "music"
  | "bank-outline"
  | "drama-masks"
  | "movie-open-outline"
  | "music-note"
  | "account-group-outline"
  | "storefront-outline"
  | "flower-outline"
  | "waves"
  | "binoculars"
  | "star-outline"
  | "library"
  | "gamepad-variant-outline"
  | "run"
  | "calendar-star"
  | "map-marker-outline";

export interface CategoryGroup {
  id: string;
  label: string;
  icon: CategoryIcon;
  /** Category ids, at most the API's maxCategories (5). Empty for "All". */
  categories: string[];
}

export const CATEGORY_GROUPS: readonly CategoryGroup[] = [
  { id: "all", label: "All", icon: "compass-outline", categories: [] },
  { id: "food", label: "Food", icon: "silverware-fork-knife", categories: ["restaurant", "market"] },
  { id: "coffee", label: "Coffee & sweets", icon: "coffee-outline", categories: ["cafe", "dessert"] },
  { id: "drinks", label: "Drinks", icon: "glass-cocktail", categories: ["bar", "nightclub"] },
  { id: "outdoors", label: "Outdoors", icon: "pine-tree", categories: ["park", "garden", "waterfront", "viewpoint"] },
  { id: "culture", label: "Art & culture", icon: "palette-outline", categories: ["museum", "gallery", "arts_centre", "attraction", "library"] },
  { id: "shows", label: "Movies & shows", icon: "ticket-outline", categories: ["cinema", "theatre", "live_music"] },
  { id: "play", label: "Games & play", icon: "bowling", categories: ["bowling", "arcade", "activity"] },
  { id: "books", label: "Books", icon: "bookshelf", categories: ["bookshop"] },
];

const ICONS: Readonly<Record<string, CategoryIcon>> = {
  restaurant: "silverware-fork-knife",
  cafe: "coffee-outline",
  dessert: "ice-cream",
  bar: "glass-cocktail",
  nightclub: "music",
  museum: "bank-outline",
  gallery: "palette-outline",
  arts_centre: "drama-masks",
  theatre: "drama-masks",
  cinema: "movie-open-outline",
  live_music: "music-note",
  community: "account-group-outline",
  market: "storefront-outline",
  park: "pine-tree",
  garden: "flower-outline",
  waterfront: "waves",
  viewpoint: "binoculars",
  attraction: "star-outline",
  library: "library",
  bookshop: "bookshelf",
  bowling: "bowling",
  arcade: "gamepad-variant-outline",
  activity: "run",
  // A pop-up's own site (a band on the lawn, a street fair): shown only through what is happening there.
  event_site: "calendar-star",
};

/** The icon for a category id; a map pin for anything unknown. */
export function categoryIcon(categoryId: string): CategoryIcon {
  return Object.prototype.hasOwnProperty.call(ICONS, categoryId) ? ICONS[categoryId]! : "map-marker-outline";
}

/** The shortcuts this area can serve, each narrowed to the kinds it offers, within the API's limit. */
export function groupsFor(available: readonly { id: string }[], maxCategories: number): CategoryGroup[] {
  const offered = new Set(available.map((c) => c.id));
  return CATEGORY_GROUPS.map((g) => ({ ...g, categories: g.categories.filter((c) => offered.has(c)).slice(0, Math.max(1, maxCategories)) })).filter((g) => g.id === "all" || g.categories.length > 0);
}

/** Which shortcut a search's categories match exactly; "all" when none are set; null for a custom mix. */
export function activeGroup(groups: readonly CategoryGroup[], categories: readonly string[] | undefined): string | null {
  if (!categories?.length) return "all";
  const want = [...categories].sort().join(",");
  return groups.find((g) => g.id !== "all" && [...g.categories].sort().join(",") === want)?.id ?? null;
}
