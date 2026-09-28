import { addMinutes, estimateTravel } from "@outrn/core";
import { evaluateHours } from "@outrn/facts";
import type { Queryable } from "@outrn/db";
import type { NearbyParking, TimingBase } from "./types.js";

/**
 * Where a driver leaves the car: the nearest public lot, garage or street spaces within about 400 m
 * of the venue (derived from OSM at ingest, into parking_facilities and venue_parking). A drive plan
 * names it and counts the walk from it; with none nearby, the area's parking buffer stands for
 * finding a space.
 */

/** Minutes to pull in, find a space in the lot and pay, before the walk. */
export const PARK_MINUTES = 2;

/** Where parking data comes from, for the attributions of anything that shows it. */
export const PARKING_SOURCE = "osm";

/** Each venue's public parking within about 400 m (venue_parking, worked out at ingest), nearest first. Venues with none are absent. */
export async function loadNearbyParking(q: Queryable, venueIds: readonly string[]): Promise<Map<string, NearbyParking[]>> {
  const out = new Map<string, NearbyParking[]>();
  if (!venueIds.length) return out;
  const rows = (
    await q.query<{ venue_id: string; name: string | null; kind: NearbyParking["kind"]; fee: NearbyParking["fee"]; opening_hours: string | null; lat: number; lon: number; vlat: number; vlon: number; distance_m: number }>(
      `select vp.venue_id, p.name, p.kind, p.fee, p.opening_hours, ST_Y(p.geom::geometry) as lat, ST_X(p.geom::geometry) as lon,
              ST_Y(v.geom::geometry) as vlat, ST_X(v.geom::geometry) as vlon, vp.distance_m
         from venue_parking vp
         join parking_facilities p on p.source_entity_id = vp.source_entity_id
         join venues v on v.id = vp.venue_id
        where vp.venue_id = any($1::uuid[])
        order by vp.venue_id, vp.rank`,
      [venueIds],
    )
  ).rows;
  for (const r of rows) {
    const point = { lat: Number(r.lat), lon: Number(r.lon) };
    const walk = estimateTravel(point, { lat: Number(r.vlat), lon: Number(r.vlon) }, "walk").minutes;
    const list = out.get(r.venue_id) ?? [];
    list.push({ name: r.name, kind: r.kind, fee: r.fee, point, distanceM: Math.round(Number(r.distance_m)), walkMinutes: Math.max(1, walk), openingHours: r.opening_hours });
    out.set(r.venue_id, list);
  }
  return out;
}

/**
 * Whether the plan can leave the car here: open when it parks (the walk before arriving) and still
 * open when the car is collected (the walk after the visit's latest end). No hours listed means open
 * when the lot is. Hours that can't be read, or are approximate, don't count as open: the plan says
 * "Park at …", so it must hold.
 */
export function parkingOpenFor(lot: NearbyParking, t: Pick<TimingBase, "departAt" | "travel" | "latestFinish">, timeZone: string): boolean {
  if (!lot.openingHours) return true;
  const parkAt = addMinutes(t.departAt, t.travel.minutes - lot.walkMinutes);
  const collectBy = addMinutes(t.latestFinish, lot.walkMinutes);
  const ev = evaluateHours({ osm: lot.openingHours }, parkAt, timeZone, lot.point);
  if (ev.parseError || ev.approximate) return false;
  if (ev.always) return true;
  return ev.openNow === true && ev.interval !== null && ev.interval.close >= collectBy;
}

/** Minutes a drive to this venue allows for parking: the area's buffer, or at least the walk from the lot. */
export function parkingMinutesFor(parking: NearbyParking | null | undefined, areaBufferMinutes: number): number {
  return parking ? Math.max(areaBufferMinutes, PARK_MINUTES + parking.walkMinutes) : areaBufferMinutes;
}

const NOUN: Record<NearbyParking["kind"], string> = { lot: "Lot", garage: "Garage", street: "Street parking" };
const PLACE: Record<NearbyParking["kind"], string> = { lot: "in the lot", garage: "in the garage", street: "on the street" };
const FEE_WORDS: Record<NearbyParking["fee"], string> = { free: " (free)", paid: " (paid)", unknown: "" };

/** A straight-line distance as words, no more precise than it is: 58 → "60 m", 301 → "300 m". */
function roughly(metres: number): string {
  const step = metres < 100 ? 10 : 50;
  return `${Math.max(step, Math.round(metres / step) * step)} m`;
}

/** "Orchard Street Lot (paid), ~2 min walk"; unnamed: "Garage 150 m away, ~2 min walk". */
export function parkingText(p: NearbyParking): string {
  return `${p.name ?? `${NOUN[p.kind]} ${roughly(p.distanceM)} away`}${FEE_WORDS[p.fee]}, ~${p.walkMinutes} min walk`;
}

/** The plan's instruction: "Park at Orchard Street Lot (paid), then walk ~2 min", "Park on the street 100 m away, …". */
export function parkStepText(p: NearbyParking): string {
  return `${p.name ? `Park at ${p.name}` : `Park ${PLACE[p.kind]} ${roughly(p.distanceM)} away`}${FEE_WORDS[p.fee]}, then walk ~${p.walkMinutes} min`;
}
