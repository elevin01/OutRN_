import {
  mdiAccountGroupOutline, mdiBankOutline, mdiBinoculars, mdiBookshelf, mdiBowling, mdiCoffeeOutline, mdiCompassOutline, mdiDramaMasks,
  mdiFlowerOutline, mdiGamepadVariantOutline, mdiGlassCocktail, mdiIceCream, mdiLibrary, mdiMapMarkerOutline, mdiMovieOpenOutline, mdiMusic,
  mdiMusicNote, mdiPaletteOutline, mdiPineTree, mdiRun, mdiSilverwareForkKnife, mdiStarOutline, mdiStorefrontOutline, mdiTicketOutline, mdiWaves,
} from "@mdi/js";
import type { AreasResponse, Photo } from "@outrn/contracts";

/**
 * Category shortcuts, icons and representative photos: the same as the mobile app's
 * (apps/mobile/src/lib/categories.ts and representative.ts). A shortcut narrows the search to a few
 * related kinds of place in one click; kinds the area doesn't offer are left out.
 */

export interface CategoryGroup {
  id: string;
  label: string;
  icon: string;
  categories: string[];
}

const GROUPS: readonly CategoryGroup[] = [
  { id: "food", label: "Food", icon: mdiSilverwareForkKnife, categories: ["restaurant", "market"] },
  { id: "coffee", label: "Coffee & sweets", icon: mdiCoffeeOutline, categories: ["cafe", "dessert"] },
  { id: "drinks", label: "Drinks", icon: mdiGlassCocktail, categories: ["bar", "nightclub"] },
  { id: "outdoors", label: "Outdoors", icon: mdiPineTree, categories: ["park", "garden", "waterfront", "viewpoint"] },
  { id: "culture", label: "Art & culture", icon: mdiPaletteOutline, categories: ["museum", "gallery", "arts_centre", "attraction", "library"] },
  { id: "shows", label: "Movies & shows", icon: mdiTicketOutline, categories: ["cinema", "theatre", "live_music"] },
  { id: "play", label: "Games & play", icon: mdiBowling, categories: ["bowling", "arcade", "activity"] },
  { id: "books", label: "Books", icon: mdiBookshelf, categories: ["bookshop"] },
];

export const ALL_ICON = mdiCompassOutline;

const ICONS: Readonly<Record<string, string>> = {
  restaurant: mdiSilverwareForkKnife, cafe: mdiCoffeeOutline, dessert: mdiIceCream, bar: mdiGlassCocktail, nightclub: mdiMusic,
  museum: mdiBankOutline, gallery: mdiPaletteOutline, arts_centre: mdiDramaMasks, theatre: mdiDramaMasks, cinema: mdiMovieOpenOutline,
  live_music: mdiMusicNote, community: mdiAccountGroupOutline, market: mdiStorefrontOutline, park: mdiPineTree, garden: mdiFlowerOutline,
  waterfront: mdiWaves, viewpoint: mdiBinoculars, attraction: mdiStarOutline, library: mdiLibrary, bookshop: mdiBookshelf,
  bowling: mdiBowling, arcade: mdiGamepadVariantOutline, activity: mdiRun,
};

const own = <T,>(table: Readonly<Record<string, T>>, key: string): T | undefined => (Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined);

/** The icon's SVG path for a category id; a map pin for anything unknown. */
export function categoryIconPath(categoryId: string): string {
  return own(ICONS, categoryId) ?? mdiMapMarkerOutline;
}

/** The shortcuts this deployment can serve, each narrowed to the kinds it offers, within its limit. */
export function groupsFor(meta: AreasResponse): CategoryGroup[] {
  const offered = new Set(meta.filters.categories.map((c) => c.id));
  return GROUPS.map((g) => ({ ...g, categories: g.categories.filter((c) => offered.has(c)).slice(0, Math.max(1, meta.limits.maxCategories)) })).filter((g) => g.categories.length > 0);
}

/** The shortcut whose kinds are exactly these, if any. */
export function groupOf(groups: readonly CategoryGroup[], categories: readonly string[] | undefined): CategoryGroup | null {
  if (!categories?.length) return null;
  const want = [...categories].sort().join(",");
  return groups.find((g) => [...g.categories].sort().join(",") === want) ?? null;
}

export interface ShownPhoto {
  url: string;
  kind: "place" | "representative";
  credit: string;
  creditUrl: string | null;
  alt: string;
}

const unsplash = (file: string, id: string) => ({ url: `/representative/${file}`, credit: "Unsplash", creditUrl: `https://images.unsplash.com/${id}` });
const REPRESENTATIVE: Readonly<Record<string, readonly { url: string; credit: string; creditUrl: string }[]>> = {
  cafe: [unsplash("cafe.jpg", "photo-1554118811-1e0d58224f24"), unsplash("coffee.jpg", "photo-1509042239860-f550ce710b93")],
  dessert: [unsplash("pastry.jpg", "photo-1555507036-ab1f4038808a")],
  gallery: [unsplash("culture.jpg", "photo-1577720643272-265f09367456")],
  museum: [unsplash("culture.jpg", "photo-1577720643272-265f09367456")],
  arts_centre: [unsplash("culture.jpg", "photo-1577720643272-265f09367456")],
};

/**
 * The place's own photos, each with its credit; without any, representative photos of the kind of
 * place, labelled as such; without those, none (the card shows the category icon).
 */
/** Where the API's photos live: Wikimedia's image hosts, nowhere else. */
const PHOTO_HOSTS = /^(upload|thumb)\.wikimedia\.org$/;

/** An https address without credentials (optionally on one of `hosts`), else null. */
export function safeHttpsUrl(value: string | null | undefined, hosts?: RegExp): string | null {
  if (!value) return null;
  try {
    const u = new URL(value);
    return u.protocol === "https:" && !u.username && !u.password && (!hosts || hosts.test(u.hostname)) ? u.toString() : null;
  } catch {
    return null;
  }
}

/** "a café", "an arts centre". */
const withArticle = (kind: string) => `${/^[aeiou]/.test(kind) ? "an" : "a"} ${kind}`;

export function photosFor(name: string, category: { id: string; label: string }, photos: readonly Photo[] | undefined): ShownPhoto[] {
  // The payload is not trusted: only https images on Wikimedia's hosts load, and a credit links only
  // over https. A photo that fails the check is dropped; a credit that does is shown as plain text.
  const mine = (photos ?? []).flatMap((p, i): ShownPhoto[] => {
    const url = safeHttpsUrl(p.url, PHOTO_HOSTS);
    return url ? [{ url, kind: "place", credit: p.credit, creditUrl: safeHttpsUrl(p.sourceUrl), alt: p.alt ? `${name}: ${p.alt}` : `Photo ${i + 1} of ${name}` }] : [];
  });
  if (mine.length) return mine;
  return (own(REPRESENTATIVE, category.id) ?? []).map((r) => ({ ...r, kind: "representative", alt: `A representative photo of ${withArticle(category.label.toLowerCase())}, not ${name}` }));
}
