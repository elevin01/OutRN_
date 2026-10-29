import {
  mdiAccountGroupOutline, mdiBankOutline, mdiBinoculars, mdiBookshelf, mdiBowling, mdiCalendarStar, mdiCoffeeOutline, mdiCompassOutline, mdiDramaMasks,
  mdiFlowerOutline, mdiGamepadVariantOutline, mdiGlassCocktail, mdiIceCream, mdiLibrary, mdiMapMarkerOutline, mdiMovieOpenOutline, mdiMusic,
  mdiMusicNote, mdiPaletteOutline, mdiPineTree, mdiRun, mdiSilverwareForkKnife, mdiStarOutline, mdiStorefrontOutline, mdiTicketOutline, mdiWaves,
} from "@mdi/js";
import type { Aerial, AreasResponse, Photo } from "@outrn/contracts";

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
  // A pop-up's own site (a band on the lawn, a street fair): a "Happening".
  event_site: mdiCalendarStar,
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
  kind: "place" | "aerial" | "representative";
  credit: string;
  creditUrl: string | null;
  alt: string;
}

interface Stock {
  url: string;
  credit: string;
  creditUrl: string;
}
const unsplash = (file: string, id: string): Stock => ({ url: `/representative/${file}`, credit: "Unsplash", creditUrl: `https://images.unsplash.com/${id}` });
const commons = (file: string, credit: string, creditUrl: string): Stock => ({ url: `/representative/${file}`, credit, creditUrl });
const AMERICAN = commons("american.jpg", "Dan Gold danielcgold, CC0, via Wikimedia Commons (cropped)", "https://commons.wikimedia.org/wiki/File:Friends_eating_lunch_in_diner_(Unsplash).jpg");
const ARCADE = commons("arcade.jpg", "Arcade Perfect, CC BY 2.0, via Wikimedia Commons (cropped)", "https://commons.wikimedia.org/wiki/File:Retrovolt_Arcade_2017_-_Arcade_Machines_1.jpg");
const ATTRACTION = commons("attraction.jpg", "bluesbby from Mountain View, USA, CC BY 2.0, via Wikimedia Commons (cropped)", "https://commons.wikimedia.org/wiki/File:Carousel_(9652864007).jpg");
const BAGEL = commons("bagel.jpg", "LinguisticsGirl.Librarian, CC0, via Wikimedia Commons (cropped)", "https://commons.wikimedia.org/wiki/File:Lox_Bagel_Sandwich_with_Cream_Cheese_Schmear_Onion_Tomato.jpg");
const BAR = commons("bar.jpg", "Bernt Rostad from Oslo, Norway, CC BY 2.0, via Wikimedia Commons (cropped)", "https://commons.wikimedia.org/wiki/File:Taps_@_McGivney%E2%80%99s_(15089278651).jpg");
const BOOKSHOP = commons("bookshop.jpg", "Immanuel Giel, CC0, via Wikimedia Commons (cropped)", "https://commons.wikimedia.org/wiki/File:Richard_Booth%27s_Bookshop_09.jpg");
const BOWLING = commons("bowling.jpg", "Peter Cooper Jr., CC0, via Wikimedia Commons (cropped)", "https://commons.wikimedia.org/wiki/File:Candlepin_ball_about_to_hit_remaining_pins,_Bayberry_2026-02-28.jpg");
const BREAKFAST = commons("breakfast.jpg", "Gabriel Gurrola gabrielgurrola, CC0, via Wikimedia Commons (cropped)", "https://commons.wikimedia.org/wiki/File:Eating_Pancakes_(Unsplash).jpg");
const BURGER = commons("burger.jpg", "Horacio Cambeiro, CC BY 4.0, via Wikimedia Commons (cropped)", "https://commons.wikimedia.org/wiki/File:Homemade_hamburgers_and_french_fries_from_Argentina.jpg");
const CAFE = unsplash("cafe.jpg", "photo-1554118811-1e0d58224f24");
const CARIBBEAN = commons("caribbean.jpg", "Naotake Murayama, CC BY 2.0, via Wikimedia Commons (cropped)", "https://commons.wikimedia.org/wiki/File:Jerk_Chicken_with_Jambalaya_and_Corn_Salad.jpg");
const CHINESE = commons("chinese.jpg", "Stewart from Taipei, CC BY 2.0, via Wikimedia Commons (cropped)", "https://commons.wikimedia.org/wiki/File:Shrimp_shaomais_by_Stewart_at_Din_Tai_Fung_in_Taipei.jpg");
const CINEMA = commons("cinema.jpg", "Mojmir Churavy, CC0, via Wikimedia Commons (cropped)", "https://commons.wikimedia.org/wiki/File:Kino_Atlas_Interier_J.jpg");
const COFFEE = unsplash("coffee.jpg", "photo-1509042239860-f550ce710b93");
const COMMUNITY = commons("community.jpg", "Missvain, CC BY 4.0, via Wikimedia Commons (cropped)", "https://commons.wikimedia.org/wiki/File:Mendocino_County_Foodies_Potluck_and_Cookbook_Exchange_-_March_2024_-_Sarah_Stierch_11.jpg");
const CULTURE = unsplash("culture.jpg", "photo-1577720643272-265f09367456");
const EVENT_SITE = commons("event_site.jpg", "Pierre Marshall, CC BY 4.0, via Wikimedia Commons (cropped)", "https://commons.wikimedia.org/wiki/File:Jericho_Street_Fair_stalls,_2021.jpg");
const FRENCH = commons("french.jpg", "Missvain, CC BY 4.0, via Wikimedia Commons (cropped)", "https://commons.wikimedia.org/wiki/File:Steak_frites_at_The_Bar_at_MacArthur_Place_in_Sonoma_-_Sarah_Stierch.jpg");
const GARDEN = commons("garden.jpg", "DC Gardens, CC BY 2.0, via Wikimedia Commons (cropped)", "https://commons.wikimedia.org/wiki/File:U.S._Botanic_Garden_in_May_(23695067931).jpg");
const GREEK = commons("greek.jpg", "Tamorlan, CC BY 3.0, via Wikimedia Commons (cropped)", "https://commons.wikimedia.org/wiki/File:Plate_with_Gyros_Vegetables.jpg");
const INDIAN = commons("indian.jpg", "Jan Helebrant, CC0, via Wikimedia Commons (cropped)", "https://commons.wikimedia.org/wiki/File:Food_Indian_butter_chicken_(52843424475).jpg");
const ITALIAN = commons("italian.jpg", "jeffreyw, CC BY 2.0, via Wikimedia Commons (cropped)", "https://commons.wikimedia.org/wiki/File:Spaghetti_and_meatballs_1.jpg");
const JAPANESE = commons("japanese.jpg", "Blue Lotus, CC BY 2.0, via Wikimedia Commons (cropped)", "https://commons.wikimedia.org/wiki/File:Bento_at_Hanabishi,_Koyasan.jpg");
const KOREAN = commons("korean.jpg", "Douglas Paul Perkins, CC BY 3.0, via Wikimedia Commons (cropped)", "https://commons.wikimedia.org/wiki/File:Bibimbap_in_Jeonju.jpg");
const LATIN_AMERICAN = commons("latin_american.jpg", "Luca Nebuloni, CC BY 2.0, via Wikimedia Commons (cropped)", "https://commons.wikimedia.org/wiki/File:Arepas_(32187739776).jpg");
const LIBRARY = commons("library.jpg", "Samuel Zeller samuelzeller, CC0, via Wikimedia Commons (cropped)", "https://commons.wikimedia.org/wiki/File:Reading_room_(Unsplash).jpg");
const LIVE_MUSIC = commons("live_music.jpg", "Daniel Ebersole danielebersole, CC0, via Wikimedia Commons (cropped)", "https://commons.wikimedia.org/wiki/File:Silhouettes_against_pale_stage_smoke_(Unsplash).jpg");
const MARKET = commons("market.jpg", "Myotus, CC BY 4.0, via Wikimedia Commons (cropped)", "https://commons.wikimedia.org/wiki/File:Richfield_Farmers_Market-11.jpg");
const MEDITERRANEAN = commons("mediterranean.jpg", "Guilhem Vellut from Paris, France, CC BY 2.0, via Wikimedia Commons (cropped)", "https://commons.wikimedia.org/wiki/File:Hummus_@_Kaza_plate_@_Kaza_Maza_@_Montparnasse_@_Paris_(34185040806).jpg");
const MEXICAN = commons("mexican.jpg", "Evgeny Krivosheev, Public domain, via Wikimedia Commons (cropped)", "https://commons.wikimedia.org/wiki/File:Tacos_on_a_plate.jpg");
const MIDDLE_EASTERN = commons("middle_eastern.jpg", "young shanahan, CC BY 2.0, via Wikimedia Commons (cropped)", "https://commons.wikimedia.org/wiki/File:Food_in_Israel.jpg");
const NIGHTCLUB = commons("nightclub.jpg", "Vyacheslav Argenberg, CC BY 4.0, via Wikimedia Commons (cropped)", "https://commons.wikimedia.org/wiki/File:Popovka,_DJ_Martin_Landers,_Crimea.jpg");
const PARK = commons("park.jpg", "Abubakr Saeed, CC BY 2.0, via Wikimedia Commons (cropped)", "https://commons.wikimedia.org/wiki/File:Urban_Forest_of_London_-_Flickr_-_Abubakr_Saeed.jpg");
const PASTRY = unsplash("pastry.jpg", "photo-1555507036-ab1f4038808a");
const PIZZA = commons("pizza.jpg", "ノボホショコロトソ, CC BY 4.0, via Wikimedia Commons (cropped)", "https://commons.wikimedia.org/wiki/File:Pizza_Margherita_%E3%83%94%E3%82%B6%E3%83%BB%E3%83%9E%E3%83%AB%E3%82%B2%E3%83%AA%E3%83%BC%E3%82%BF.jpg");
const RAMEN = commons("ramen.jpg", "City Foodsters, CC BY 2.0, via Wikimedia Commons (cropped)", "https://commons.wikimedia.org/wiki/File:Tsukemen_at_a_Tokyo_restaurant.jpg");
const RESTAURANT = commons("restaurant.jpg", "P1898, CC BY 4.0, via Wikimedia Commons (cropped)", "https://commons.wikimedia.org/wiki/File:Bahay_ni_Cabel_Heritage_Restaurant_2026-06-15Interior_floors_06.jpg");
const SANDWICH = commons("sandwich.jpg", "jeffreyw, CC BY 2.0, via Wikimedia Commons (cropped)", "https://commons.wikimedia.org/wiki/File:Mmm..._Pastrami_on_deli_rye_with_sauerkraut_(6199321124).jpg");
const SEAFOOD = commons("seafood.jpg", "Archangel12, CC BY 2.0, via Wikimedia Commons (cropped)", "https://commons.wikimedia.org/wiki/File:Normandy_%2710-_Port-en-Bessin-Huppain_(4826326884).jpg");
const SPANISH = commons("spanish.jpg", "Ken Hawkins from SC, USA, CC BY 2.0, via Wikimedia Commons (cropped)", "https://commons.wikimedia.org/wiki/File:Tapas_plate_(6938398411).jpg");
const SUSHI = commons("sushi.jpg", "Nesnad, CC BY 2.5, via Wikimedia Commons (cropped)", "https://commons.wikimedia.org/wiki/File:2007feb-sushi-odaiba-manytypes.jpg");
const THAI = commons("thai.jpg", "Shreveport-Bossier Convention and Tourist Bureau, CC BY 2.0, via Wikimedia Commons (cropped)", "https://commons.wikimedia.org/wiki/File:Danh%27s_Garden,_Shreveport,_LA.jpg");
const THEATRE = commons("theatre.jpg", "Andypiper from Ann Arbor, Michigan, USA, CC BY 2.0, via Wikimedia Commons (cropped)", "https://commons.wikimedia.org/wiki/File:Michigan_Theater_Seats.jpg");
const VIETNAMESE = commons("vietnamese.jpg", "Andy Li, CC0, via Wikimedia Commons (cropped)", "https://commons.wikimedia.org/wiki/File:Pho_Bo_by_Banh_%26_Mee_in_Kirkgate_Market.jpg");
const VIEWPOINT = commons("viewpoint.jpg", "Larry D. Moore, CC BY 4.0, via Wikimedia Commons (cropped)", "https://commons.wikimedia.org/wiki/File:Overlook_View_Hill_Country_SNA_Texas_2023.jpg");
const WATERFRONT = commons("waterfront.jpg", "Hayden Soloviev, CC BY 4.0, via Wikimedia Commons (cropped)", "https://commons.wikimedia.org/wiki/File:Riverside_Promenade_on_%C3%8Ele_d%E2%80%99Orl%C3%A9ans.jpg");
const REPRESENTATIVE: Readonly<Record<string, readonly Stock[]>> = {
  restaurant: [RESTAURANT],
  cafe: [CAFE, COFFEE],
  dessert: [PASTRY],
  bar: [BAR],
  museum: [CULTURE],
  gallery: [CULTURE],
  arts_centre: [CULTURE],
  theatre: [THEATRE],
  cinema: [CINEMA],
  live_music: [LIVE_MUSIC],
  community: [COMMUNITY],
  market: [MARKET],
  park: [PARK],
  garden: [GARDEN],
  waterfront: [WATERFRONT],
  viewpoint: [VIEWPOINT],
  attraction: [ATTRACTION],
  library: [LIBRARY],
  bookshop: [BOOKSHOP],
  bowling: [BOWLING],
  arcade: [ARCADE],
  nightclub: [NIGHTCLUB],
  event_site: [EVENT_SITE],
};
/** A food place's cuisine, by its filter id: the photo and what it shows. */
const BY_CUISINE: Readonly<Record<string, Stock & { of: string }>> = {
  pizza: { ...PIZZA, of: "pizza" },
  italian: { ...ITALIAN, of: "pasta" },
  chinese: { ...CHINESE, of: "dim sum" },
  japanese: { ...JAPANESE, of: "a bento" },
  sushi: { ...SUSHI, of: "sushi" },
  ramen: { ...RAMEN, of: "ramen" },
  mexican: { ...MEXICAN, of: "tacos" },
  thai: { ...THAI, of: "pad thai" },
  indian: { ...INDIAN, of: "a curry" },
  korean: { ...KOREAN, of: "bibimbap" },
  vietnamese: { ...VIETNAMESE, of: "pho" },
  american: { ...AMERICAN, of: "a diner meal" },
  burger: { ...BURGER, of: "a burger" },
  french: { ...FRENCH, of: "a bistro dish" },
  greek: { ...GREEK, of: "Greek food" },
  mediterranean: { ...MEDITERRANEAN, of: "mezze" },
  middle_eastern: { ...MIDDLE_EASTERN, of: "falafel" },
  seafood: { ...SEAFOOD, of: "seafood" },
  spanish: { ...SPANISH, of: "tapas" },
  caribbean: { ...CARIBBEAN, of: "Caribbean food" },
  latin_american: { ...LATIN_AMERICAN, of: "arepas" },
  breakfast: { ...BREAKFAST, of: "pancakes" },
  bagel: { ...BAGEL, of: "a bagel" },
  sandwich: { ...SANDWICH, of: "a deli sandwich" },
};
/** Kinds of place whose cuisine says what they look like. */
const FOOD: ReadonlySet<string> = new Set(["restaurant", "cafe"]);

