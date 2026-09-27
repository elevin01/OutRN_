import type { OpsCandidate, OpsRunDetail, OpsRunList, RecommendationRequest } from "@outrn/contracts";
import type { Queryable } from "@outrn/db";
import type { Evaluation } from "@outrn/engine";
import { ApiProblem, isUuid } from "../errors.js";
import { runEngine, type ServiceOptions } from "./recommendations.js";

/** Operator diagnostics: every candidate with its gate decision and scores. Never the consumer API. */

function counts(results: OpsCandidate[]): OpsRunDetail["counts"] {
  const n = (cls: OpsCandidate["class"]) => results.filter((r) => r.class === cls).length;
  return { total: results.length, ready: n("ready"), check_first: n("check_first"), ineligible: n("ineligible") };
}

function candidateOf(e: Evaluation, shortlisted: Set<string>): OpsCandidate {
  return {
    itemId: e.candidate.id,
    kind: e.candidate.kind === "occurrence" ? "event" : "venue",
    placeId: e.candidate.venueId,
    name: e.candidate.name,
    category: e.candidate.category,
    class: e.class,
    excludedBy: e.excludedBy,
    reasons: e.reasons,
    unresolved: e.unresolved,
    travelMinutes: e.timing?.travel.minutes ?? null,
    usefulMinutes: e.timing?.usefulMinutes ?? null,
    scores: e.scores,
    shortlisted: shortlisted.has(e.candidate.id),
  };
}

export async function evaluate(q: Queryable, request: RecommendationRequest, opts: ServiceOptions = {}): Promise<OpsRunDetail> {
  // Operators may evaluate an area before it opens.
  const run = await runEngine(q, request, { ...opts, overrides: { ...opts.overrides, includeUnlaunched: true } });
  const shortlisted = new Set(run.shortlist.items.map((e) => e.candidate.id));
  const results = run.shortlist.all.map((e) => candidateOf(e, shortlisted));
  const stored = (await q.query<{ context: Record<string, unknown>; created_at: Date }>(`select context, created_at from recommendation_runs where id = $1`, [run.runId])).rows[0]!;
  return {
    id: run.runId!,
    areaName: run.area.name,
    createdAt: stored.created_at.toISOString(),
    candidateCount: results.length,
    durationMs: run.durationMs,
    engineVersion: run.shortlist.engineVersion,
    weightsVersion: run.shortlist.weightsVersion,
    context: stored.context,
    counts: counts(results),
    results,
  };
}

export async function recentRuns(q: Queryable, limit = 20): Promise<OpsRunList> {
  const rows = (
    await q.query<{ id: string; area: string | null; candidate_count: number; duration_ms: number | null; engine_version: string; weights_version: string; created_at: Date }>(
      `select rr.id, sa.name area, rr.candidate_count, rr.duration_ms, rr.engine_version, rr.weights_version, rr.created_at
         from recommendation_runs rr left join service_areas sa on sa.id = rr.area_id
        order by rr.created_at desc limit $1`,
      [Math.min(Math.max(1, limit), 100)],
    )
  ).rows;
  return { runs: rows.map((r) => ({ id: r.id, areaName: r.area, createdAt: r.created_at.toISOString(), candidateCount: r.candidate_count, durationMs: r.duration_ms, engineVersion: r.engine_version, weightsVersion: r.weights_version })) };
}

interface StoredResult {
  item_kind: "venue" | "occurrence";
  item_id: string;
  class: OpsCandidate["class"];
  excluded_by: string | null;
  reasons: string[];
  unresolved: string[];
  scores: Partial<OpsCandidate["scores"]>;
  useful_minutes: number | null;
  travel_minutes: number | null;
}

export async function storedRun(q: Queryable, id: string): Promise<OpsRunDetail> {
  if (!isUuid(id)) throw new ApiProblem("NOT_FOUND", "No run with this id.");
  const row = (
    await q.query<{ id: string; area: string | null; context: Record<string, unknown>; candidate_count: number; duration_ms: number | null; engine_version: string; weights_version: string; created_at: Date; results: StoredResult[]; shortlist: Array<{ item_id: string }> }>(
      `select rr.id, sa.name area, rr.context, rr.candidate_count, rr.duration_ms, rr.engine_version, rr.weights_version, rr.created_at, rr.results, rr.shortlist
         from recommendation_runs rr left join service_areas sa on sa.id = rr.area_id where rr.id = $1`,
      [id],
    )
  ).rows[0];
  if (!row) throw new ApiProblem("NOT_FOUND", "No run with this id.");
  const ids = row.results.map((r) => r.item_id);
  const named = ids.length
    ? (
        await q.query<{ id: string; name: string; category: string; place_id: string }>(
          `select v.id, v.canonical_name name, v.category, v.id place_id from venues v where v.id = any($1::uuid[])
           union all
           select o.id, o.title name, v.category, v.id place_id from occurrences o join venues v on v.id = o.venue_id where o.id = any($1::uuid[])`,
          [ids],
        )
      ).rows
    : [];
  const names = new Map(named.map((n) => [n.id, n]));
  const shortlisted = new Set(row.shortlist.map((s) => s.item_id));
  const results: OpsCandidate[] = row.results.map((r) => ({
    itemId: r.item_id,
    kind: r.item_kind === "occurrence" ? "event" : "venue",
    placeId: names.get(r.item_id)?.place_id ?? null,
    name: names.get(r.item_id)?.name ?? r.item_id,
    category: names.get(r.item_id)?.category ?? r.item_kind,
    class: r.class,
    excludedBy: r.excluded_by,
    reasons: r.reasons,
    unresolved: r.unresolved,
    travelMinutes: r.travel_minutes,
    usefulMinutes: r.useful_minutes,
    scores: { evidence: r.scores.evidence ?? 0, fit: r.scores.fit ?? 0, appeal: r.scores.appeal ?? 0, novelty: r.scores.novelty ?? 0 },
    shortlisted: shortlisted.has(r.item_id),
  }));
  return {
    id: row.id,
    areaName: row.area,
    createdAt: row.created_at.toISOString(),
    candidateCount: row.candidate_count,
    durationMs: row.duration_ms,
    engineVersion: row.engine_version,
    weightsVersion: row.weights_version,
    context: row.context,
    counts: counts(results),
    results,
  };
}
