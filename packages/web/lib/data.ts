import "server-only";

import type { Category, TravelMode } from "@outrn/core";
import { CATEGORIES } from "@outrn/core";
import { getArea, getDb, listAreas, type ServiceAreaRow } from "@outrn/db";
import {
  explain,
  loadCandidates,
  loadPolicies,
  persistRun,
  recommend,
  type Evaluation,
  type RequestContext,
} from "@outrn/engine";

export interface RecommendationInput {
  area: string;
  minutes: number;
  mode?: string | undefined;
  budget?: string | undefined;
  mood?: string | undefined;
  company?: string | undefined;
  category?: string | undefined;
  at?: string | undefined;
  /** "More options": how many options to skip in the display order. */
  offset?: number | undefined;
}

export interface RecommendationOutput {
  area: ServiceAreaRow;
  context: RequestContext;
  items: Array<{ evaluation: Evaluation; copy: ReturnType<typeof explain> }>;
  all: Evaluation[];
  fewerThanThree: boolean;
  relaxations: string[];
  offset: number;
  hasMore: boolean;
  runId: string;
  durationMs: number;
}

const MODES = new Set(["walk", "drive", "transit"]);
const MOODS = new Set(["relaxed", "active", "food", "culture"]);
const COMPANIES = new Set(["alone", "date", "friends", "family"]);

export async function areas(): Promise<ServiceAreaRow[]> {
  return listAreas(getDb());
}

export async function runRecommendation(input: RecommendationInput): Promise<RecommendationOutput> {
  const db = getDb();
  const area = await getArea(db, input.area);
  const now = input.at ? new Date(input.at) : new Date();
  if (Number.isNaN(now.getTime())) throw new Error("The requested time is not a valid ISO timestamp.");
  const mode = (input.mode && MODES.has(input.mode) ? input.mode : area.travel_mode) as TravelMode;
  const context: RequestContext = {
    origin: { lat: area.lat, lon: area.lon },
    now,
    windowMinutes: input.minutes,
    mode,
    timezone: area.timezone,
  };
  if (input.budget === "free") context.budget = "free";
  else if (input.budget && Number.isFinite(Number(input.budget))) context.budget = Math.max(0, Number(input.budget));
  if (input.mood && MOODS.has(input.mood)) context.mood = input.mood as NonNullable<RequestContext["mood"]>;
  if (input.company && COMPANIES.has(input.company)) context.company = input.company as NonNullable<RequestContext["company"]>;
  if (input.category && (CATEGORIES as readonly string[]).includes(input.category)) context.categories = [input.category as Category];

  const started = Date.now();
  const windowEnd = new Date(now.getTime() + input.minutes * 60_000);
  const [candidates, policies] = await Promise.all([
    loadCandidates(db, context.origin, mode, now, windowEnd),
    loadPolicies(db),
  ]);
  const shortlist = recommend(candidates, context, policies, { offset: input.offset ?? 0 });
  const durationMs = Date.now() - started;
  const runId = await persistRun(db, area.id, context, shortlist, durationMs);
  return {
    area,
    context,
    items: shortlist.items.map((evaluation) => ({ evaluation, copy: explain(evaluation, area.timezone) })),
    all: shortlist.all,
    fewerThanThree: shortlist.fewerThanThree,
    relaxations: shortlist.relaxations,
    offset: shortlist.offset,
    hasMore: shortlist.hasMore,
    runId,
    durationMs,
  };
}

export interface PlaceDetail {
  id: string;
  name: string;
  category: string;
  lat: number;
  lon: number;
  timezone: string;
  publishState: string;
  facts: Record<string, { value: unknown; confidence: number; evidenceClass: string; validUntil: string | null }>;
  tags: Record<string, string>;
}

