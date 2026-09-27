import type { AreasResponse } from "@outrn/contracts";
import { isServedArea, listAreas, type Queryable } from "@outrn/db";
import { DEFAULT_AREA_ID, FILTERS, LIMITS } from "../config.js";

export async function areas(q: Queryable): Promise<AreasResponse> {
  // Only areas that are open. 'ingest_only' areas are still being filled and checked.
  const rows = (await listAreas(q)).filter(isServedArea);
  return {
    areas: rows.map((a) => ({ id: a.slug, name: a.name, timezone: a.timezone, defaultTravelMode: a.travel_mode, center: { lat: Number(a.lat), lon: Number(a.lon) } })),
    defaultAreaId: rows.some((a) => a.slug === DEFAULT_AREA_ID) ? DEFAULT_AREA_ID : (rows[0]?.slug ?? DEFAULT_AREA_ID),
    filters: FILTERS,
    limits: LIMITS,
  };
}
