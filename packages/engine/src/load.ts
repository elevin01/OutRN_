import SunCalc from "suncalc";
import { DEFAULT_MAX_TRAVEL_MINUTES, fromLocal, localClock, maxReachMetres, parkingBufferAt, PROGRAMME_CATEGORIES, VERIFIED_AT_SQL, type Attribute, type Category, type LatLon, type TravelMode } from "@outrn/core";
import { loadCategoryPolicies, loadParkingRule, type Queryable } from "@outrn/db";
import { loadNearbyParking } from "./parking.js";
import type { Candidate, CategoryPolicy, FactView, NearbyParking, OccurrenceView, RequestContext, Shortlist } from "./types.js";

/**
 * Loads candidates from the materialized tables. The request path reads current_facts, venues,
 * occurrences, overrides and derived parking only — never raw source records and never an external API.
 */


interface VenueRow {
  id: string;
  canonical_name: string;
  category: Category;
  lat: number;
  lon: number;
  timezone: string;
  parent_venue_id: string | null;
  facts: Record<string, { value: unknown; confidence: string; evidence_class: FactView["evidenceClass"]; valid_until: string | null; independent_sources: number; sources: string[] | null; conflict: boolean | null; verified_at: string | null }>;
  boost: string | null;
  excluded: boolean;
  has_landmark: boolean;
  brand: string | null;
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
    out[k as Attribute] = { value: v.value, confidence: Number(v.confidence), evidenceClass: v.evidence_class, validUntil, independentSources: v.independent_sources, sources: v.sources ?? [], conflict: v.conflict ?? false, verifiedAt: v.verified_at ? new Date(v.verified_at) : null };
  }
  return out;
}

