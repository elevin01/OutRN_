import { DEFAULT_MAX_TRAVEL_MINUTES, type TravelMode } from "./geo.js";

/**
 * Destinations: places worth going out of the way for, which an outing is built around rather than
 * stopped at. A preserve with miles of trails, a botanical garden, a beach, a lookout over the
 * Hudson, an estate with grounds to walk, a zoo. What each is decides how a visit there reads (a
 * walk) and how far the engine looks for it when there is time (see destinationMaxTravel).
 */
export const DESTINATION_KINDS = ["nature", "park", "garden", "beach", "waterfront", "viewpoint", "estate", "zoo"] as const;
export type DestinationKind = (typeof DESTINATION_KINDS)[number];

export function isDestinationKind(v: unknown): v is DestinationKind {
  return typeof v === "string" && (DESTINATION_KINDS as readonly string[]).includes(v);
}

/** Destinations a visit to is a walk: trails, paths, a shore. */
export const WALK_DESTINATIONS: ReadonlySet<DestinationKind> = new Set(["nature", "park", "garden", "beach", "waterfront"]);

/** How a destination of each kind reads in a sentence: "a nature preserve". */
export const DESTINATION_LABEL: Readonly<Record<DestinationKind, string>> = {
  nature: "a nature preserve",
  park: "a big park",
  garden: "public gardens",
  beach: "a beach",
  waterfront: "a waterfront",
  viewpoint: "a lookout",
  estate: "a historic estate",
  zoo: "a zoo",
};

/**
 * How far a destination may be, one way, for a window of this many minutes: the mode's everyday
 * limit for a short outing, half again from 2½ hours, double from 3½. A 4-hour Saturday afternoon
 * can take a 60-minute drive to a preserve; an hour after work cannot. Everything else keeps the
 * everyday limit: nobody drives an hour for a coffee.
 */
export function destinationMaxTravel(mode: TravelMode, windowMinutes: number): number {
  const base = DEFAULT_MAX_TRAVEL_MINUTES[mode];
  return windowMinutes >= 210 ? base * 2 : windowMinutes >= 150 ? Math.round(base * 1.5) : base;
}
