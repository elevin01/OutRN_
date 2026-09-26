import { writeFile } from "node:fs/promises";
import type { Category } from "@outrn/core";
import { assertSourceAllowed, getArea, withTx, type Db, type Queryable } from "@outrn/db";
import { materializeSubjects, retractSourceFacts, writeFacts } from "@outrn/facts";
import { resolveOne, type ResolveOutcome } from "@outrn/identity";
import { fetchArea, finishRun, loadAreaFromFile, normalizeElements, startRun, upsertOsmElements, type OsmElement } from "@outrn/sources";
import { normalizeOsm } from "./osm-normalize.js";

/**
 * Supply pipeline for one service area:
 *   fetch/replay → raw store → identity → facts → materialize
 * Each stage reports counts. Nothing downstream runs on records the raw store says are unchanged.
 */

export interface IngestOptions {
  areaSlug: string;
  /** Replay a saved Overpass response instead of fetching. */
  fromFile?: string;
  /** Save the fetched response for later replay (only meaningful with a live fetch). */
  saveTo?: string;
  log?: (line: string) => void;
}

export interface IngestSummary {
  runId: string;
  area: string;
  fetched: number;
  dropped: number;
  raw: { new: number; changed: number; unchanged: number; tombstoned: number };
  venues: { created: number; linked: number; review: number; children: number; skipped: number };
  facts: { inserted: number; superseded: number; rejected: number };
  materialized: { subjects: number; conflicts: number; tasks: number };
  osmBaseTimestamp: string | null;
}

export async function ingestOsmArea(db: Db, opts: IngestOptions): Promise<IngestSummary> {
  const log = opts.log ?? (() => undefined);
  const area = await getArea(db, opts.areaSlug);
  if (!opts.fromFile) await assertSourceAllowed(db, "osm", "fetch");
  const runId = await startRun(db, { sourceId: "osm", areaId: area.id, kind: opts.fromFile ? "replay" : "overpass_area", params: { radius_m: area.radius_m, from_file: opts.fromFile ?? null } });
  try {
    const result = opts.fromFile ? await loadAreaFromFile(opts.fromFile) : await fetchArea({ lat: area.lat, lon: area.lon }, area.radius_m ?? 1500);
    if (opts.saveTo && !opts.fromFile) await writeFile(opts.saveTo, JSON.stringify(result.response), "utf8");
    const { elements, baseTimestamp, dropped } = normalizeElements(result.response);
    log(`fetched ${elements.length} named elements (${dropped} dropped: no name or no geometry)`);

    const rawOut = await withTx(db, (tx) => upsertOsmElements(tx, runId, area.id, elements, result.fetchedAt));
    log(`raw: ${rawOut.counts.new} new, ${rawOut.counts.changed} changed, ${rawOut.counts.unchanged} unchanged, ${rawOut.counts.tombstoned} tombstoned`);

    const proc = await withTx(db, (tx) => processSourceEntities(tx, rawOut.touchedIds, { areaId: area.id, timezone: area.timezone, runId, fetchedAt: result.fetchedAt, log }));
    const mat = await withTx(db, (tx) => materializeSubjects(tx, "venue", [...proc.venueIds]));
    log(`materialized ${mat.subjects} venues, ${mat.conflicts} conflicting attributes, ${mat.tasksCreated} verification tasks`);

    await finishRun(db, runId, { status: "succeeded", counts: { ...rawOut.counts, dropped, venues_created: proc.created, facts_inserted: proc.factsInserted }, cursor: { osm_base: baseTimestamp?.toISOString() ?? null } });
    return {
      runId,
      area: area.slug,
      fetched: elements.length,
      dropped,
      raw: rawOut.counts,
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
  for (const row of rows) {
    if (row.deleted_at) {
      const linked = await q.query<{ venue_id: string }>(`select venue_id from entity_links where source_entity_id = $1 and superseded_by is null`, [row.id]);
      for (const l of linked.rows) {
        s.factsSuperseded += await retractSourceFacts(q, "venue", l.venue_id, "osm");
        s.venueIds.add(l.venue_id);
      }
      continue;
    }
    const norm = normalizeOsm({ externalId: row.external_id, point: row.raw.point, tags: row.raw.tags, sourceUpdatedAt: row.source_updated_at }, o.fetchedAt);
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
    if (norm.rejects.length) o.log(`  ${row.external_id} "${norm.name}": ${norm.rejects.join("; ")}`);
  }
  return s;
}
