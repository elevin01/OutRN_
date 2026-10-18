import { contentHash } from "@outrn/core";
import type { Queryable } from "@outrn/db";
import { assertSourceAllowed, getSourcePolicy } from "@outrn/db";
import { isOsmParking, type OsmElement, type SnapshotExtent } from "./overpass.js";

/**
 * Source-owned storage. Raw records are versioned by content hash and kept per policy.
 * Every write is tied to an ingestion run so counts, costs and errors are auditable.
 */

export async function startRun(q: Queryable, args: { sourceId: string; areaId?: string | null; kind: string; params?: unknown }): Promise<string> {
  const r = await q.query<{ id: string }>(
    `insert into ingestion_runs(source_id, area_id, kind, params) values ($1,$2,$3,$4) returning id`,
    [args.sourceId, args.areaId ?? null, args.kind, JSON.stringify(args.params ?? {})],
  );
  return r.rows[0]!.id;
}

export async function finishRun(q: Queryable, runId: string, args: { status: "succeeded" | "failed" | "partial"; counts?: Record<string, number>; costCents?: number; error?: string | null; cursor?: unknown }): Promise<void> {
  await q.query(
    `update ingestion_runs set finished_at = now(), status = $2, counts = $3, cost_cents = $4, error = $5, cursor = coalesce($6, cursor) where id = $1`,
    [runId, args.status, JSON.stringify(args.counts ?? {}), args.costCents ?? 0, args.error ?? null, args.cursor === undefined ? null : JSON.stringify(args.cursor)],
  );
}

export interface UpsertCounts {
  fetched: number;
  new: number;
  changed: number;
  unchanged: number;
  tombstoned: number;
}

/**
 * Upsert OSM elements as source_entities. Returns ids of records that are new or changed
 * so downstream normalization only touches what moved. Records present before but absent
 * from this full-area snapshot are tombstoned (deleted_at) — the source no longer lists them.
 * Only records inside the snapshot's own extent can be tombstoned: a small replay must never
 * retract what a wider fetch found.
 */
/** Who a snapshot is held for, and how far its records may lie (see upsertOsmElements). */
export interface SnapshotHolder {
  areaId: string;
  /** How far past the circle's center this snapshot keeps a record's point (its radius and slack). */
  keepM: number;
  /** The farthest any snapshot of the area keeps one, from the area's own center. */
  areaReach: SnapshotExtent;
}

/**
 * Store an area's snapshot: new and changed records written, and records no snapshot holds any more
 * withdrawn (tombstoned). The area holds every record the snapshot has (osm_area_records), one with
 * its point outside the circle "from outside" a circle that wide. It lets go of what it held and the
 * snapshot lacks: inside its circle, where the snapshot speaks for everything; from outside a circle
 * no wider than this one, where it could have kept it; and beyond the area's reach. A record is
 * withdrawn once no area holds it: another area's snapshot (from a mirror of another age, say) may
 * still have it. A smaller snapshot says nothing of the rest of the area.
 */
