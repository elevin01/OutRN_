import type { ImageSourcePropType } from "react-native";
import type { RepresentativePhoto } from "./photos";

/**
 * Representative photos: shown only when a place has no photo of its own or none of its own loads,
 * always labelled "Representative photo · not this place", with their credit. Bundled with the app
 * (never hotlinked). Sources and licenses: assets/photos/README.md. A restaurant's or a cafe's cuisine
 * comes first when there is a photo of it (a pizzeria, pizza); then its kind of place.
 */
type Representative = RepresentativePhoto<ImageSourcePropType>;

const unsplash = (source: ImageSourcePropType, id: string): Representative => ({ source, credit: "Unsplash", url: `https://images.unsplash.com/${id}` });
const commons = (source: ImageSourcePropType, credit: string, url: string): Representative => ({ source, credit, url });

const AMERICAN = commons(require("../../assets/photos/american.jpg"), "Dan Gold danielcgold, CC0, via Wikimedia Commons (cropped)", "https://commons.wikimedia.org/wiki/File:Friends_eating_lunch_in_diner_(Unsplash).jpg");
const ARCADE = commons(require("../../assets/photos/arcade.jpg"), "Arcade Perfect, CC BY 2.0, via Wikimedia Commons (cropped)", "https://commons.wikimedia.org/wiki/File:Retrovolt_Arcade_2017_-_Arcade_Machines_1.jpg");
const ATTRACTION = commons(require("../../assets/photos/attraction.jpg"), "bluesbby from Mountain View, USA, CC BY 2.0, via Wikimedia Commons (cropped)", "https://commons.wikimedia.org/wiki/File:Carousel_(9652864007).jpg");
const BAGEL = commons(require("../../assets/photos/bagel.jpg"), "LinguisticsGirl.Librarian, CC0, via Wikimedia Commons (cropped)", "https://commons.wikimedia.org/wiki/File:Lox_Bagel_Sandwich_with_Cream_Cheese_Schmear_Onion_Tomato.jpg");
const BAR = commons(require("../../assets/photos/bar.jpg"), "Bernt Rostad from Oslo, Norway, CC BY 2.0, via Wikimedia Commons (cropped)", "https://commons.wikimedia.org/wiki/File:Taps_@_McGivney%E2%80%99s_(15089278651).jpg");
const BOOKSHOP = commons(require("../../assets/photos/bookshop.jpg"), "Immanuel Giel, CC0, via Wikimedia Commons (cropped)", "https://commons.wikimedia.org/wiki/File:Richard_Booth%27s_Bookshop_09.jpg");
const BOWLING = commons(require("../../assets/photos/bowling.jpg"), "Peter Cooper Jr., CC0, via Wikimedia Commons (cropped)", "https://commons.wikimedia.org/wiki/File:Candlepin_ball_about_to_hit_remaining_pins,_Bayberry_2026-02-28.jpg");
const BREAKFAST = commons(require("../../assets/photos/breakfast.jpg"), "Gabriel Gurrola gabrielgurrola, CC0, via Wikimedia Commons (cropped)", "https://commons.wikimedia.org/wiki/File:Eating_Pancakes_(Unsplash).jpg");
const BURGER = commons(require("../../assets/photos/burger.jpg"), "Horacio Cambeiro, CC BY 4.0, via Wikimedia Commons (cropped)", "https://commons.wikimedia.org/wiki/File:Homemade_hamburgers_and_french_fries_from_Argentina.jpg");
const CAFE = unsplash(require("../../assets/photos/cafe.jpg"), "photo-1554118811-1e0d58224f24");
const CARIBBEAN = commons(require("../../assets/photos/caribbean.jpg"), "Naotake Murayama, CC BY 2.0, via Wikimedia Commons (cropped)", "https://commons.wikimedia.org/wiki/File:Jerk_Chicken_with_Jambalaya_and_Corn_Salad.jpg");
const CHINESE = commons(require("../../assets/photos/chinese.jpg"), "Stewart from Taipei, CC BY 2.0, via Wikimedia Commons (cropped)", "https://commons.wikimedia.org/wiki/File:Shrimp_shaomais_by_Stewart_at_Din_Tai_Fung_in_Taipei.jpg");
const CINEMA = commons(require("../../assets/photos/cinema.jpg"), "Mojmir Churavy, CC0, via Wikimedia Commons (cropped)", "https://commons.wikimedia.org/wiki/File:Kino_Atlas_Interier_J.jpg");
const COFFEE = unsplash(require("../../assets/photos/coffee.jpg"), "photo-1509042239860-f550ce710b93");
const COMMUNITY = commons(require("../../assets/photos/community.jpg"), "Missvain, CC BY 4.0, via Wikimedia Commons (cropped)", "https://commons.wikimedia.org/wiki/File:Mendocino_County_Foodies_Potluck_and_Cookbook_Exchange_-_March_2024_-_Sarah_Stierch_11.jpg");
const CULTURE = unsplash(require("../../assets/photos/culture.jpg"), "photo-1577720643272-265f09367456");
const EVENT_SITE = commons(require("../../assets/photos/event_site.jpg"), "Pierre Marshall, CC BY 4.0, via Wikimedia Commons (cropped)", "https://commons.wikimedia.org/wiki/File:Jericho_Street_Fair_stalls,_2021.jpg");
const FRENCH = commons(require("../../assets/photos/french.jpg"), "Missvain, CC BY 4.0, via Wikimedia Commons (cropped)", "https://commons.wikimedia.org/wiki/File:Steak_frites_at_The_Bar_at_MacArthur_Place_in_Sonoma_-_Sarah_Stierch.jpg");
const GARDEN = commons(require("../../assets/photos/garden.jpg"), "DC Gardens, CC BY 2.0, via Wikimedia Commons (cropped)", "https://commons.wikimedia.org/wiki/File:U.S._Botanic_Garden_in_May_(23695067931).jpg");
const GREEK = commons(require("../../assets/photos/greek.jpg"), "Tamorlan, CC BY 3.0, via Wikimedia Commons (cropped)", "https://commons.wikimedia.org/wiki/File:Plate_with_Gyros_Vegetables.jpg");
const INDIAN = commons(require("../../assets/photos/indian.jpg"), "Jan Helebrant, CC0, via Wikimedia Commons (cropped)", "https://commons.wikimedia.org/wiki/File:Food_Indian_butter_chicken_(52843424475).jpg");
const ITALIAN = commons(require("../../assets/photos/italian.jpg"), "jeffreyw, CC BY 2.0, via Wikimedia Commons (cropped)", "https://commons.wikimedia.org/wiki/File:Spaghetti_and_meatballs_1.jpg");
const JAPANESE = commons(require("../../assets/photos/japanese.jpg"), "Blue Lotus, CC BY 2.0, via Wikimedia Commons (cropped)", "https://commons.wikimedia.org/wiki/File:Bento_at_Hanabishi,_Koyasan.jpg");
const KOREAN = commons(require("../../assets/photos/korean.jpg"), "Douglas Paul Perkins, CC BY 3.0, via Wikimedia Commons (cropped)", "https://commons.wikimedia.org/wiki/File:Bibimbap_in_Jeonju.jpg");
const LATIN_AMERICAN = commons(require("../../assets/photos/latin_american.jpg"), "Luca Nebuloni, CC BY 2.0, via Wikimedia Commons (cropped)", "https://commons.wikimedia.org/wiki/File:Arepas_(32187739776).jpg");
const LIBRARY = commons(require("../../assets/photos/library.jpg"), "Samuel Zeller samuelzeller, CC0, via Wikimedia Commons (cropped)", "https://commons.wikimedia.org/wiki/File:Reading_room_(Unsplash).jpg");
const LIVE_MUSIC = commons(require("../../assets/photos/live_music.jpg"), "Daniel Ebersole danielebersole, CC0, via Wikimedia Commons (cropped)", "https://commons.wikimedia.org/wiki/File:Silhouettes_against_pale_stage_smoke_(Unsplash).jpg");
const MARKET = commons(require("../../assets/photos/market.jpg"), "Myotus, CC BY 4.0, via Wikimedia Commons (cropped)", "https://commons.wikimedia.org/wiki/File:Richfield_Farmers_Market-11.jpg");
const MEDITERRANEAN = commons(require("../../assets/photos/mediterranean.jpg"), "Guilhem Vellut from Paris, France, CC BY 2.0, via Wikimedia Commons (cropped)", "https://commons.wikimedia.org/wiki/File:Hummus_@_Kaza_plate_@_Kaza_Maza_@_Montparnasse_@_Paris_(34185040806).jpg");
const MEXICAN = commons(require("../../assets/photos/mexican.jpg"), "Evgeny Krivosheev, Public domain, via Wikimedia Commons (cropped)", "https://commons.wikimedia.org/wiki/File:Tacos_on_a_plate.jpg");
const MIDDLE_EASTERN = commons(require("../../assets/photos/middle_eastern.jpg"), "young shanahan, CC BY 2.0, via Wikimedia Commons (cropped)", "https://commons.wikimedia.org/wiki/File:Food_in_Israel.jpg");
const NIGHTCLUB = commons(require("../../assets/photos/nightclub.jpg"), "Vyacheslav Argenberg, CC BY 4.0, via Wikimedia Commons (cropped)", "https://commons.wikimedia.org/wiki/File:Popovka,_DJ_Martin_Landers,_Crimea.jpg");
const PARK = commons(require("../../assets/photos/park.jpg"), "Abubakr Saeed, CC BY 2.0, via Wikimedia Commons (cropped)", "https://commons.wikimedia.org/wiki/File:Urban_Forest_of_London_-_Flickr_-_Abubakr_Saeed.jpg");
const PASTRY = unsplash(require("../../assets/photos/pastry.jpg"), "photo-1555507036-ab1f4038808a");
const PIZZA = commons(require("../../assets/photos/pizza.jpg"), "ノボホショコロトソ, CC BY 4.0, via Wikimedia Commons (cropped)", "https://commons.wikimedia.org/wiki/File:Pizza_Margherita_%E3%83%94%E3%82%B6%E3%83%BB%E3%83%9E%E3%83%AB%E3%82%B2%E3%83%AA%E3%83%BC%E3%82%BF.jpg");
const RAMEN = commons(require("../../assets/photos/ramen.jpg"), "City Foodsters, CC BY 2.0, via Wikimedia Commons (cropped)", "https://commons.wikimedia.org/wiki/File:Tsukemen_at_a_Tokyo_restaurant.jpg");
const RESTAURANT = commons(require("../../assets/photos/restaurant.jpg"), "P1898, CC BY 4.0, via Wikimedia Commons (cropped)", "https://commons.wikimedia.org/wiki/File:Bahay_ni_Cabel_Heritage_Restaurant_2026-06-15Interior_floors_06.jpg");
const SANDWICH = commons(require("../../assets/photos/sandwich.jpg"), "jeffreyw, CC BY 2.0, via Wikimedia Commons (cropped)", "https://commons.wikimedia.org/wiki/File:Mmm..._Pastrami_on_deli_rye_with_sauerkraut_(6199321124).jpg");
const SEAFOOD = commons(require("../../assets/photos/seafood.jpg"), "Archangel12, CC BY 2.0, via Wikimedia Commons (cropped)", "https://commons.wikimedia.org/wiki/File:Normandy_%2710-_Port-en-Bessin-Huppain_(4826326884).jpg");
const SPANISH = commons(require("../../assets/photos/spanish.jpg"), "Ken Hawkins from SC, USA, CC BY 2.0, via Wikimedia Commons (cropped)", "https://commons.wikimedia.org/wiki/File:Tapas_plate_(6938398411).jpg");
const SUSHI = commons(require("../../assets/photos/sushi.jpg"), "Nesnad, CC BY 2.5, via Wikimedia Commons (cropped)", "https://commons.wikimedia.org/wiki/File:2007feb-sushi-odaiba-manytypes.jpg");
const THAI = commons(require("../../assets/photos/thai.jpg"), "Shreveport-Bossier Convention and Tourist Bureau, CC BY 2.0, via Wikimedia Commons (cropped)", "https://commons.wikimedia.org/wiki/File:Danh%27s_Garden,_Shreveport,_LA.jpg");
const THEATRE = commons(require("../../assets/photos/theatre.jpg"), "Andypiper from Ann Arbor, Michigan, USA, CC BY 2.0, via Wikimedia Commons (cropped)", "https://commons.wikimedia.org/wiki/File:Michigan_Theater_Seats.jpg");
const VIETNAMESE = commons(require("../../assets/photos/vietnamese.jpg"), "Andy Li, CC0, via Wikimedia Commons (cropped)", "https://commons.wikimedia.org/wiki/File:Pho_Bo_by_Banh_%26_Mee_in_Kirkgate_Market.jpg");
const VIEWPOINT = commons(require("../../assets/photos/viewpoint.jpg"), "Larry D. Moore, CC BY 4.0, via Wikimedia Commons (cropped)", "https://commons.wikimedia.org/wiki/File:Overlook_View_Hill_Country_SNA_Texas_2023.jpg");
const WATERFRONT = commons(require("../../assets/photos/waterfront.jpg"), "Hayden Soloviev, CC BY 4.0, via Wikimedia Commons (cropped)", "https://commons.wikimedia.org/wiki/File:Riverside_Promenade_on_%C3%8Ele_d%E2%80%99Orl%C3%A9ans.jpg");

const BY_CATEGORY: Readonly<Record<string, readonly Representative[]>> = {
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
const BY_CUISINE: Readonly<Record<string, Representative>> = {
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

const own = <T>(o: Readonly<Record<string, T>>, key: string): T | undefined => (Object.prototype.hasOwnProperty.call(o, key) ? o[key] : undefined);
const NONE: readonly Representative[] = [];
const cache = new Map<string, readonly Representative[]>();

/** The same array on every call for a category and its first pictured cuisine, so that memos keyed on it hold. */
export function representativePhotos(categoryId: string, cuisines?: readonly { id: string }[]): readonly Representative[] {
  const cuisine = FOOD.has(categoryId) ? cuisines?.find((c) => own(BY_CUISINE, c.id))?.id : undefined;
  const key = `${categoryId}|${cuisine ?? ""}`;
  let photos = cache.get(key);
  if (!photos) {
    const kind = own(BY_CATEGORY, categoryId) ?? NONE;
    const dish = cuisine ? own(BY_CUISINE, cuisine) : undefined;
    photos = dish ? [dish, ...kind] : kind;
    cache.set(key, photos);
  }
  return photos;
}