export async function loadCandidates(q: Queryable, origin: LatLon, mode: TravelMode, now: Date, windowEnd: Date, maxTravelMinutes?: number, parkingBufferMinutes?: number): Promise<Candidate[]> {
  // Search exactly as far as the travel estimate could ever call reachable (the same bound ingest uses), plus 5%.
  const buffer = parkingBufferMinutes === undefined ? {} : { parkingBufferForHour: () => parkingBufferMinutes };
  const radius = maxReachMetres(mode, maxTravelMinutes ?? DEFAULT_MAX_TRAVEL_MINUTES[mode], buffer) * 1.05;
  const venues = (
    await q.query<VenueRow>(
      // facts_doc is the venue's current facts, kept by materialization (VENUE_FACTS_DOC_SQL): one read per venue.
      `select v.id, v.canonical_name, v.category, ST_Y(v.geom::geometry) as lat, ST_X(v.geom::geometry) as lon, v.timezone, v.parent_venue_id,
              v.facts_doc as facts,
              (select sum(weight) from venue_overrides o where o.venue_id = v.id and o.kind = 'boost' and (o.expires_at is null or o.expires_at > $4)) as boost,
              exists(select 1 from venue_overrides o where o.venue_id = v.id and o.kind = 'exclude' and (o.expires_at is null or o.expires_at > $4)) as excluded,
              exists(select 1 from entity_links l join source_entities se on se.id = l.source_entity_id where l.venue_id = v.id and l.superseded_by is null and se.raw->'tags' ? 'wikidata') as has_landmark,
              (select se.raw->'tags'->>'brand' from entity_links l join source_entities se on se.id = l.source_entity_id where l.venue_id = v.id and l.superseded_by is null and se.raw->'tags' ? 'brand' limit 1) as brand
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
    brand: v.brand,
  }));
  if (!venues.length) return candidates;
  // Where a driver would park, for every venue (occurrences share their venue's).
  const parking = mode === "drive" ? await loadNearbyParking(q, venues.map((v) => v.id)) : new Map<string, NearbyParking[]>();
  for (const c of candidates) c.parkingOptions = parking.get(c.venueId) ?? [];
  const occ = (
    await q.query<OccRow>(
      `select id, venue_id, title, start_at, end_at, entry_cutoff_at, late_entry, status from occurrences
        where venue_id = any($1::uuid[]) and status <> 'ended'
          and coalesce(end_at, start_at + interval '2 hours') > $2 and start_at < $3`,
      [venues.map((v) => v.id), now, windowEnd],
    )
  ).rows;
  // A programme venue with occurrences in the window is represented by them, not by a venue row;
  // the venue row stays only when nothing is loaded, and the engine excludes it as NO_PROGRAMME.
  const withProgramme = new Set(occ.map((o) => o.venue_id));
  const kept = candidates.filter((c) => !(withProgramme.has(c.venueId) && PROGRAMME_CATEGORIES.has(c.category)));
  // One query for every occurrence's facts, not one per occurrence.
  const occFactRows = occ.length
    ? (
        await q.query<{ subject_id: string; attribute: Attribute; value: unknown; confidence: string; evidence_class: FactView["evidenceClass"]; valid_until: Date | null; independent_sources: number; source_ids: string[]; conflict: boolean; verified_at: Date | null }>(
          `select cf.subject_id, cf.attribute, cf.value, cf.confidence, cf.evidence_class, cf.valid_until, cf.independent_sources, cf.source_ids, cf.conflict, ${VERIFIED_AT_SQL} as verified_at
             from current_facts cf where cf.subject_kind = 'occurrence' and cf.subject_id = any($1::uuid[])`,
          [occ.map((o) => o.id)],
        )
      ).rows
    : [];
  const factsByOccurrence = new Map<string, typeof occFactRows>();
  for (const f of occFactRows) factsByOccurrence.set(f.subject_id, [...(factsByOccurrence.get(f.subject_id) ?? []), f]);
  for (const o of occ) {
    const v = byVenue.get(o.venue_id)!;
    const venueFacts = toFacts(v.facts, now);
    const facts = { ...venueFacts };
    delete facts.opening_hours; // an occurrence has its own times
    for (const f of factsByOccurrence.get(o.id) ?? []) {
      if (f.valid_until && f.valid_until <= now) continue; // expiry enforced at request time, as for venue facts
      facts[f.attribute] = { value: f.value, confidence: Number(f.confidence), evidenceClass: f.evidence_class, validUntil: f.valid_until, independentSources: f.independent_sources, sources: f.source_ids, conflict: f.conflict, verifiedAt: f.verified_at };
    }
    kept.push({
      kind: "occurrence",
      id: o.id,
      venueId: o.venue_id,
      name: o.title,
      venueName: v.canonical_name,
      category: v.category,
      point: { lat: v.lat, lon: v.lon },
      timezone: v.timezone,
      facts,
      occurrence: { id: o.id, title: o.title, start: o.start_at, end: o.end_at, entryCutoff: o.entry_cutoff_at, lateEntry: o.late_entry, status: o.status },
      parentVenueId: v.parent_venue_id,
      boost: Number(v.boost ?? 0),
      excluded: v.excluded,
      hasLandmarkId: v.has_landmark,
      brand: v.brand,
      parkingOptions: parking.get(o.venue_id) ?? [],
    });
  }
  return kept;
}

export async function loadPolicies(q: Queryable): Promise<Map<string, CategoryPolicy>> {
  const rows = await loadCategoryPolicies(q);
  const out = new Map<string, CategoryPolicy>();
  for (const [k, r] of rows) out.set(k, { category: r.category, minUsefulMinutes: r.min_useful_minutes, admissionBufferMinutes: r.admission_buffer_minutes, kitchenCloseOffsetMinutes: r.kitchen_close_offset_minutes, lastEntryDefaultMinutes: r.last_entry_default_minutes, activityType: r.activity_type });
  return out;
}

/** Parking buffer for a drive departing at `now`, from the area's parking rule (undefined = engine default). */
export async function loadParkingBuffer(q: Queryable, areaSlug: string, now: Date, timezone: string): Promise<number | undefined> {
  const rule = await loadParkingRule(q, areaSlug);
  return rule ? parkingBufferAt(rule, localClock(now, timezone).hour) : undefined;
}

export function sunsetAt(p: LatLon, date: Date): Date | null {
  const t = SunCalc.getTimes(date, p.lat, p.lon).sunset;
  return t && !Number.isNaN(t.getTime()) ? t : null;
}

/** Sunset on the local calendar day of `at` (at 10pm in New York the UTC day is already tomorrow). */
export function sunsetOn(p: LatLon, at: Date, timezone: string): Date | null {
  return sunsetAt(p, fromLocal(localClock(at, timezone).date, 12 * 60, timezone));
}

/**
 * Persist a run for replay and the debug view. Context is coarsened: no precise coordinates, and a
 * device's seen/dismissed history is reduced to counts, so runs never become an activity log.
 */
export async function persistRun(q: Queryable, areaId: string | null, ctx: RequestContext, s: Shortlist, durationMs: number): Promise<string> {
  const { seenIds, dismissedIds, ...rest } = ctx;
  const coarse = { ...rest, origin: { lat: +ctx.origin.lat.toFixed(2), lon: +ctx.origin.lon.toFixed(2) }, offset: s.offset, seenCount: seenIds?.length ?? 0, dismissedCount: dismissedIds?.length ?? 0 };
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

/** How long recommendation runs are kept (they hold coarsened request context). */
export const RUN_RETENTION_DAYS = 30;

/** Delete runs older than the retention period, oldest first, at most `limit` per call. Returns how many. */
export async function pruneRuns(q: Queryable, now: Date, limit = 500): Promise<number> {
  const cutoff = new Date(now.getTime() - RUN_RETENTION_DAYS * 86_400_000);
  const r = await q.query(
    `delete from recommendation_runs where id in (select id from recommendation_runs where created_at < $1 order by created_at limit $2)`,
    [cutoff, limit],
  );
  return r.rowCount ?? 0;
}
