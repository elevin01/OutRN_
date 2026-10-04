import type { RecommendationItem } from "@outrn/contracts";

/**
 * What a card says the place offers, as the API states it: its cuisines after the first (the summary
 * already leads with that one), then its diets and must-haves. Each label once, at most five.
 */
export function cardTags(item: Pick<RecommendationItem, "cuisines" | "diets" | "features" | "copy">): string[] {
  const lead = item.copy.summary.split(" · ")[0];
  const labels = [...item.cuisines.map((c) => c.label).filter((l) => l !== lead), ...item.diets.map((d) => d.label), ...item.features.map((f) => f.label)];
  return [...new Set(labels)].slice(0, 5);
}
