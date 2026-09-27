export interface LatLon {
  lat: number;
  lon: number;
}

const R = 6_371_000; // metres

/** Great-circle distance in metres. */
export function haversineMetres(a: LatLon, b: LatLon): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const la1 = toRad(a.lat);
  const la2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export type TravelMode = "walk" | "drive" | "transit";

/** Default one-way travel limits by mode, minutes. A request may set its own. */
export const DEFAULT_MAX_TRAVEL_MINUTES: Record<TravelMode, number> = { walk: 25, drive: 30, transit: 35 };

/** Minutes added to every drive for finding a space and walking from it, unless a parking rule says otherwise. */
export const DEFAULT_PARKING_BUFFER_MINUTES = 8;

const WALK_DETOUR = 1.3;
const WALK_M_PER_MIN = 80; // ≈ 4.8 km/h
const DRIVE_DETOUR = 1.4;
const TRANSIT_DETOUR = 1.3;
const TRANSIT_KMH = 18;
const TRANSIT_WAIT_MIN = 8;

/** Conservative urban/suburban driving speed by local hour: peak 25 km/h, off-peak 35 km/h, night 45 km/h. */
export function driveSpeedKmh(hourLocal: number): number {
  const h = hourLocal;
  return h >= 7 && h <= 10 ? 25 : h >= 16 && h <= 19 ? 25 : h >= 22 || h < 6 ? 45 : 35;
}

export interface TravelEstimate {
  minutes: number;
  mode: TravelMode;
  /** Always true in v1: nothing here is a routed time. */
  isEstimate: true;
  /** Plain-language basis, rendered on the card as "~12 min walk". */
  basis: string;
}

/**
 * v1 travel estimate. Straight-line distance × a detour factor at a speed by mode,
 * plus a fixed buffer for the mode (finding parking, waiting for a light).
 * Labeled as an estimate everywhere it is shown. Routed times come later via an adapter.
 */
export function estimateTravel(from: LatLon, to: LatLon, mode: TravelMode, opts: { hourLocal?: number; parkingBufferMinutes?: number } = {}): TravelEstimate {
  const d = haversineMetres(from, to);
  switch (mode) {
    case "walk": {
      const minutes = Math.ceil((d * WALK_DETOUR) / WALK_M_PER_MIN);
      return { minutes, mode, isEstimate: true, basis: `~${minutes} min walk` };
    }
    case "drive": {
      const kmh = driveSpeedKmh(opts.hourLocal ?? 12);
      const driveMin = (d * DRIVE_DETOUR) / ((kmh * 1000) / 60);
      const minutes = Math.ceil(driveMin + (opts.parkingBufferMinutes ?? DEFAULT_PARKING_BUFFER_MINUTES));
      return { minutes, mode, isEstimate: true, basis: `~${minutes} min drive incl. parking` };
    }
    case "transit": {
      // Placeholder until a GTFS/routing adapter exists: walk-equivalent floor, 18 km/h effective + 8 min wait.
      const minutes = Math.ceil((d * TRANSIT_DETOUR) / ((TRANSIT_KMH * 1000) / 60) + TRANSIT_WAIT_MIN);
      return { minutes, mode, isEstimate: true, basis: `~${minutes} min by transit` };
    }
  }
}

/**
 * The farthest straight-line distance estimateTravel can place inside `maxTravelMinutes`, over
 * every hour of the day: the inverse of the estimate above. Ingest and the request-time search
 * use it so the catalog covers exactly what the engine could ever call reachable.
 */
export function maxReachMetres(mode: TravelMode, maxTravelMinutes: number, opts: { parkingBufferForHour?: (hourLocal: number) => number } = {}): number {
  switch (mode) {
    case "walk":
      return (maxTravelMinutes * WALK_M_PER_MIN) / WALK_DETOUR;
    case "drive": {
      let best = 0;
      for (let h = 0; h < 24; h++) {
        const buffer = opts.parkingBufferForHour?.(h) ?? DEFAULT_PARKING_BUFFER_MINUTES;
        const driving = Math.max(0, maxTravelMinutes - buffer);
        best = Math.max(best, (driving * ((driveSpeedKmh(h) * 1000) / 60)) / DRIVE_DETOUR);
      }
      return best;
    }
    case "transit":
      return (Math.max(0, maxTravelMinutes - TRANSIT_WAIT_MIN) * ((TRANSIT_KMH * 1000) / 60)) / TRANSIT_DETOUR;
  }
}

/**
 * Parking context rule for an area: minutes of parking buffer by local hour. Stored in
 * context_rules; e.g. Westchester village lots are free after 6pm, so no meter hunt.
 */
export interface ParkingRule {
  defaultMinutes: number;
  /** Local-hour windows; `from` inclusive, `to` exclusive; wraps past midnight when from > to. */
  byHour: { from: number; to: number; minutes: number }[];
}

export function parkingBufferAt(rule: ParkingRule | null | undefined, hourLocal: number): number {
  if (!rule) return DEFAULT_PARKING_BUFFER_MINUTES;
  for (const w of rule.byHour) {
    const inside = w.from <= w.to ? hourLocal >= w.from && hourLocal < w.to : hourLocal >= w.from || hourLocal < w.to;
    if (inside) return w.minutes;
  }
  return rule.defaultMinutes;
}
