import { writeFile } from "node:fs/promises";
import { DEFAULT_MAX_TRAVEL_MINUTES, maxReachMetres, parkingBufferAt, type Category, type ParkingRule } from "@outrn/core";
import { assertSourceAllowed, getArea, loadParkingRule, withTx, type Db, type Queryable, type ServiceAreaRow } from "@outrn/db";
import { materializeSubjects, retractSourceFacts, retractSourceFactsExcept, writeFacts } from "@outrn/facts";
import { resolveOne, type ResolveOutcome } from "@outrn/identity";
import { captureWithExtent, fetchArea, finishRun, loadAreaFromFile, normalizeElements, startRun, upsertOsmElements, type SnapshotExtent } from "@outrn/sources";
import { normalizeOsm, OSM_NORMALIZE_VERSION } from "./osm-normalize.js";

/**
 * Supply pipeline for one service area:
 *   fetch/replay → raw store → identity → facts → materialize
 * Each stage reports counts. Nothing downstream runs on records the raw store says are unchanged,
 * unless the normalizer's rules have changed since, or a date in their tags has come due.
 */

export interface IngestOptions {
  areaSlug: string;
  /** Replay a saved Overpass response instead of fetching. */
  fromFile?: string;
  /** Save the fetched response for later replay (only meaningful with a live fetch). */
  saveTo?: string;
  /** Override the derived ingest radius (live fetch), or declare what a replayed capture covers. */
  radiusM?: number;
  /** The instant a replay is ingested at (tests, backfills). A live fetch always uses its own fetch time. */
  clock?: () => Date;
  log?: (line: string) => void;
}

export interface IngestSummary {
  runId: string;
  area: string;
  /** Extent the snapshot covers (and tombstones within), metres from the area center. */
  extentM: number;
  fetched: number;
  dropped: number;
  raw: { new: number; changed: number; unchanged: number; tombstoned: number; renormalized: number };
  venues: { created: number; linked: number; review: number; children: number; skipped: number };
  facts: { inserted: number; superseded: number; rejected: number };
  materialized: { subjects: number; conflicts: number; tasks: number };
  osmBaseTimestamp: string | null;
}

/**
 * How far to ingest around an area: its origin catchment plus the farthest the engine could ever
 * call reachable within the mode's max travel time (with the area's parking rule), rounded up to
 * 100 m. For a drive catchment this is kilometres, not the walkable village center.
 */
export function ingestExtentFor(area: Pick<ServiceAreaRow, "radius_m" | "travel_mode">, parking: ParkingRule | null): { catchmentM: number; reachM: number; radiusM: number } {
  const catchmentM = area.radius_m ?? 1500;
  const reachM = Math.round(maxReachMetres(area.travel_mode, DEFAULT_MAX_TRAVEL_MINUTES[area.travel_mode], { parkingBufferForHour: (h) => parkingBufferAt(parking, h) }));
  return { catchmentM, reachM, radiusM: Math.ceil((catchmentM + reachM) / 100) * 100 };
}

