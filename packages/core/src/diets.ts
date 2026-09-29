import { ownValue } from "./lookup.js";

/**
 * What a food place can serve for a diet (OSM diet:*): "only" (a vegan restaurant), "yes" (vegan
 * options), "limited" (a dish or two), "no". A search for a diet counts "yes" and "only"; a vegan
 * place serves vegetarians too.
 */
export const DIETS = { vegetarian: "Vegetarian", vegan: "Vegan", gluten_free: "Gluten-free", halal: "Halal", kosher: "Kosher" } as const;
export type Diet = keyof typeof DIETS;
export const DIET_LEVELS = ["only", "yes", "limited", "no"] as const;
export type DietLevel = (typeof DIET_LEVELS)[number];
export type DietLevels = Partial<Record<Diet, DietLevel>>;

/** Must-haves a search may ask for, about the place rather than the food. */
export const FEATURES = { outdoor_seating: "Outdoor seating", wifi: "Wi-Fi", wheelchair: "Wheelchair accessible" } as const;
export type Feature = keyof typeof FEATURES;

const LEVELS: ReadonlySet<string> = new Set(DIET_LEVELS);

/** `diet:vegan=only; diet:halal=yes` → { vegan: "only", halal: "yes" }, with the tags it read. Null without any. */
export function dietsFromTags(t: Readonly<Record<string, string>>): { levels: DietLevels; evidence: string } | null {
  const levels: DietLevels = {};
  const read: string[] = [];
  for (const diet of Object.keys(DIETS) as Diet[]) {
    const v = t[`diet:${diet}`]?.trim().toLowerCase();
    if (v && LEVELS.has(v)) {
      levels[diet] = v as DietLevel;
      read.push(`diet:${diet}=${v}`);
    }
  }
  return read.length ? { levels, evidence: read.join("; ") } : null;
}

/**
 * Whether a mapper said anything about diets (any diet:* tag, known or not). Then the tags are the
 * word on it: a name is read only where none exist, so "Vegan Cafe" with diet:vegan=unknown stays unknown.
 */
export function hasDietTags(t: Readonly<Record<string, string>>): boolean {
  return Object.keys(t).some((k) => k.startsWith("diet:"));
}

/** Words in a name that say a place keeps a diet: "Jisu Vegetarian", "Madina Halal", "East Side Glatt". */
const NAME_DIET: readonly [RegExp, Diet][] = [
  [/\bvegan\b/, "vegan"],
  [/\bvegetarian\b/, "vegetarian"],
  [/\bhalal\b/, "halal"],
  // "Kosher-style" is a style of deli food, not a kosher kitchen.
  [/\b(kosher|glatt)\b(?! style\b)/, "kosher"],
  [/\bgluten free\b/, "gluten_free"],
];

/** What a name says a place serves for diets, as "only" for vegan/vegetarian/kosher and "yes" for the rest. */
export function dietsFromName(name: string): DietLevels {
  const text = ` ${name.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
  const out: DietLevels = {};
  for (const [re, diet] of NAME_DIET) if (re.test(text)) out[diet] = diet === "halal" || diet === "gluten_free" ? "yes" : "only";
  return out;
}

const serves = (l: DietLevel | undefined) => l === "yes" || l === "only";

/** Whether a place with these levels serves a diet (a DIETS id); vegan food is vegetarian food too. */
export function servesDiet(levels: DietLevels, diet: string): boolean {
  if (!ownValue(DIETS, diet)) return false;
  return serves(levels[diet as Diet]) || (diet === "vegetarian" && serves(levels.vegan));
}

/** "Vegan" for a vegan place, "Vegan options" where there are some; null when it isn't served. */
export function dietLabel(diet: Diet, level: DietLevel | undefined): string | null {
  if (level === "only") return DIETS[diet];
  if (level === "yes") return `${DIETS[diet]} options`;
  return null;
}
