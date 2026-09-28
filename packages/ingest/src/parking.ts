import { ownValue } from "@outrn/core";
import type { Queryable } from "@outrn/db";
import type { SnapshotExtent } from "@outrn/sources";

/** How far from a venue a place to park still counts as near: about a 6-minute walk. The engine reads the result. */
export const NEARBY_PARKING_METRES = 400;

/**
 * Parking near venues, from OSM amenity=parking. Only places anyone may park count: private,
 * customer-only, permit and resident lots are left out, since a plan can't send someone there. What
 * a lot is (surface, garage, street bays) and whether it charges come from its tags; anything the
 * tags don't say is unknown, never guessed.
 */

export interface ParkingFacility {
  name: string | null;
  kind: "lot" | "garage" | "street";
  fee: "free" | "paid" | "unknown";
  capacity: number | null;
  openingHours: string | null;
}

/** Access values that let anyone park. Missing access on a parking lot means public in OSM practice. */
const PUBLIC_ACCESS = new Set(["yes", "public", "permissive", "destination", "designated"]);

/** Access tags from the most specific for a car to the most general: the first one present decides. */
const ACCESS_KEYS = ["motorcar", "motor_vehicle", "vehicle", "access"] as const;

/**
 * Whether anyone may leave a car here. The most specific tag that applies to a car wins
 * (motorcar=no overrides access=yes, and motorcar=yes a general access=private). A restriction
 * only at some times (`*:conditional`) is not a plain yes, so such a place is left out.
 */
export function publicForCars(tags: Record<string, string>): boolean {
  if (ACCESS_KEYS.some((k) => tags[`${k}:conditional`] !== undefined)) return false;
  const key = ACCESS_KEYS.find((k) => tags[k] !== undefined);
  return key === undefined || PUBLIC_ACCESS.has(tags[key]!.trim());
}

/** OSM parking=* → what a driver finds there. Private kinds (carports, garage boxes, sheds) are not parking for visitors. */
const KIND: Record<string, ParkingFacility["kind"] | null> = {
  surface: "lot",
  "multi-storey": "garage",
  underground: "garage",
  rooftop: "garage",
  street_side: "street",
  lane: "street",
  on_kerb: "street",
  half_on_kerb: "street",
  layby: "street",
  carports: null,
  garage_boxes: null,
  sheds: null,
};

export function parkingFromTags(tags: Record<string, string>): ParkingFacility | null {
  if (tags["amenity"] !== "parking") return null;
  if (!publicForCars(tags)) return null;
  const type = tags["parking"];
  // The table's own entries only: "constructor" or "__proto__" as a tag value must not find what every object inherits.
  const kind = type === undefined ? "lot" : ownValue(KIND, type);
  if (kind === null || kind === undefined) return null;
  // A charge only at some times (fee:conditional) is not a plain yes or no: check the signs.
  const fee = tags["fee:conditional"] !== undefined ? "unknown" : tags["fee"] === "no" ? "free" : tags["fee"] === "yes" ? "paid" : "unknown";
  const cap = tags["capacity"] && /^\d{1,5}$/.test(tags["capacity"]) ? Number(tags["capacity"]) : null;
  const name = tags["name"]?.trim() || null;
  return { name: name ? name.slice(0, 120) : null, kind, fee, capacity: cap && cap > 0 ? cap : null, openingHours: tags["opening_hours"]?.trim().slice(0, 255) || null };
}

/**
 * Re-derive parking from every parking record this run saw, and drop what no longer qualifies
 * (removed upstream, turned private, no longer parking). Rebuilt in full each run, so a change in
 * these rules reaches every lot without re-fetching.
 */
export async function syncParking(q: Queryable, runId: string, extent: SnapshotExtent): Promise<{ facilities: number; removed: number }> {
  const rows = (
    await q.query<{ id: string; raw: { tags: Record<string, string> }; source_updated_at: Date | null }>(
      `select id, raw, source_updated_at from source_entities
        where source_id = 'osm' and kind = 'parking' and deleted_at is null and last_seen_run_id = $1`,
      [runId],
    )
  ).rows;
  const keep: { id: string; p: ParkingFacility; updated: Date | null }[] = [];
  for (const r of rows) {
    const p = parkingFromTags(r.raw.tags);
    if (p) keep.push({ id: r.id, p, updated: r.source_updated_at });
  }
  if (keep.length) {
    await q.query(
      `insert into parking_facilities (source_entity_id, geom, name, kind, fee, capacity, opening_hours, source_updated_at, derived_at)
       select d.id, s.geom, d.name, d.kind, d.fee, d.capacity, d.hours, d.updated, now()
         from unnest($1::uuid[], $2::text[], $3::text[], $4::text[], $5::int[], $6::text[], $7::timestamptz[]) as d(id, name, kind, fee, capacity, hours, updated)
         join source_entities s on s.id = d.id
       on conflict (source_entity_id) do update
         set geom = excluded.geom, name = excluded.name, kind = excluded.kind, fee = excluded.fee, capacity = excluded.capacity,
             opening_hours = excluded.opening_hours, source_updated_at = excluded.source_updated_at, derived_at = excluded.derived_at`,
      [keep.map((k) => k.id), keep.map((k) => k.p.name), keep.map((k) => k.p.kind), keep.map((k) => k.p.fee), keep.map((k) => k.p.capacity), keep.map((k) => k.p.openingHours), keep.map((k) => k.updated)],
    );
  }
  // Gone upstream, no longer parking, or no longer open to visitors.
  const removed = await q.query(
    `delete from parking_facilities p using source_entities s
      where s.id = p.source_entity_id
        and (s.deleted_at is not null or s.kind <> 'parking' or (s.last_seen_run_id = $1 and not (p.source_entity_id = any($2::uuid[]))))`,
    [runId, keep.map((k) => k.id)],
  );
  await refreshVenueParking(q, extent);
  return { facilities: keep.length, removed: removed.rowCount ?? 0 };
}

/** Public parking kept per venue, nearest first: a plan passes over one that is closed for the visit. */
export const PARKING_CHOICES = 3;

/**
 * Each venue's nearest public parking within NEARBY_PARKING_METRES (up to PARKING_CHOICES), for
 * every venue that parking in this snapshot could be near: the extent plus that distance. Ties go to
 * the lower id, so the answer is stable across runs.
 */
export async function refreshVenueParking(q: Queryable, extent: SnapshotExtent): Promise<void> {
  const args = [extent.lon, extent.lat, extent.radiusM + NEARBY_PARKING_METRES, NEARBY_PARKING_METRES, PARKING_CHOICES];
  const near = `ST_DWithin(v.geom, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, $3)`;
  await q.query(`delete from venue_parking vp using venues v where v.id = vp.venue_id and ${near}`, args.slice(0, 3));
  await q.query(
    `insert into venue_parking (venue_id, rank, source_entity_id, distance_m)
     select v.id, p.rank - 1, p.source_entity_id, p.distance_m
       from venues v
       cross join lateral (
         select p.source_entity_id, ST_Distance(p.geom, v.geom) as distance_m,
                row_number() over (order by p.geom <-> v.geom, p.source_entity_id) as rank
           from parking_facilities p
          where ST_DWithin(p.geom, v.geom, $4)
          order by p.geom <-> v.geom, p.source_entity_id
          limit $5
       ) p
      where ${near}`,
    args,
  );
}