export async function place(id: string): Promise<PlaceDetail | null> {
  const row = (
    await getDb().query<{
      id: string;
      canonical_name: string;
      category: string;
      lat: number;
      lon: number;
      timezone: string;
      publish_state: string;
      facts: Record<string, { value: unknown; confidence: string; evidenceClass: string; validUntil: string | null }>;
      tags: Record<string, string> | null;
    }>(
      `select v.id, v.canonical_name, v.category,
              ST_Y(v.geom::geometry) as lat, ST_X(v.geom::geometry) as lon,
              v.timezone, v.publish_state,
              coalesce((select jsonb_object_agg(cf.attribute, jsonb_build_object(
                'value', cf.value, 'confidence', cf.confidence,
                'evidenceClass', cf.evidence_class, 'validUntil', cf.valid_until))
                from current_facts cf where cf.subject_kind = 'venue' and cf.subject_id = v.id), '{}'::jsonb) facts,
              (select se.raw->'tags' from entity_links el join source_entities se on se.id = el.source_entity_id
                where el.venue_id = v.id and el.superseded_by is null order by el.decided_at desc limit 1) tags
         from venues v where v.id = $1`,
      [id],
    )
  ).rows[0];
  if (!row) return null;
  return {
    id: row.id,
    name: row.canonical_name,
    category: row.category,
    lat: Number(row.lat),
    lon: Number(row.lon),
    timezone: row.timezone,
    publishState: row.publish_state,
    facts: Object.fromEntries(Object.entries(row.facts).map(([key, fact]) => [key, { ...fact, confidence: Number(fact.confidence) }])),
    tags: row.tags ?? {},
  };
}

export interface RunSummary {
  id: string;
  area: string | null;
  context: Record<string, unknown>;
  candidateCount: number;
  durationMs: number | null;
  engineVersion: string;
  createdAt: Date;
}

export async function recentRuns(limit = 20): Promise<RunSummary[]> {
  const rows = (
    await getDb().query<{
      id: string;
      area: string | null;
      context: Record<string, unknown>;
      candidate_count: number;
      duration_ms: number | null;
      engine_version: string;
      created_at: Date;
    }>(
      `select rr.id, sa.name area, rr.context, rr.candidate_count, rr.duration_ms,
              rr.engine_version, rr.created_at
         from recommendation_runs rr left join service_areas sa on sa.id = rr.area_id
        order by rr.created_at desc limit $1`,
      [limit],
    )
  ).rows;
  return rows.map((row) => ({
    id: row.id,
    area: row.area,
    context: row.context,
    candidateCount: row.candidate_count,
    durationMs: row.duration_ms,
    engineVersion: row.engine_version,
    createdAt: row.created_at,
  }));
}

interface StoredResult {
  item_kind: "venue" | "occurrence";
  item_id: string;
  class: "ready" | "check_first" | "ineligible";
  excluded_by: string | null;
  reasons: string[];
  unresolved: string[];
  scores: Record<string, number>;
  useful_minutes: number | null;
  travel_minutes: number | null;
}

export interface RunDetail extends RunSummary {
  weightsVersion: string;
  shortlistIds: string[];
  results: Array<StoredResult & { name: string; category: string }>;
}

export async function recommendationRun(id: string): Promise<RunDetail | null> {
  const row = (
    await getDb().query<{
      id: string;
      area: string | null;
      context: Record<string, unknown>;
      candidate_count: number;
      duration_ms: number | null;
      engine_version: string;
      weights_version: string;
      created_at: Date;
      results: StoredResult[];
      shortlist: Array<{ item_id: string }>;
    }>(
      `select rr.*, sa.name area from recommendation_runs rr
        left join service_areas sa on sa.id = rr.area_id where rr.id = $1`,
      [id],
    )
  ).rows[0];
  if (!row) return null;
  const ids = row.results.map((result) => result.item_id);
  const named = ids.length
    ? (
        await getDb().query<{ id: string; name: string; category: string }>(
          `select v.id, v.canonical_name name, v.category from venues v where v.id = any($1::uuid[])
           union all
           select o.id, o.title name, v.category from occurrences o join venues v on v.id = o.venue_id
            where o.id = any($1::uuid[])`,
          [ids],
        )
      ).rows
    : [];
  const names = new Map(named.map((item) => [item.id, item]));
  return {
    id: row.id,
    area: row.area,
    context: row.context,
    candidateCount: row.candidate_count,
    durationMs: row.duration_ms,
    engineVersion: row.engine_version,
    weightsVersion: row.weights_version,
    createdAt: row.created_at,
    shortlistIds: row.shortlist.map((item) => item.item_id),
    results: row.results.map((result) => ({
      ...result,
      name: names.get(result.item_id)?.name ?? result.item_id,
      category: names.get(result.item_id)?.category ?? result.item_kind,
    })),
  };
}
