import type { Aerial } from "@outrn/contracts";
import type { Category, LatLon } from "@outrn/core";
import { assertSourceAllowed, type Queryable } from "@outrn/db";
import { NY_REGION, NY_RINGS } from "./ny-outline.js";

/**
 * An aerial photo of a place's own spot, from New York State's orthoimagery (NYS ITS Geospatial
 * Services, flown 2022–2025, 6 or 12 inch pixels): every place in the state has one, whatever else
 * is known of it. The image is drawn by the state's server for a box centred on the place, so the
 * API sends only its URL. Outside New York (Greenwich, across the Hudson) there is none: the
 * state's imagery stops at its line.
 */
export const AERIAL_SOURCE = "nys_orthoimagery";

const EXPORT = "https://orthos.its.ny.gov/arcgis/rest/services/wms/Latest/MapServer/export";
const WIDTH = 800;
const HEIGHT = 500;

/** Places the size of a block or more are shown wider than a building and its street. */
const WIDE: ReadonlySet<Category> = new Set<Category>(["park", "garden", "waterfront", "viewpoint", "attraction", "event_site", "market"]);

/** Whether the state's aerial photos may be shown now (its source's switch and policy). */
export async function aerialAllowed(q: Queryable): Promise<boolean> {
  try {
    await assertSourceAllowed(q, AERIAL_SOURCE, "display");
    return true;
  } catch {
    return false;
  }
}

/** Whether a point is in New York State (within the region its outline was cut to). */
export function inNewYork(p: LatLon): boolean {
  if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon)) return false;
  if (p.lon < NY_REGION.w || p.lon > NY_REGION.e || p.lat < NY_REGION.s || p.lat > NY_REGION.n) return false;
  let inside = false;
  for (const ring of NY_RINGS) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i]!;
      const [xj, yj] = ring[j]!;
      if (yi > p.lat !== yj > p.lat && p.lon < ((xj - xi) * (p.lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

/** The aerial photo of the spot a place is at, or null outside New York. */
export function aerialOf(p: LatLon, category: Category): Aerial | null {
  if (!inNewYork(p)) return null;
  // Web Mercator metres, the box rounded to the metre so the same place always has the same URL.
  const R = 6_378_137;
  const x = (p.lon * Math.PI * R) / 180;
  const y = Math.log(Math.tan(Math.PI / 4 + (p.lat * Math.PI) / 360)) * R;
  const halfW = WIDE.has(category) ? 200 : 80;
  const halfH = (halfW * HEIGHT) / WIDTH;
  const bbox = [x - halfW, y - halfH, x + halfW, y + halfH].map((v) => Math.round(v)).join(",");
  return {
    url: `${EXPORT}?bbox=${bbox}&bboxSR=3857&imageSR=3857&size=${WIDTH},${HEIGHT}&format=jpg&f=image`,
    width: WIDTH,
    height: HEIGHT,
    credit: "NYS ITS Geospatial Services orthoimagery",
    sourceUrl: "https://gis.ny.gov/orthoimagery",
  };
}
