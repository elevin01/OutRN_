import { ownValue, type Category } from "@outrn/core";

/**
 * The one place OSM tags map into the controlled vocabulary. The Overpass query is built from
 * this table and normalization reads it, so a tag can never be mapped without being fetched
 * (or fetched without being mapped). Keys are checked in this order.
 */
export const OSM_TAG_CATEGORIES = {
  amenity: {
    restaurant: "restaurant", cafe: "cafe", bar: "bar", pub: "bar", biergarten: "bar", ice_cream: "dessert", food_court: "restaurant",
    theatre: "theatre", cinema: "cinema", arts_centre: "arts_centre", community_centre: "community",
    marketplace: "market", library: "library",
    nightclub: "nightclub", music_venue: "live_music", karaoke_box: "activity", casino: "activity",
  },
  tourism: { museum: "museum", gallery: "gallery", attraction: "attraction", viewpoint: "viewpoint", zoo: "attraction", aquarium: "attraction", theme_park: "attraction" },
  leisure: {
    park: "park", garden: "garden", nature_reserve: "park",
    bowling_alley: "bowling", amusement_arcade: "arcade", escape_game: "activity", miniature_golf: "activity", ice_rink: "activity",
  },
  shop: { books: "bookshop" },
  natural: { beach: "waterfront" },
} as const satisfies Record<string, Record<string, Category>>;

export type OsmCategoryKey = keyof typeof OSM_TAG_CATEGORIES;
export const OSM_CATEGORY_KEYS = Object.keys(OSM_TAG_CATEGORIES) as OsmCategoryKey[];

/** Tags that only mean something with a qualifier: a sports centre is a climbing gym only when sport says so. */
export const OSM_QUALIFIED_TAGS: readonly { key: string; value: string; qualifierKey: string; qualifierPattern: string; category: Category }[] = [
  { key: "leisure", value: "sports_centre", qualifierKey: "sport", qualifierPattern: "climbing", category: "activity" },
];

export function categoryFromOsmTags(tags: Record<string, string>): Category | null {
  for (const key of OSM_CATEGORY_KEYS) {
    const v = tags[key];
    const category = ownValue(OSM_TAG_CATEGORIES[key] as Record<string, Category>, v);
    if (category) return category;
  }
  for (const q of OSM_QUALIFIED_TAGS) {
    if (tags[q.key] === q.value && new RegExp(q.qualifierPattern).test(tags[q.qualifierKey] ?? "")) return q.category;
  }
  return null;
}

/** The kind within the category, from the deciding tag ("casino", "miniature_golf", "climbing"). */
export function subtypeFromOsmTags(tags: Record<string, string>): string | null {
  for (const key of OSM_CATEGORY_KEYS) {
    const v = tags[key];
    if (v && ownValue(OSM_TAG_CATEGORIES[key] as Record<string, Category>, v)) return v;
  }
  for (const q of OSM_QUALIFIED_TAGS) {
    if (tags[q.key] === q.value && new RegExp(q.qualifierPattern).test(tags[q.qualifierKey] ?? "")) return q.qualifierPattern;
  }
  return null;
}

/** The tag that decided the category, as evidence text ("leisure=bowling_alley"). */
export function categoryEvidence(tags: Record<string, string>): string | null {
  for (const key of OSM_CATEGORY_KEYS) {
    const v = tags[key];
    if (v && ownValue(OSM_TAG_CATEGORIES[key] as Record<string, Category>, v)) return `${key}=${v}`;
  }
  for (const q of OSM_QUALIFIED_TAGS) {
    if (tags[q.key] === q.value && new RegExp(q.qualifierPattern).test(tags[q.qualifierKey] ?? "")) return `${q.key}=${q.value} + ${q.qualifierKey}=${tags[q.qualifierKey]}`;
  }
  return null;
}
