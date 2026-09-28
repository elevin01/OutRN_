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
export async function upsertOsmElements(q: Queryable, runId: string, extent: SnapshotExtent, elements: OsmElement[], fetchedAt: Date): Promise<{ counts: UpsertCounts; touchedIds: string[] }> {
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
  // Tombstone records in this snapshot's extent that it no longer contains.
  const tomb = await q.query<{ id: string }>(
    `update source_entities s set deleted_at = now()
      where s.source_id = 'osm' and s.kind in ('venue', 'parking') and s.deleted_at is null
        and ST_DWithin(s.geom, ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography, $4)
        and not (s.external_id = any($1::text[]))
      returning s.id`,
    [seen, extent.lon, extent.lat, extent.radiusM],
  );
  counts.tombstoned = tomb.rowCount ?? 0;
  touched.push(...tomb.rows.map((r) => r.id));
  return { counts, touchedIds: touched };
}

export async function sourceAttribution(q: Queryable, sourceId: string): Promise<string | null> {
  return (await getSourcePolicy(q, sourceId)).attribution;
}
