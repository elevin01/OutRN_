import { CUISINE_CATEGORIES, cuisineLabel, cuisineMatches } from "@outrn/core";
import type { Candidate } from "./types.js";

/**
 * A food place's cuisines as its facts list them (slugs, lead first); none for any other kind of
 * place. In a search for cuisines, those asked for lead: a pizza search shows "Pizza" before "Italian".
 */
export function cuisinesOf(c: Candidate, requested: readonly string[] = []): string[] {
  if (!CUISINE_CATEGORIES.has(c.category)) return [];
  const v = (c.facts.cuisine?.value as { values?: unknown } | undefined)?.values;
  const all = Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  if (!requested.length) return all;
  const asked = all.filter((s) => cuisineMatches(requested, [s]));
  return [...asked, ...all.filter((s) => !asked.includes(s))];
}

/** Cuisines that only restate the kind of place: a café's coffee. */
const RESTATES_KIND: ReadonlySet<string> = new Set(["coffee_shop", "coffee", "cafe"]);

/** The cuisine a card leads with ("Thai"), or null when none says more than the kind of place. */
export function leadCuisine(c: Candidate, requested: readonly string[] = []): string | null {
  const s = cuisinesOf(c, requested).find((x) => !RESTATES_KIND.has(x));
  return s ? cuisineLabel(s) : null;
}