export async function ingestOsmArea(db: Db, opts: IngestOptions): Promise<IngestSummary> {
  const log = opts.log ?? (() => undefined);
  const area = await getArea(db, opts.areaSlug);
  if (!opts.fromFile) await assertSourceAllowed(db, "osm", "fetch");
  const derived = ingestExtentFor(area, await loadParkingRule(db, area.slug));
  const radiusM = opts.radiusM ?? derived.radiusM;
  const runId = await startRun(db, { sourceId: "osm", areaId: area.id, kind: opts.fromFile ? "replay" : "overpass_area", params: { radius_m: radiusM, catchment_m: derived.catchmentM, reach_m: derived.reachM, override: opts.radiusM ?? null, from_file: opts.fromFile ?? null } });
  try {
    const center = { lat: area.lat, lon: area.lon };
    if (!opts.fromFile) log(`fetching ${radiusM} m around ${area.slug}${opts.radiusM ? " (override)" : ` (catchment ${derived.catchmentM} m + ${area.travel_mode} reach ${derived.reachM} m)`}`);
    const fetched = opts.fromFile ? await loadAreaFromFile(opts.fromFile) : await fetchArea(center, radiusM);
    const result = opts.fromFile && opts.clock ? { ...fetched, fetchedAt: opts.clock() } : fetched;
    const now = result.fetchedAt;
    // A replay without a saved extent is treated as covering the catchment only (the old capture size).
    const extent: SnapshotExtent = result.extent ?? { ...center, radiusM: opts.radiusM ?? area.radius_m ?? 1500 };
    if (opts.saveTo && !opts.fromFile) await writeFile(opts.saveTo, JSON.stringify(captureWithExtent(result.response, extent)), "utf8");
    const { elements, baseTimestamp, dropped } = normalizeElements(result.response);
    log(`fetched ${elements.length} named elements (${dropped} dropped: no name or no geometry)`);

    const rawOut = await withTx(db, (tx) => upsertOsmElements(tx, runId, extent, elements, result.fetchedAt));
    log(`raw: ${rawOut.counts.new} new, ${rawOut.counts.changed} changed, ${rawOut.counts.unchanged} unchanged, ${rawOut.counts.tombstoned} tombstoned`);

    // Unchanged records still need processing when the rules that turn tags into facts changed since,
    // or a date in their tags (a closing date, an opening date, a survey's expiry) has come due.
    const stale = (
      await db.query<{ id: string }>(
        `select id from source_entities where source_id = 'osm' and deleted_at is null and last_seen_run_id = $1
            and (normalized_with is distinct from $2 or renormalize_at <= $4) and not (id = any($3::uuid[]))`,
        [runId, OSM_NORMALIZE_VERSION, rawOut.touchedIds, now],
      )
    ).rows.map((r) => r.id);
    if (stale.length) log(`re-normalizing ${stale.length} unchanged records (rules now ${OSM_NORMALIZE_VERSION}, or a date in their tags came due)`);

    const proc = await withTx(db, (tx) => processSourceEntities(tx, [...rawOut.touchedIds, ...stale], { areaId: area.id, timezone: area.timezone, runId, fetchedAt: now, log }));
    const mat = await withTx(db, (tx) => materializeSubjects(tx, "venue", [...proc.venueIds], now));
    log(`materialized ${mat.subjects} venues, ${mat.conflicts} conflicting attributes, ${mat.tasksCreated} verification tasks`);

    await finishRun(db, runId, { status: "succeeded", counts: { ...rawOut.counts, dropped, venues_created: proc.created, facts_inserted: proc.factsInserted }, cursor: { osm_base: baseTimestamp?.toISOString() ?? null } });
    return {
      runId,
      area: area.slug,
      extentM: extent.radiusM,
      fetched: elements.length,
      dropped,
      raw: { ...rawOut.counts, renormalized: stale.length },
      venues: { created: proc.created, linked: proc.linked, review: proc.review, children: proc.children, skipped: proc.skipped },
      facts: { inserted: proc.factsInserted, superseded: proc.factsSuperseded, rejected: proc.factsRejected },
      materialized: { subjects: mat.subjects, conflicts: mat.conflicts, tasks: mat.tasksCreated },
      osmBaseTimestamp: baseTimestamp?.toISOString() ?? null,
    };
  } catch (e) {
    await finishRun(db, runId, { status: "failed", error: (e as Error).message });
    throw e;
  }
}

interface ProcessOpts {
  areaId: string;
  timezone: string;
  runId: string;
  fetchedAt: Date;
  log: (line: string) => void;
}

interface ProcessSummary {
  created: number;
  linked: number;
  review: number;
  children: number;
  skipped: number;
  factsInserted: number;
  factsSuperseded: number;
  factsRejected: number;
  venueIds: Set<string>;
}

interface RawRow {
  id: string;
  external_id: string;
  raw: { point: { lat: number; lon: number }; tags: Record<string, string>; timestamp: string | null };
  deleted_at: Date | null;
  source_updated_at: Date | null;
}

