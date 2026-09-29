import type { ImageSourcePropType } from "react-native";
import type { RepresentativePhoto } from "./photos";

/**
 * Representative photos by category: shown only when a place has no photo of its own, always
 * labelled "Representative photo · not this place", with their credit. Bundled with the app (never
 * hotlinked). Sources and licenses: assets/photos/README.md. A category without an entry shows the
 * category artwork.
 */
const cafe = require("../../assets/photos/cafe.jpg");
const coffee = require("../../assets/photos/coffee.jpg");
const pastry = require("../../assets/photos/pastry.jpg");
const culture = require("../../assets/photos/culture.jpg");

const unsplash = (source: ImageSourcePropType, id: string): RepresentativePhoto<ImageSourcePropType> => ({
  source,
  credit: "Unsplash",
  url: `https://images.unsplash.com/${id}`,
});

const CAFE = unsplash(cafe, "photo-1554118811-1e0d58224f24");
const COFFEE = unsplash(coffee, "photo-1509042239860-f550ce710b93");
const PASTRY = unsplash(pastry, "photo-1555507036-ab1f4038808a");
const GALLERY = unsplash(culture, "photo-1577720643272-265f09367456");

const BY_CATEGORY: Readonly<Record<string, readonly RepresentativePhoto<ImageSourcePropType>[]>> = {
  cafe: [CAFE, COFFEE],
  dessert: [PASTRY],
  gallery: [GALLERY],
  museum: [GALLERY],
  arts_centre: [GALLERY],
};

export function representativePhotos(categoryId: string): readonly RepresentativePhoto<ImageSourcePropType>[] {
  return Object.prototype.hasOwnProperty.call(BY_CATEGORY, categoryId) ? BY_CATEGORY[categoryId]! : [];
}
