import type { Category } from "./categories.js";
import { ownValue } from "./lookup.js";

/**
 * What a place serves, as OSM `cuisine=*` slugs ("italian;pizza"). Stored as written, so a better
 * grouping below never needs a re-ingest; grouped only when the engine asks whether two places
 * serve the same kind of food.
 */

/** Kinds of place whose cuisine says what they serve (a bar's is its kitchen's). */
export const CUISINE_CATEGORIES: ReadonlySet<Category> = new Set<Category>(["restaurant", "cafe", "dessert", "bar"]);

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

/**
 * Cuisines a search can ask for, each with the cuisines it takes in: asking for Japanese finds sushi
 * bars and ramen shops too, asking for sushi finds only places that list it. Policy, not fact.
 */
export const CUISINE_FILTERS: Readonly<Record<string, { label: string; members: readonly string[] }>> = {
  pizza: { label: "Pizza", members: ["pizza", "italian_pizza", "neapolitan"] },
  italian: { label: "Italian", members: ["italian", "pizza", "italian_pizza", "neapolitan", "pasta", "trattoria"] },
  chinese: { label: "Chinese", members: ["chinese", "dim_sum", "dumpling", "dumplings", "szechuan", "sichuan", "cantonese", "hunan", "shanghai", "hot_pot", "hotpot"] },
  japanese: { label: "Japanese", members: ["japanese", "sushi", "ramen", "udon", "soba", "izakaya", "yakitori", "tempura", "donburi"] },
  sushi: { label: "Sushi", members: ["sushi"] },
  ramen: { label: "Ramen", members: ["ramen"] },
  mexican: { label: "Mexican", members: ["mexican", "tacos", "taco", "tex_mex", "burrito"] },
  thai: { label: "Thai", members: ["thai"] },
  indian: { label: "Indian", members: ["indian", "south_indian", "north_indian"] },
  korean: { label: "Korean", members: ["korean", "korean_bbq"] },
  vietnamese: { label: "Vietnamese", members: ["vietnamese", "pho", "banh_mi"] },
  american: { label: "American", members: ["american", "burger", "diner", "barbecue", "bbq", "steak_house", "wings", "hot_dog"] },
  burger: { label: "Burgers", members: ["burger"] },
  french: { label: "French", members: ["french"] },
  greek: { label: "Greek", members: ["greek"] },
  mediterranean: { label: "Mediterranean", members: ["mediterranean", "greek"] },
  middle_eastern: { label: "Middle Eastern", members: ["middle_eastern", "lebanese", "israeli", "falafel", "kebab", "shawarma", "syrian", "turkish", "persian"] },
  seafood: { label: "Seafood", members: ["seafood", "fish", "oyster", "oysters", "fish_and_chips"] },
  spanish: { label: "Spanish and tapas", members: ["spanish", "tapas"] },
  caribbean: { label: "Caribbean", members: ["caribbean", "jamaican", "cuban", "dominican", "puerto_rican", "trinidadian", "haitian"] },
  latin_american: { label: "Latin American", members: ["latin_american", "peruvian", "colombian", "venezuelan", "argentinian", "brazilian", "salvadoran", "ecuadorian"] },
  breakfast: { label: "Breakfast and brunch", members: ["breakfast", "brunch"] },
  bagel: { label: "Bagels", members: ["bagel", "bagels"] },
  sandwich: { label: "Sandwiches and delis", members: ["sandwich", "sandwiches", "deli"] },
};

/** Whether a place serving these cuisines is one of those asked for (CUISINE_FILTERS ids). */
export function cuisineMatches(requested: readonly string[], slugs: readonly string[]): boolean {
  return requested.some((r) => {
    const members = ownValue(CUISINE_FILTERS, r)?.members;
    return members ? slugs.some((s) => members.includes(s)) : false;
  });
}

/** Slugs whose words need more than a capital letter: "tex_mex" is "Tex-Mex", not "Tex mex". */
const LABEL: Readonly<Record<string, string>> = {
  tex_mex: "Tex-Mex", bbq: "BBQ", korean_bbq: "Korean BBQ", italian_pizza: "Pizza", coffee_shop: "Coffee", middle_eastern: "Middle Eastern",
  latin_american: "Latin American", south_indian: "South Indian", north_indian: "North Indian", puerto_rican: "Puerto Rican", steak_house: "Steakhouse",
  hot_pot: "Hot pot", hotpot: "Hot pot", dim_sum: "Dim sum", banh_mi: "Banh mi", fish_and_chips: "Fish and chips", eastern_european: "Eastern European",
  south_american: "South American", north_african: "North African", west_african: "West African", east_african: "East African",
};

