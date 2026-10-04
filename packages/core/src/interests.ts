import type { Category } from "./categories.js";
import { ownValue } from "./lookup.js";

/**
 * What people like doing, in the words they would pick ("live music", "art"). A taste profile weighs
 * these, and every place and event maps onto them. Taste ranks; it never excludes, and nothing here
 * is shown as a fact about a place.
 */
export const INTERESTS = {
  live_music: "Live music",
  comedy: "Comedy",
  theatre: "Theatre & dance",
  film: "Movies",
  art: "Art",
  museums: "Museums & history",
  food: "Restaurants",
  cafes: "Cafés & sweets",
  drinks: "Bars & drinks",
  nightlife: "Nightlife",
  outdoors: "Parks & outdoors",
  games: "Games & activities",
  markets: "Markets & shopping",
  books: "Books & talks",
  sports: "Sports",
  festivals: "Festivals & fairs",
} as const satisfies Record<string, string>;

export type Interest = keyof typeof INTERESTS;

/** The table's own keys only: "constructor" or "__proto__" is not an interest. */
export function isInterest(x: string): x is Interest {
  return Object.hasOwn(INTERESTS, x);
}

/** How much a place or event is each interest: 1 is what it is, 0.5 is part of it. */
export type InterestStrengths = Partial<Record<Interest, number>>;

export const INTERESTS_OF_CATEGORY: Readonly<Record<Category, InterestStrengths>> = {
  restaurant: { food: 1 },
  cafe: { cafes: 1 },
  dessert: { cafes: 1 },
  bar: { drinks: 1, nightlife: 0.5 },
  nightclub: { nightlife: 1, drinks: 0.5 },
  museum: { museums: 1, art: 0.5 },
  gallery: { art: 1 },
  arts_centre: { art: 1, theatre: 0.5 },
  theatre: { theatre: 1 },
  cinema: { film: 1 },
  live_music: { live_music: 1, nightlife: 0.5 },
  community: {},
  market: { markets: 1, food: 0.5 },
  park: { outdoors: 1 },
  garden: { outdoors: 1 },
  waterfront: { outdoors: 1 },
  viewpoint: { outdoors: 1 },
  attraction: { museums: 0.5 },
  library: { books: 1 },
  bookshop: { books: 1, markets: 0.5 },
  bowling: { games: 1, sports: 0.5 },
  arcade: { games: 1 },
  activity: { games: 1 },
  other: {},
};

/** Kinds within a broad category ("activity", "attraction") that say more than the category does. */
export const INTERESTS_OF_SUBTYPE: Readonly<Record<string, InterestStrengths>> = {
  karaoke_box: { games: 1, nightlife: 0.5 },
  casino: { games: 1, nightlife: 0.5 },
  escape_game: { games: 1 },
  miniature_golf: { games: 1, outdoors: 0.5 },
  ice_rink: { sports: 1, games: 0.5 },
  climbing: { sports: 1 },
  zoo: { outdoors: 1, museums: 0.5 },
  aquarium: { museums: 1 },
  theme_park: { games: 1, outdoors: 0.5 },
};

/**
 * What an event's title says it is ("Jazz on the Lawn", "Comedy Night", "Fireworks"). Whole words,
 * plain alternations: linear on any input. An estimate from a name, so it only ever ranks.
 */
const TITLE_INTERESTS: readonly [RegExp, InterestStrengths][] = [
  [/\b(comedy|stand-?up|improv)\b/i, { comedy: 1 }],
  [/\bopen mic\b/i, { comedy: 0.5, live_music: 0.5 }],
  [/\b(jazz|blues|concerts?|bands?|live music|dj|orchestra|symphony|quartet|gig|rock|hip-?hop|folk|choir|recital|salsa)\b/i, { live_music: 1 }],
  [/\b(films?|screenings?|movies?|cinema)\b/i, { film: 1 }],
  [/\b(musical|theat(?:re|er)|dance|ballet|opera|cabaret|burlesque|drag)\b/i, { theatre: 1 }],
  [/\b(exhibit(?:ion)?s?|art|opening reception|artist talk)\b/i, { art: 1 }],
  [/\b(tours?|history|historic)\b/i, { museums: 1 }],
  [/\b(trivia|quiz|game night|bingo|board games?)\b/i, { games: 1 }],
  [/\b(readings?|authors?|books?|poetry|lectures?|talks?|panel|storytime)\b/i, { books: 1 }],
  [/\b(markets?|flea|bazaar|craft fair|pop-?up shop)\b/i, { markets: 1 }],
  [/\b(festivals?|fairs?|parades?|block party|carnival|celebration)\b/i, { festivals: 1 }],
  [/\bfireworks\b/i, { festivals: 1, outdoors: 0.5 }],
  [/\b(yoga|5k|10k|race|marathon|baseball|basketball|soccer|football|hockey|tennis)\b/i, { sports: 1 }],
  [/\b(tastings?|wine|beer|cocktails?)\b/i, { drinks: 1 }],
  [/\b(brunch|dinner|supper|food)\b/i, { food: 1 }],
];

/** Longest title read: event titles are short, and a runaway one should not cost anything. */
const MAX_TITLE = 200;

function add(into: InterestStrengths, from: InterestStrengths, scale = 1): void {
  for (const [k, v] of Object.entries(from) as [Interest, number][]) into[k] = Math.max(into[k] ?? 0, v * scale);
}

export function interestsOfTitle(title: string): InterestStrengths {
  const t = title.slice(0, MAX_TITLE);
  const out: InterestStrengths = {};
  for (const [re, strengths] of TITLE_INTERESTS) if (re.test(t)) add(out, strengths);
  return out;
}

/**
 * The interests of a place (its category, or its subtype when that says more) or of an event at it.
 * An event is what its title says first; the place it is held at counts for half when the title says
 * anything, and in full when it says nothing ("The Tenement Follies" at a museum is a museum outing).
 */
export function interestsOf(x: { category: Category; subtype?: string | null; title?: string | null }): InterestStrengths {
  const place: InterestStrengths = {};
  add(place, (x.subtype ? ownValue(INTERESTS_OF_SUBTYPE, x.subtype) : undefined) ?? INTERESTS_OF_CATEGORY[x.category]);
  if (!x.title) return place;
  const out = interestsOfTitle(x.title);
  add(out, place, Object.keys(out).length ? 0.5 : 1);
  return out;
}
