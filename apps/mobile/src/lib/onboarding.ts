import type {
  Area,
  AreasResponse,
  RecommendationRequest,
} from "@outrn/contracts";

import {
  EMPTY_TASTE,
  parseTaste,
  requestTaste as tasteForRequest,
  type Taste,
} from "./taste";
export { EMPTY_TASTE, parseTaste, type Taste };

export const TASTE_KEY = "outrn.taste.v1";
export const SETUP_KEY = "outrn.onboarding.v1";
export type Setup = {
  version: 1;
  step: "interests" | "nearby" | "area";
  completed: boolean;
  areaId?: string;
  travelMode?: NonNullable<RecommendationRequest["travelMode"]>;
  originSource?: "device" | "area";
};
export const EMPTY_SETUP: Setup = {
  version: 1,
  step: "interests",
  completed: false,
};
export function parseSetup(raw: unknown): Setup {
  if (!raw || typeof raw !== "object") return EMPTY_SETUP;
  const value = raw as Partial<Setup>;
  if (value.version !== 1) return EMPTY_SETUP;
  const areaId =
    typeof value.areaId === "string" && value.areaId.length < 120
      ? value.areaId
      : undefined;
  const originSource =
    value.originSource === "device" || value.originSource === "area"
      ? value.originSource
      : undefined;
  return {
    version: 1,
    step:
      value.step === "nearby" || value.step === "area"
        ? value.step
        : "interests",
    completed: value.completed === true && !!areaId && !!originSource,
    areaId,
    originSource,
    travelMode: ["walk", "drive", "transit"].includes(value.travelMode || "")
      ? value.travelMode
      : undefined,
  };
}

export function readStored<T>(
  raw: string | null,
  parse: (value: unknown) => T,
): T {
  try {
    return parse(raw ? JSON.parse(raw) : undefined);
  } catch {
    return parse(undefined);
  }
}

export type InterestChoice = {
  id: string;
  label: string;
  interests: string[];
  photo?: string;
};
const CHOICES: InterestChoice[] = [
  { id: "food", label: "Food spots", interests: ["food"], photo: "food" },
  {
    id: "coffee",
    label: "Coffee & sweets",
    interests: ["cafes"],
    photo: "coffee",
  },
  {
    id: "walk",
    label: "Walks & views",
    interests: ["outdoors"],
    photo: "walk",
  },
  { id: "pub", label: "Pubs & bars", interests: ["drinks"], photo: "pub" },
  {
    id: "art",
    label: "Art & culture",
    interests: ["art", "museums"],
    photo: "art",
  },
  {
    id: "music",
    label: "Live music",
    interests: ["live_music"],
    photo: "music",
  },
  { id: "games", label: "Games & fun", interests: ["games"], photo: "games" },
  {
    id: "market",
    label: "Shops & markets",
    interests: ["markets"],
    photo: "market",
  },
];

/** Presentation groups only; every request id still comes from GET /v1/areas. */
export function interestChoices(
  offered: AreasResponse["filters"]["interests"],
  expanded = false,
): InterestChoice[] {
  const ids = new Set(offered.map((option) => option.id));
  const primary = CHOICES.map((choice) => ({
    ...choice,
    interests: choice.interests.filter((id) => ids.has(id)),
  })).filter((choice) => choice.interests.length);
  const grouped = new Set(primary.flatMap((choice) => choice.interests));
  const additional = offered
    .filter((option) => !grouped.has(option.id))
    .map((option) => ({
      id: option.id,
      label: option.label,
      interests: [option.id],
    }));
  // The first run stays short. The editable profile offers every API-supplied interest.
  return expanded || !primary.length ? [...primary, ...additional] : primary;
}

export function isPicked(taste: Taste, choice: InterestChoice): boolean {
  return choice.interests.some(
    (id) => Object.hasOwn(taste.weights, id) && taste.weights[id] >= 0.5,
  );
}

export function toggleChoice(taste: Taste, choice: InterestChoice): Taste {
  const weights = { ...taste.weights };
  const picked = isPicked(taste, choice);
  for (const id of choice.interests) {
    if (picked) delete weights[id];
    else weights[id] = 0.8;
  }
  return parseTaste({ ...taste, weights });
}

export function requestTaste(taste: Taste, areas: AreasResponse) {
  return tasteForRequest(
    taste,
    areas.filters.interests.map((option) => option.id),
  ).slice(0, areas.limits.maxTaste);
}

/** Selects which area's API to ask. The backend alone validates coverage and feasibility. */
export function nearestArea(
  areas: readonly Area[],
  origin: { lat: number; lon: number },
): Area | undefined {
  const radians = Math.PI / 180;
  const distance = (area: Area) => {
    const lat = (area.center.lat - origin.lat) * radians;
    const lon = (area.center.lon - origin.lon) * radians;
    return (
      Math.sin(lat / 2) ** 2 +
      Math.cos(origin.lat * radians) *
        Math.cos(area.center.lat * radians) *
        Math.sin(lon / 2) ** 2
    );
  };
  return areas.reduce<Area | undefined>(
    (closest, area) =>
      !closest || distance(area) < distance(closest) ? area : closest,
    undefined,
  );
}

export function initialQuery(
  areas: AreasResponse,
  setup: Setup,
  origin?: RecommendationRequest["origin"],
): RecommendationRequest | undefined {
  const area = areas.areas.find((entry) => entry.id === setup.areaId);
  if (!area) return undefined;
  return {
    areaId: area.id,
    windowMinutes: areas.filters.defaultWindowMinutes,
    travelMode: areas.filters.travelModes.some(
      (mode) => mode.id === setup.travelMode,
    )
      ? setup.travelMode
      : area.defaultTravelMode,
    ...(origin ? { origin } : {}),
  };
}