/** Where the API's photos live: Wikimedia's image hosts, nowhere else. */
const PHOTO_HOSTS = /^(upload|thumb)\.wikimedia\.org$/;
/** Where aerial photos live: New York State's orthoimagery server, nowhere else. */
const AERIAL_HOSTS = /^orthos\.its\.ny\.gov$/;

/** Kinds of place an aerial photo shows better than a representative one: outdoors, a block or more (as the API sizes it). */
const AERIAL_FIRST: ReadonlySet<string> = new Set(["park", "garden", "waterfront", "viewpoint", "attraction", "event_site", "market"]);

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

/**
 * Representative photos of the kind of place, labelled as such; none for a kind without any. A
 * restaurant's or a cafe's cuisine comes first when there is a photo of it (a pizzeria, pizza).
 */
export function representativeFor(name: string, category: { id: string; label: string }, cuisines?: readonly { id: string; label: string }[]): ShownPhoto[] {
  const kind = (own(REPRESENTATIVE, category.id) ?? []).map((r): ShownPhoto => ({ ...r, kind: "representative", alt: `A representative photo of ${withArticle(category.label.toLowerCase())}, not ${name}` }));
  const cuisine = FOOD.has(category.id) ? cuisines?.find((c) => own(BY_CUISINE, c.id)) : undefined;
  const dish = cuisine && own(BY_CUISINE, cuisine.id);
  return dish ? [{ url: dish.url, credit: dish.credit, creditUrl: dish.creditUrl, kind: "representative", alt: `A representative photo of ${dish.of}, not ${name}` }, ...kind] : kind;
}

