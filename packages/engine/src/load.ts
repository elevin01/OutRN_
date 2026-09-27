import SunCalc from "suncalc";
import type { Attribute, Category, LatLon, TravelMode } from "@outrn/core";
import { loadCategoryPolicies, type Queryable } from "@outrn/db";
import type { Candidate, CategoryPolicy, FactView, OccurrenceView, RequestContext, Shortlist } from "./types.js";

/**
 * Loads candidates from the materialized tables. The request path reads current_facts, venues,
 * occurrences and overrides only — never raw source records and never an external API.
 */

const METRES_PER_MIN: Record<TravelMode, number> = { walk: 80 / 1.3, drive: 500, transit: 250 };
const DEFAULT_MAX_TRAVEL: Record<TravelMode, number> = { walk: 25, drive: 30, transit: 35 };

interface VenueRow {
  id: string;
  canonical_name: string;
  category: Category;
  lat: number;
  lon: number;
  timezone: string;
  parent_venue_id: string | null;
  facts: Record<string, { value: unknown; confidence: string; evidence_class: FactView["evidenceClass"]; valid_until: string | null; independent_sources: number }>;
  boost: string | null;
  excluded: boolean;
  has_landmark: boolean;
}

interface OccRow {
  id: string;
  venue_id: string;
  title: string;
  start_at: Date;
  end_at: Date | null;
  entry_cutoff_at: Date | null;
  late_entry: boolean | null;
  status: OccurrenceView["status"];
}

function toFacts(raw: VenueRow["facts"], now: Date): Partial<Record<Attribute, FactView>> {
  const out: Partial<Record<Attribute, FactView>> = {};
  for (const [k, v] of Object.entries(raw ?? {})) {
    const validUntil = v.valid_until ? new Date(v.valid_until) : null;
    if (validUntil && validUntil <= now) continue; // expiry enforced at request time even if the job is late
    out[k as Attribute] = { value: v.value, confidence: Number(v.confidence), evidenceClass: v.evidence_class, validUntil, independentSources: v.independent_sources };
  }
  return out;
}

export async function loadCandidates(q: Queryable, origin: LatLon, mode: TravelMode, now: Date, windowEnd: Date, maxTravelMinutes?: number): Promise<Candidate[]> {
  const radius = (maxTravelMinutes ?? DEFAULT_MAX_TRAVEL[mode]) * METRES_PER_MIN[mode] * 1.15;
  const venues = (
    await q.query<VenueRow>(
      `select v.id, v.canonical_name, v.category, ST_Y(v.geom::geometry) as lat, ST_X(v.geom::geometry) as lon, v.timezone, v.parent_venue_id,
              coalesce((select jsonb_object_agg(cf.attribute, jsonb_build_object('value', cf.value, 'confidence', cf.confidence, 'evidence_class', cf.evidence_class, 'valid_until', cf.valid_until, 'independent_sources', cf.independent_sources))
                          from current_facts cf where cf.subject_kind = 'venue' and cf.subject_id = v.id), '{}'::jsonb) as facts,
              (select sum(weight) from venue_overrides o where o.venue_id = v.id and o.kind = 'boost' and (o.expires_at is null or o.expires_at > $4)) as boost,
              exists(select 1 from venue_overrides o where o.venue_id = v.id and o.kind = 'exclude' and (o.expires_at is null or o.expires_at > $4)) as excluded,
              exists(select 1 from entity_links l join source_entities se on se.id = l.source_entity_id where l.venue_id = v.id and l.superseded_by is null and se.raw->'tags' ? 'wikidata') as has_landmark
         from venues v
        where v.publish_state = 'eligible'
          and ST_DWithin(v.geom, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, $3)`,
      [origin.lon, origin.lat, radius, now],
    )
  ).rows;
  const byVenue = new Map(venues.map((v) => [v.id, v]));
  const candidates: Candidate[] = venues.map((v) => ({
    kind: "venue",
    id: v.id,
    venueId: v.id,
    name: v.canonical_name,
    category: v.category,
    point: { lat: v.lat, lon: v.lon },
    timezone: v.timezone,
    facts: toFacts(v.facts, now),
    parentVenueId: v.parent_venue_id,
    boost: Number(v.boost ?? 0),
    excluded: v.excluded,
    hasLandmarkId: v.has_landmark,
  }));
  if (!venues.length) return candidates;
  const occ = (
    await q.query<OccRow>(
      `select id, venue_id, title, start_at, end_at, entry_cutoff_at, late_entry, status from occurrences
        where venue_id = any($1::uuid[]) and status <> 'ended'
          and coalesce(end_at, start_at + interval '2 hours') > $2 and start_at < $3`,
      [venues.map((v) => v.id), now, windowEnd],
    )
  ).rows;
  for (const o of occ) {
    const v = byVenue.get(o.venue_id)!;
    const venueFacts = toFacts(v.facts, now);
    const occFacts = (await q.query<{ attribute: Attribute; value: unknown; confidence: string; evidence_class: FactView["evidenceClass"]; valid_until: Date | null; independent_sources: number }>(`select attribute, value, confidence, evidence_class, valid_until, independent_sources from current_facts where subject_kind = 'occurrence' and subject_id = $1`, [o.id])).rows;
    const facts = { ...venueFacts };
    delete facts.opening_hours; // an occurrence has its own times
    for (const f of occFacts) facts[f.attribute] = { value: f.value, confidence: Number(f.confidence), evidenceClass: f.evidence_class, validUntil: f.valid_until, independentSources: f.independent_sources };
    candidates.push({
      kind: "occurrence",
      id: o.id,
      venueId: o.venue_id,
      name: o.title,
      category: v.category,
      point: { lat: v.lat, lon: v.lon },
      timezone: v.timezone,
      facts,
      occurrence: { id: o.id, title: o.title, start: o.start_at, end: o.end_at, entryCutoff: o.entry_cutoff_at, lateEntry: o.late_entry, status: o.status },
      parentVenueId: v.parent_venue_id,
      boost: Number(v.boost ?? 0),
      excluded: v.excluded,
      hasLandmarkId: v.has_landmark,
    });
  }
  return candidates;
}