export async function processSourceEntities(q: Queryable, sourceEntityIds: string[], o: ProcessOpts): Promise<ProcessSummary> {
  const s: ProcessSummary = { created: 0, linked: 0, review: 0, children: 0, skipped: 0, factsInserted: 0, factsSuperseded: 0, factsRejected: 0, venueIds: new Set() };
  if (!sourceEntityIds.length) return s;
  // Process ways/relations (buildings, parks) before nodes so a node inside a mapped building matches the venue, not the reverse.
  const rows = (
    await q.query<RawRow>(
      `select id, external_id, raw, deleted_at, source_updated_at from source_entities where id = any($1::uuid[])
        order by case when external_id like 'relation/%' then 0 when external_id like 'way/%' then 1 else 2 end, external_id`,
      [sourceEntityIds],
    )
  ).rows;
  const due = new Map<string, Date | null>();
  for (const row of rows) {
    if (row.deleted_at) {
      const linked = await q.query<{ venue_id: string }>(`select venue_id from entity_links where source_entity_id = $1 and superseded_by is null`, [row.id]);
      for (const l of linked.rows) {
        s.factsSuperseded += await retractSourceFacts(q, "venue", l.venue_id, "osm");
        s.venueIds.add(l.venue_id);
      }
      continue;
    }
    const norm = normalizeOsm({ externalId: row.external_id, point: row.raw.point, timezone: o.timezone, tags: row.raw.tags, sourceUpdatedAt: row.source_updated_at }, o.fetchedAt);
    due.set(row.id, norm.changesAt);
    if (norm.rejects.some((r) => r === "no name" || r === "no mapped category")) {
      s.skipped++;
      continue;
    }
    const t = row.raw.tags;
    const outcome: ResolveOutcome = await resolveOne(q, {
      sourceEntityId: row.id,
      areaId: o.areaId,
      timezone: o.timezone,
      record: {
        name: norm.name,
        category: norm.category as Category,
        point: norm.point,
        website: norm.websiteKey,
        phone: norm.phone,
        housenumber: t["addr:housenumber"] ?? null,
        street: t["addr:street"] ?? null,
        brand: t["brand"] ?? null,
        xids: t["wikidata"] ? { wikidata: t["wikidata"] } : {},
      },
    });
    if (outcome.created) s.created++;
    else s.linked++;
    if (outcome.decision === "review") s.review++;
    if (outcome.parentVenueId) s.children++;
    s.venueIds.add(outcome.venueId);
    const w = await writeFacts(
      q,
      norm.facts.map((f) => ({ ...f, subjectKind: "venue" as const, subjectId: outcome.venueId, fetchedAt: o.fetchedAt, ingestionRunId: o.runId })),
    );
    s.factsInserted += w.inserted;
    s.factsSuperseded += w.superseded;
    s.factsRejected += w.rejected.length;
    // A tag removed upstream takes its fact along, when this record is the venue's only OSM input
    // (with two, the other record may still assert it).
    const osmInputs = await q.query<{ n: string }>(
      `select count(*) as n from entity_links el join source_entities se on se.id = el.source_entity_id
        where el.venue_id = $1 and el.superseded_by is null and el.decision <> 'rejected' and se.source_id = 'osm' and se.deleted_at is null`,
      [outcome.venueId],
    );
    if (Number(osmInputs.rows[0]!.n) === 1) s.factsSuperseded += await retractSourceFactsExcept(q, "venue", outcome.venueId, "osm", norm.facts.map((f) => f.attribute));
    if (norm.rejects.length) o.log(`  ${row.external_id} "${norm.name}": ${norm.rejects.join("; ")}`);
  }
  const normalized = rows.filter((r) => !r.deleted_at).map((r) => r.id);
  if (normalized.length) {
    await q.query(
      `update source_entities s set normalized_with = $3, renormalize_at = d.at
         from unnest($1::uuid[], $2::timestamptz[]) as d(id, at) where s.id = d.id`,
      [normalized, normalized.map((id) => due.get(id) ?? null), OSM_NORMALIZE_VERSION],
    );
  }
  return s;
}
