import { ownValue } from "./lookup.js";

/**
 * What a place serves, as OSM `cuisine=*` slugs ("italian;pizza"). Stored as written, so a better
 * grouping below never needs a re-ingest; grouped only when the engine asks whether two places
 * serve the same kind of food.
 */

/** At most this many cuisines are kept per place; the first ones are the ones a mapper leads with. */
export const MAX_CUISINES = 8;
const SLUG = /^[a-z0-9_]{2,40}$/;

/** `cuisine=Italian; pizza, Tex-Mex` → ["italian", "pizza", "tex_mex"]. Anything that isn't a slug is dropped. */
export function cuisineSlugs(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const part of raw.split(/[;,]/)) {
    const s = part.trim().toLowerCase().replace(/[\s-]+/g, "_");
    if (SLUG.test(s) && !out.includes(s)) out.push(s);
    if (out.length === MAX_CUISINES) break;
  }
  return out;
}

/**
 * Cuisines a diner would call the same kind of food: an Italian place then a pizzeria is a repeat,
 * a sushi bar then a ramen shop is a repeat. Unlisted slugs are their own group.
 */
const GROUP: Readonly<Record<string, string>> = {
  pizza: "italian", pasta: "italian", italian_pizza: "italian", neapolitan: "italian", trattoria: "italian",
  sushi: "japanese", ramen: "japanese", udon: "japanese", soba: "japanese", izakaya: "japanese", yakitori: "japanese", tempura: "japanese", donburi: "japanese",
  dim_sum: "chinese", dumpling: "chinese", dumplings: "chinese", szechuan: "chinese", sichuan: "chinese", cantonese: "chinese", hunan: "chinese", shanghai: "chinese", hot_pot: "chinese",
  burger: "american", diner: "american", hot_dog: "american", wings: "american", chicken: "american", fried_chicken: "american", steak_house: "american", barbecue: "american", bbq: "american",
  tacos: "mexican", taco: "mexican", tex_mex: "mexican", burrito: "mexican",
  coffee: "coffee_shop", espresso: "coffee_shop", cafe: "coffee_shop",
  ice_cream: "dessert", gelato: "dessert", frozen_yogurt: "dessert", cake: "dessert", cupcake: "dessert", donut: "dessert", doughnut: "dessert", waffle: "dessert", crepe: "dessert", chocolate: "dessert",
  lebanese: "middle_eastern", israeli: "middle_eastern", falafel: "middle_eastern", kebab: "middle_eastern", shawarma: "middle_eastern", syrian: "middle_eastern",
  korean_bbq: "korean",
  pho: "vietnamese", banh_mi: "vietnamese",
  south_indian: "indian", north_indian: "indian",
  deli: "sandwich", sandwiches: "sandwich",
  brunch: "breakfast",
  fish: "seafood", oyster: "seafood", oysters: "seafood", fish_and_chips: "seafood",
  bagels: "bagel",
  tapas: "spanish",
};

/** The groups a place's cuisines fall in: ["italian", "pizza"] → {"italian"}. */
export function cuisineGroups(slugs: readonly string[]): Set<string> {
  return new Set(slugs.map((s) => ownValue(GROUP, s) ?? s));
}