export async function loadPolicies(q: Queryable): Promise<Map<string, CategoryPolicy>> {
  const rows = await loadCategoryPolicies(q);
  const out = new Map<string, CategoryPolicy>();
  for (const [k, r] of rows) out.set(k, { category: r.category, minUsefulMinutes: r.min_useful_minutes, admissionBufferMinutes: r.admission_buffer_minutes, kitchenCloseOffsetMinutes: r.kitchen_close_offset_minutes, lastEntryDefaultMinutes: r.last_entry_default_minutes, activityType: r.activity_type });
  return out;
}

export function sunsetAt(p: LatLon, date: Date): Date | null {
  const t = SunCalc.getTimes(date, p.lat, p.lon).sunset;
  return t && !Number.isNaN(t.getTime()) ? t : null;
}

/** Persist a run for replay and the debug view. Context is coarsened: no precise coordinates. */
export async function persistRun(q: Queryable, areaId: string | null, ctx: RequestContext, s: Shortlist, durationMs: number): Promise<string> {
  const coarse = { ...ctx, origin: { lat: +ctx.origin.lat.toFixed(2), lon: +ctx.origin.lon.toFixed(2) }, offset: s.offset };
  const results = s.all.map((e) => ({
    item_kind: e.candidate.kind,
    item_id: e.candidate.id,
    class: e.class,
    excluded_by: e.excludedBy,
    reasons: e.reasons,
    unresolved: e.unresolved,
    scores: e.scores,
    useful_minutes: e.timing?.usefulMinutes ?? null,
    travel_minutes: e.timing?.travel.minutes ?? null,
  }));
  const shortlist = s.items.map((e) => ({ item_kind: e.candidate.kind, item_id: e.candidate.id, class: e.class, reason_codes: e.reasons, cta: e.cta }));
  const r = await q.query<{ id: string }>(
    `insert into recommendation_runs (area_id, context, candidate_count, results, shortlist, engine_version, weights_version, duration_ms)
     values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
    [areaId, JSON.stringify(coarse), s.all.length, JSON.stringify(results), JSON.stringify(shortlist), s.engineVersion, s.weightsVersion, durationMs],
  );
  return r.rows[0]!.id;
}