/** "thai" → "Thai", "bubble_tea" → "Bubble tea", "tex_mex" → "Tex-Mex": a cuisine as a card shows it. */
export function cuisineLabel(slug: string): string {
  const own = ownValue(LABEL, slug);
  if (own) return own;
  const t = slug.replace(/_/g, " ");
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** Words in a name that say what a place serves, most specific first ("korean bbq" before "korean"). */
const NAME_CUISINE: readonly [RegExp, string][] = [
  [/\bkorean (bbq|barbecue)\b/, "korean_bbq"],
  [/\b(pizza|pizzas|pizzeria)\b/, "pizza"],
  [/\bitalian ices?\b/, "italian_ice"],
  [/\b(trattoria|osteria|ristorante|italian|italiano|italiana|enoteca)\b/, "italian"],
  [/\bpasta\b/, "pasta"],
  [/\b(sushi|omakase)\b/, "sushi"],
  [/\bramen\b/, "ramen"],
  [/\b(izakaya|japanese|yakitori|udon|soba)\b/, "japanese"],
  [/\b(taqueria|tacos?|burritos?|mexican|mexicana|mexicano)\b/, "mexican"],
  [/\bthai\b/, "thai"],
  [/\b(pho|banh mi|vietnamese)\b/, "vietnamese"],
  [/\bdim sum\b/, "dim_sum"],
  [/\bdumplings?\b/, "dumpling"],
  [/\bhot ?pot\b/, "hot_pot"],
  [/\b(szechuan|sichuan)\b/, "sichuan"],
  [/\b(chinese|hunan|shanghai|cantonese|hong kong)\b/, "chinese"],
  [/\btaiwanese\b/, "taiwanese"],
  [/\b(indian|tandoor|tandoori|masala|biryani|dosa)\b/, "indian"],
  [/\bkorean\b/, "korean"],
  [/\b(bbq|barbecue|barbeque|smokehouse)\b/, "barbecue"],
  [/\bburgers?\b/, "burger"],
  [/\bsteak ?house\b/, "steak_house"],
  [/\bdiner\b/, "diner"],
  [/\b(french|brasserie|bistrot)\b/, "french"],
  [/\b(greek|gyro|gyros|souvlaki)\b/, "greek"],
  [/\bmediterranean\b/, "mediterranean"],
  [/\bmiddle eastern\b/, "middle_eastern"],
  [/\blebanese\b/, "lebanese"],
  [/\bturkish\b/, "turkish"],
  [/\bpersian\b/, "persian"],
  [/\bfalafel\b/, "falafel"],
  [/\bshawarma\b/, "shawarma"],
  [/\b(kebab|kebabs|kabob|kabobs)\b/, "kebab"],
  [/\b(seafood|oyster|oysters|lobster)\b/, "seafood"],
  [/\btapas\b/, "tapas"],
  [/\bspanish\b/, "spanish"],
  [/\bcaribbean\b/, "caribbean"],
  [/\bjamaican\b/, "jamaican"],
  [/\b(cuban|cubana|cubano)\b/, "cuban"],
  [/\bdominican\b/, "dominican"],
  [/\bpuerto rican\b/, "puerto_rican"],
  [/\bhaitian\b/, "haitian"],
  [/\bperuvian\b/, "peruvian"],
  [/\bcolombian\b/, "colombian"],
  [/\b(venezuelan|arepa|arepas)\b/, "venezuelan"],
  [/\b(argentinian|argentine)\b/, "argentinian"],
  [/\bbrazilian\b/, "brazilian"],
  [/\bsalvadoran\b/, "salvadoran"],
  [/\bbagels?\b/, "bagel"],
  [/\b(deli|delicatessen)\b/, "deli"],
  [/\b(sandwich|sandwiches)\b/, "sandwich"],
  [/\b(breakfast|brunch)\b/, "breakfast"],
  [/\b(ethiopian|malaysian|filipino|indonesian|georgian|ukrainian|afghan|pakistani|senegalese|nigerian|tibetan|uzbek)\b/, "$1"],
  [/\b(nepalese|nepali)\b/, "nepalese"],
];

/**
 * What a name says a place serves ("Arturo's Coal Oven Pizza", "Taqueria Diana", "Great Szechuan"),
 * for a place no mapper gave a cuisine. Whole words only, and only words that name a cuisine or a
 * dish ("pizza", "ramen", "taqueria"), never ones names use for anything ("kitchen", "house",
 * "fish"). Words a rule used are not read again, so "Korean BBQ" is Korean BBQ, not also Korean and
 * barbecue. At most three slugs, in the order of the rules.
 */
export function cuisineFromName(name: string): string[] {
  let text = ` ${name.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
  const out: string[] = [];
  for (const [re, slug] of NAME_CUISINE) {
    const m = re.exec(text);
    if (!m) continue;
    const s = slug === "$1" ? m[1]! : slug;
    if (!out.includes(s)) out.push(s);
    if (out.length === 3) break;
    text = text.replace(new RegExp(re.source, "g"), " ");
  }
  return out;
}