/**
 * A place's stand-ins when it has no photo of its own (or none loads): an aerial photo of its spot
 * and representative photos of its kind, each labelled as what it is; the aerial first for a park,
 * a garden, a waterfront and the like.
 */
export function fallbackFor(name: string, category: { id: string; label: string }, aerial?: Aerial | null, cuisines?: readonly { id: string; label: string }[]): ShownPhoto[] {
  const url = safeHttpsUrl(aerial?.url, AERIAL_HOSTS);
  const air: ShownPhoto[] = url && aerial ? [{ url, kind: "aerial", credit: aerial.credit, creditUrl: safeHttpsUrl(aerial.sourceUrl), alt: `An aerial view of where ${name} is` }] : [];
  const stock = representativeFor(name, category, cuisines);
  return AERIAL_FIRST.has(category.id) ? [...air, ...stock] : [...stock, ...air];
}

/**
 * The place's own photos, each with its credit; without any, its stand-ins (an aerial photo of its
 * spot, representative photos of its kind), labelled as such; without those, none.
 */
export function photosFor(name: string, category: { id: string; label: string }, photos: readonly Photo[] | undefined, aerial?: Aerial | null, cuisines?: readonly { id: string; label: string }[]): ShownPhoto[] {
  // The payload is not trusted: only https images on Wikimedia's hosts load, and a credit links only
  // over https. A photo that fails the check is dropped; a credit that does is shown as plain text.
  const mine = (photos ?? []).flatMap((p, i): ShownPhoto[] => {
    const url = safeHttpsUrl(p.url, PHOTO_HOSTS);
    return url ? [{ url, kind: "place", credit: p.credit, creditUrl: safeHttpsUrl(p.sourceUrl), alt: p.alt ? `${name}: ${p.alt}` : `Photo ${i + 1} of ${name}` }] : [];
  });
  return mine.length ? mine : fallbackFor(name, category, aerial, cuisines);
}

/**
 * The photos to show now: the place's own that have not failed to load; when none is left, its
 * stand-ins that have not (labelled as such); when none of those is left either, none: never the
 * category's icon in place of a photo.
 */
export function photosToShow(photos: readonly ShownPhoto[], fallback: readonly ShownPhoto[], failed: readonly string[]): ShownPhoto[] {
  for (const list of [photos, fallback]) {
    const live = list.filter((p) => !failed.includes(p.url));
    if (live.length) return live;
  }
  return [];
}
