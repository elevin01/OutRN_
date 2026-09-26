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
export function estimateTravel(from: LatLon, to: LatLon, mode: TravelMode, opts: { hourLocal?: number } = {}): TravelEstimate {
  const d = haversineMetres(from, to);
  switch (mode) {
    case "walk": {
      const minutes = Math.ceil((d * 1.3) / 80); // 80 m/min ≈ 4.8 km/h
      return { minutes, mode, isEstimate: true, basis: `~${minutes} min walk` };
    }
    case "drive": {
      // Conservative urban/suburban speed by hour: peak 25 km/h, off-peak 35 km/h, night 45 km/h.
      const h = opts.hourLocal ?? 12;
      const kmh = h >= 7 && h <= 10 ? 25 : h >= 16 && h <= 19 ? 25 : h >= 22 || h < 6 ? 45 : 35;
      const driveMin = (d * 1.4) / ((kmh * 1000) / 60);
      const parkingBuffer = 8;
      const minutes = Math.ceil(driveMin + parkingBuffer);
      return { minutes, mode, isEstimate: true, basis: `~${minutes} min drive incl. parking` };
    }
    case "transit": {
      // Placeholder until a GTFS/routing adapter exists: walk-equivalent floor, 18 km/h effective + 8 min wait.
      const minutes = Math.ceil((d * 1.3) / ((18 * 1000) / 60) + 8);
      return { minutes, mode, isEstimate: true, basis: `~${minutes} min by transit` };
    }
  }
}
