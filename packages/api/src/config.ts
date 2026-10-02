import type { AreasResponse, Option } from "@outrn/contracts";
import { CATEGORIES, CUISINE_FILTERS, DIETS, FEATURES, INTERESTS } from "@outrn/core";
import type { Company, Mood } from "@outrn/engine";

/**
 * What a request may ask for, with default labels. The search form is built from these (via
 * GET /v1/areas), so adding a mood or category here needs no UI change.
 */

export const PAGE_SIZE = 3;

/** How long a search's pages stay valid. Its plans assume leaving around `asOf`; after this they are stale. */
export const SNAPSHOT_TTL_MINUTES = 20;

/** Snapshots are deleted this long after they expire (until then an expired cursor can still restart). */
export const SNAPSHOT_RETENTION_HOURS = 24;

export const DEFAULT_AREA_ID = "les";

export function labelOf(id: string): string {
  const t = id.replace(/_/g, " ");
  return t.charAt(0).toUpperCase() + t.slice(1);
}

export const MOODS: Record<Mood, string> = { relaxed: "Relaxed", active: "Active", food: "Food", culture: "Culture" };
export const COMPANIES: Record<Company, string> = { alone: "Just me", date: "Date", friends: "Friends", family: "Family" };
export const REQUESTABLE_CATEGORIES = CATEGORIES.filter((c) => c !== "other");

const options = (labels: Record<string, string>): Option[] => Object.entries(labels).map(([id, label]) => ({ id, label }));

export const FILTERS: AreasResponse["filters"] = {
  windows: [
    { minutes: 60, label: "1 hour" },
    { minutes: 120, label: "2 hours" },
    { minutes: 180, label: "3 hours" },
    { minutes: 240, label: "4 hours" },
  ],
  defaultWindowMinutes: 180,
  travelModes: [
    { id: "walk", label: "Walk" },
    { id: "transit", label: "Transit" },
    { id: "drive", label: "Drive" },
  ],
  budgets: [
    { id: "any", label: "Any", budget: { kind: "any" } },
    { id: "free", label: "Free", budget: { kind: "free" } },
    { id: "max_2500", label: "Up to $25", budget: { kind: "max", maxCents: 2500, currency: "USD" } },
    { id: "max_5000", label: "Up to $50", budget: { kind: "max", maxCents: 5000, currency: "USD" } },
  ],
  moods: options(MOODS),
  companies: options(COMPANIES),
  categories: REQUESTABLE_CATEGORIES.map((id) => ({ id, label: labelOf(id) })),
  cuisines: Object.entries(CUISINE_FILTERS).map(([id, c]) => ({ id, label: c.label })),
  diets: options(DIETS),
  features: options(FEATURES),
  interests: options(INTERESTS),
};

export const LIMITS: AreasResponse["limits"] = {
  windowMinutes: { min: 30, max: 480 },
  youngestAge: { min: 0, max: 120 },
  maxCategories: 5,
  maxCuisines: 5,
  maxDiets: 5,
  maxFeatures: 3,
  maxTaste: 32,
  pageSize: PAGE_SIZE,
};
