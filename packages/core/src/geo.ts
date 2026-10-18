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

/**
 * The middle of Long Island Sound, west to east from off Throgs Neck: the line between the
 * Westchester and Connecticut shore to the north and Long Island's north shore to the south.
 */
const SOUND_LINE: readonly (readonly [lon: number, lat: number])[] = [
  [-73.775, 40.85], [-73.7, 40.9], [-73.6, 40.94], [-73.5, 40.97], [-73.4, 41.01], [-73.3, 41.03], [-73.1, 41.07], [-72.8, 41.1], [-72.3, 41.22], [-71.8, 41.3],
];

/**
 * Whether a place counts as across the Sound for the destinations job, which leaves those out:
 * Long Island's north shore is minutes away as the crow flies from New Rochelle and an hour by road.
 * South of the Sound's middle, or of 40.905 (whichever is farther north), east of Throgs Neck: a
 * margin that leaves out some of the mainland's own shore too (New Rochelle's Davenport Neck), so it
 * is a filter on what is added, not a test of which shore a place is on (see tripMetres).
 */
export function acrossTheSound(p: LatLon): boolean {
  const [first, last] = [SOUND_LINE[0]!, SOUND_LINE[SOUND_LINE.length - 1]!];
  if (p.lon < first[0] || p.lon > last[0] || p.lat < 40.5) return false;
  let line = first[1];
  for (let i = 1; i < SOUND_LINE.length; i++) {
    const [[x0, y0], [x1, y1]] = [SOUND_LINE[i - 1]!, SOUND_LINE[i]!];
    if (p.lon <= x1) {
      line = y0 + ((p.lon - x0) / (x1 - x0)) * (y1 - y0);
      break;
    }
  }
  return p.lat <= Math.max(40.905, line);
}

/** Which side of segment p→q the point r is on (sign of the cross product, in degrees: the area is small). */
function side(p: readonly [number, number], q: readonly [number, number], r: readonly [number, number]): number {
  return Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
}

/**
 * Whether the straight line between two places crosses the middle of the Sound: one on each shore,
 * east of Throgs Neck. Two places on one shore never do, however near the water (New Rochelle's
 * center and its Davenport Neck), and neither do two in Queens.
 */
export function crossesTheSound(a: LatLon, b: LatLon): boolean {
  const pa: [number, number] = [a.lon, a.lat];
  const pb: [number, number] = [b.lon, b.lat];
  for (let i = 1; i < SOUND_LINE.length; i++) {
    const [p, q] = [SOUND_LINE[i - 1]!, SOUND_LINE[i]!];
    if (side(p, q, pa) * side(p, q, pb) < 0 && side(pa, pb, p) * side(pa, pb, q) < 0) return true;
  }
  return false;
}

/** Where a trip across the Sound crosses it: the Throgs Neck Bridge, the crossing nearest the mainland we serve. */
const THROGS_NECK: LatLon = { lat: 40.8005, lon: -73.7929 };

/**
 * The straight-line distance a trip covers: as the crow flies, or, when that line crosses the
 * Sound, to the bridge and on from it. Never shorter than the straight line, so a search radius
 * made from it still holds.
 */
export function tripMetres(from: LatLon, to: LatLon): number {
  if (!crossesTheSound(from, to)) return haversineMetres(from, to);
  return haversineMetres(from, THROGS_NECK) + haversineMetres(THROGS_NECK, to);
}

export type TravelMode = "walk" | "drive" | "transit";

/** Default one-way travel limits by mode, minutes. A request may set its own. */
export const DEFAULT_MAX_TRAVEL_MINUTES: Record<TravelMode, number> = { walk: 25, drive: 30, transit: 35 };

/** Minutes added to every drive for finding a space and walking from it, unless a parking rule says otherwise. */
export const DEFAULT_PARKING_BUFFER_MINUTES = 8;

const WALK_DETOUR = 1.3;
const WALK_M_PER_MIN = 80; // ≈ 4.8 km/h
/** Road distance over straight-line: town streets detour (1.4) over the first 5 km, roads beyond run straighter (1.25). */
const DRIVE_DETOUR = 1.4;
const DRIVE_DETOUR_FAR = 1.25;
const DRIVE_TOWN_M = 5_000;
/** Of the road distance, the first 4 km are driven at town speed, the rest at road speed. */
const DRIVE_TOWN_ROAD_M = 4_000;
const TRANSIT_DETOUR = 1.3;
const TRANSIT_KMH = 18;
const TRANSIT_WAIT_MIN = 8;