export async function upsertOsmElements(q: Queryable, runId: string, holder: SnapshotHolder, extent: SnapshotExtent, elements: OsmElement[], fetchedAt: Date): Promise<{ counts: UpsertCounts; touchedIds: string[] }> {
  const policy = await assertSourceAllowed(q, "osm", "retain");
  const retentionUntil = policy.retention_days ? new Date(fetchedAt.getTime() + policy.retention_days * 86_400_000) : null;
  const counts: UpsertCounts = { fetched: elements.length, new: 0, changed: 0, unchanged: 0, tombstoned: 0 };
  const touched: string[] = [];
  const seen: string[] = [];
  for (const el of elements) {
    const raw = { type: el.type, id: el.id, point: el.point, tags: el.tags, version: el.version, timestamp: el.sourceUpdatedAt?.toISOString() ?? null };
    const kind = isOsmParking(el.tags) ? "parking" : "venue";
    const hash = contentHash({ tags: el.tags, point: el.point });
    seen.push(el.externalId);
    const existing = await q.query<{ id: string; content_hash: string; deleted_at: Date | null; kind: string }>(
      `select id, content_hash, deleted_at, kind from source_entities where source_id = 'osm' and external_id = $1`,
      [el.externalId],
    );
    const prev = existing.rows[0];
    if (!prev) {
      const ins = await q.query<{ id: string }>(
        `insert into source_entities (source_id, external_id, kind, raw, content_hash, geom, first_seen_run_id, last_seen_run_id, source_updated_at, fetched_at, retention_until)
         values ('osm', $1, $10, $2, $3, ST_SetSRID(ST_MakePoint($4, $5), 4326)::geography, $6, $6, $7, $8, $9) returning id`,
        [el.externalId, JSON.stringify(raw), hash, el.point.lon, el.point.lat, runId, el.sourceUpdatedAt, fetchedAt, retentionUntil, kind],
      );
      counts.new++;
      touched.push(ins.rows[0]!.id);
      continue;
    }
    const changed = prev.content_hash !== hash || prev.deleted_at !== null || prev.kind !== kind;
    await q.query(
      `update source_entities set raw = $2, content_hash = $3, geom = ST_SetSRID(ST_MakePoint($4, $5), 4326)::geography,
              last_seen_run_id = $6, source_updated_at = $7, fetched_at = $8, retention_until = $9, deleted_at = null, kind = $10
        where id = $1`,
      [prev.id, JSON.stringify(raw), hash, el.point.lon, el.point.lat, runId, el.sourceUpdatedAt, fetchedAt, retentionUntil, kind],
    );
    if (changed) {
      counts.changed++;
      touched.push(prev.id);
    } else {
      counts.unchanged++;
    }
  }
  // The area holds what this snapshot has: from outside its circle when its point is past it.
  await q.query(
    `insert into osm_area_records (area_id, source_entity_id, run_id, outside_of_m)
     select $1, id, $2, case when ST_DWithin(geom, ST_SetSRID(ST_MakePoint($4, $5), 4326)::geography, $6) then null else ceil($6)::int end
       from source_entities where source_id = 'osm' and external_id = any($3::text[])
     on conflict (area_id, source_entity_id) do update set run_id = excluded.run_id, outside_of_m = excluded.outside_of_m`,
    [holder.areaId, runId, seen, extent.lon, extent.lat, extent.radiusM],
  );
  // And lets go of what it held that this snapshot lacks: inside the circle; from outside a circle no
  // wider than this one, that this snapshot could have kept; and beyond anything the area keeps
  // (stored before records were kept by their point).
  const released = (
    await q.query<{ source_entity_id: string }>(
      `delete from osm_area_records o using source_entities s
        where o.area_id = $1 and o.run_id <> $2 and s.id = o.source_entity_id
          and (ST_DWithin(s.geom, ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography, $10)
               or (o.outside_of_m <= $9 and ST_DWithin(s.geom, ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography, $5))
               or not ST_DWithin(s.geom, ST_SetSRID(ST_MakePoint($6, $7), 4326)::geography, $8))
        returning o.source_entity_id`,
      [holder.areaId, runId, extent.lon, extent.lat, holder.keepM, holder.areaReach.lon, holder.areaReach.lat, holder.areaReach.radiusM, Math.ceil(extent.radiusM), extent.radiusM],
    )
  ).rows.map((r) => r.source_entity_id);
  // Withdrawn once no area holds it: what this area let go of, and what it lacks inside its circle
  // that no one held (nothing the snapshot doesn't have is left standing for want of a holder).
  const tomb = await q.query<{ id: string }>(
    `update source_entities s set deleted_at = now()
      where s.source_id = 'osm' and s.kind in ('venue', 'parking') and s.deleted_at is null
        and not (s.external_id = any($1::text[]))
        and (s.id = any($5::uuid[]) or ST_DWithin(s.geom, ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography, $4))
        and not exists (select 1 from osm_area_records o where o.source_entity_id = s.id)
      returning s.id`,
    [seen, extent.lon, extent.lat, extent.radiusM, released],
  );
  counts.tombstoned = tomb.rowCount ?? 0;
  touched.push(...tomb.rows.map((r) => r.id));
  return { counts, touchedIds: touched };
}

export async function sourceAttribution(q: Queryable, sourceId: string): Promise<string | null> {
  return (await getSourcePolicy(q, sourceId)).attribution;
}