/** Conservative urban/suburban driving speed by local hour: peak 25 km/h, off-peak 35 km/h, night 45 km/h. */
export function driveSpeedKmh(hourLocal: number): number {
  const h = hourLocal;
  return h >= 7 && h <= 10 ? 25 : h >= 16 && h <= 19 ? 25 : h >= 22 || h < 6 ? 45 : 35;
}

/**
 * Average speed on the roads out of town (parkways, highways, county roads, with their ramps and
 * lights): peak 40 km/h, off-peak 60 km/h, night 70 km/h. Conservative: Bronxville to Croton Point
 * is ~35-40 min on the parkways; this says 47 at noon.
 */
export function roadSpeedKmh(hourLocal: number): number {
  const h = hourLocal;
  return h >= 7 && h <= 10 ? 40 : h >= 16 && h <= 19 ? 40 : h >= 22 || h < 6 ? 70 : 60;
}

/** Road metres for a straight-line distance (see DRIVE_DETOUR). */
function driveRoadMetres(d: number): number {
  return Math.min(d, DRIVE_TOWN_M) * DRIVE_DETOUR + Math.max(0, d - DRIVE_TOWN_M) * DRIVE_DETOUR_FAR;
}

/** Minutes behind the wheel for a straight-line distance at a local hour: town speed first, then road speed. */
function driveMinutes(d: number, hourLocal: number): number {
  const road = driveRoadMetres(d);
  const town = Math.min(road, DRIVE_TOWN_ROAD_M);
  return town / ((driveSpeedKmh(hourLocal) * 1000) / 60) + (road - town) / ((roadSpeedKmh(hourLocal) * 1000) / 60);
}

/** The straight-line distance `minutes` of driving covers at a local hour: the inverse of driveMinutes. */
function driveReachMetres(minutes: number, hourLocal: number): number {
  const townPerMin = (driveSpeedKmh(hourLocal) * 1000) / 60;
  const townMinutes = DRIVE_TOWN_ROAD_M / townPerMin;
  const road = minutes <= townMinutes ? minutes * townPerMin : DRIVE_TOWN_ROAD_M + (minutes - townMinutes) * ((roadSpeedKmh(hourLocal) * 1000) / 60);
  const townRoad = DRIVE_TOWN_M * DRIVE_DETOUR;
  return road <= townRoad ? road / DRIVE_DETOUR : DRIVE_TOWN_M + (road - townRoad) / DRIVE_DETOUR_FAR;
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
 * v1 travel estimate. Straight-line distance (round by the bridge across the Sound, see tripMetres)
 * × a detour factor at a speed by mode (a drive at town speed for its first few km, then road speed),
 * plus a fixed buffer for the mode (finding parking, waiting for a light).
 * Labeled as an estimate everywhere it is shown. Routed times come later via an adapter.
 */
export function estimateTravel(from: LatLon, to: LatLon, mode: TravelMode, opts: { hourLocal?: number; parkingBufferMinutes?: number } = {}): TravelEstimate {
  const d = tripMetres(from, to);
  switch (mode) {
    case "walk": {
      const minutes = Math.ceil((d * WALK_DETOUR) / WALK_M_PER_MIN);
      return { minutes, mode, isEstimate: true, basis: `~${minutes} min walk` };
    }
    case "drive": {
      const minutes = Math.ceil(driveMinutes(d, opts.hourLocal ?? 12) + (opts.parkingBufferMinutes ?? DEFAULT_PARKING_BUFFER_MINUTES));
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
 * every hour of the day: the inverse of the estimate above. The request-time search uses it so it
 * finds everything the engine could call reachable. `townSpeed` is the reach at town speed all the
 * way, as the estimate was before it drove out of town at road speed: what ingest sweeps up around
 * an area (see ingestExtentFor).
 */
export function maxReachMetres(mode: TravelMode, maxTravelMinutes: number, opts: { parkingBufferForHour?: (hourLocal: number) => number; townSpeed?: boolean } = {}): number {
  switch (mode) {
    case "walk":
      return (maxTravelMinutes * WALK_M_PER_MIN) / WALK_DETOUR;
    case "drive": {
      let best = 0;
      for (let h = 0; h < 24; h++) {
        const buffer = opts.parkingBufferForHour?.(h) ?? DEFAULT_PARKING_BUFFER_MINUTES;
        const driving = Math.max(0, maxTravelMinutes - buffer);
        best = Math.max(best, opts.townSpeed ? (driving * ((driveSpeedKmh(h) * 1000) / 60)) / DRIVE_DETOUR : driveReachMetres(driving, h));
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
