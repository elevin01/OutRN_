import type { Category, LatLon } from "@outrn/core";
import { audit, type Queryable } from "@outrn/db";
import { AUTO_MERGE_THRESHOLD, REVIEW_THRESHOLD, matchKey, scorePair, type IdentityRecord } from "./score.js";

/**
 * Resolves source records into OutRN venues. One venue per real place; a chain's branches
 * are separate venues; a museum café is a child of the museum. Ambiguity goes to review as a
 * new venue with a 'review' link to the candidate, so nothing is silently merged.
 *
 * Every decision is an entity_links row with its evidence. Merges are reversible: undoing a
 * link re-points the source record and marks the old link superseded.
 */

export interface ResolveInput {
  sourceEntityId: string;
  record: IdentityRecord;
  areaId: string | null;
  timezone: string;
}

export interface ResolveOutcome {
  sourceEntityId: string;
  venueId: string;
  decision: "auto" | "review";
  created: boolean;
  parentVenueId: string | null;
  score: number;
  matchedVenueId: string | null;
}

interface VenueCandidate {
  id: string;
  canonical_name: string;
  category: Category;
  lat: number;
  lon: number;
  website: string | null;
  phone: string | null;
  housenumber: string | null;
  street: string | null;
  brand: string | null;
}

const BLOCK_RADIUS_M = 250;

async function candidatesNear(q: Queryable, p: LatLon): Promise<VenueCandidate[]> {
  // Contact/address facts come from the source records already linked to each venue.
  const r = await q.query<VenueCandidate>(
    `with near as (
       select v.id, v.canonical_name, v.category, ST_Y(v.geom::geometry) as lat, ST_X(v.geom::geometry) as lon
         from venues v
        where v.publish_state <> 'merged'
          and ST_DWithin(v.geom, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, $3)
     )
     select n.*,
            (select coalesce(se.raw->'tags'->>'website', se.raw->'websites'->>0) from entity_links l join source_entities se on se.id = l.source_entity_id where l.venue_id = n.id and l.superseded_by is null and coalesce(se.raw->'tags'->>'website', se.raw->'websites'->>0) is not null limit 1) as website,
            (select coalesce(se.raw->'tags'->>'phone', se.raw->'phones'->>0) from entity_links l join source_entities se on se.id = l.source_entity_id where l.venue_id = n.id and l.superseded_by is null and coalesce(se.raw->'tags'->>'phone', se.raw->'phones'->>0) is not null limit 1) as phone,
            (select se.raw->'tags'->>'addr:housenumber' from entity_links l join source_entities se on se.id = l.source_entity_id where l.venue_id = n.id and l.superseded_by is null and se.raw->'tags'->>'addr:housenumber' is not null limit 1) as housenumber,
            (select se.raw->'tags'->>'addr:street' from entity_links l join source_entities se on se.id = l.source_entity_id where l.venue_id = n.id and l.superseded_by is null and se.raw->'tags'->>'addr:street' is not null limit 1) as street,
            (select se.raw->'tags'->>'brand' from entity_links l join source_entities se on se.id = l.source_entity_id where l.venue_id = n.id and l.superseded_by is null and se.raw->'tags'->>'brand' is not null limit 1) as brand
       from near n`,
    [p.lon, p.lat, BLOCK_RADIUS_M],
  );
  return r.rows;
}

async function createVenue(q: Queryable, input: ResolveInput, parentVenueId: string | null): Promise<string> {
  const r = await q.query<{ id: string }>(
    `insert into venues (canonical_name, name_key, geom, category, area_id, timezone, parent_venue_id)
     values ($1, $2, ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography, $5, $6, $7, $8) returning id`,
    [input.record.name, matchKey(input.record.name), input.record.point.lon, input.record.point.lat, input.record.category, input.areaId, input.timezone, parentVenueId],
  );
  return r.rows[0]!.id;
}

async function link(q: Queryable, sourceEntityId: string, venueId: string, score: number, decision: "auto" | "review", evidence: unknown): Promise<void> {
  await q.query(`update entity_links set superseded_by = id where source_entity_id = $1 and superseded_by is null`, [sourceEntityId]);
  await q.query(
    `insert into entity_links (source_entity_id, venue_id, score, decision, evidence) values ($1,$2,$3,$4,$5)`,
    [sourceEntityId, venueId, score.toFixed(3), decision, JSON.stringify(evidence)],
  );
}

type Scored = { c: VenueCandidate; s: ReturnType<typeof scorePair> };

/** The venue nearby most likely to be this record, and the one it most likely sits inside (a museum's café). */
async function bestNear(q: Queryable, record: IdentityRecord): Promise<{ best: Scored | null; child: Scored | null }> {
  let best: Scored | null = null;
  let child: Scored | null = null;
  for (const c of await candidatesNear(q, record.point)) {
    const s = scorePair(record, { name: c.canonical_name, category: c.category, point: { lat: c.lat, lon: c.lon }, website: c.website, phone: c.phone, housenumber: c.housenumber, street: c.street, brand: c.brand });
    if (s.relation === "child_of") {
      if (!child || s.score > child.s.score) child = { c, s };
      continue;
    }
    if (!best || s.score > best.s.score) best = { c, s };
  }
  return { best, child };
}

export async function resolveOne(q: Queryable, input: ResolveInput): Promise<ResolveOutcome> {
  const existing = await q.query<{ venue_id: string }>(`select venue_id from entity_links where source_entity_id = $1 and superseded_by is null and decision <> 'rejected'`, [input.sourceEntityId]);
  if (existing.rows[0]) {
    return { sourceEntityId: input.sourceEntityId, venueId: existing.rows[0].venue_id, decision: "auto", created: false, parentVenueId: null, score: 1, matchedVenueId: existing.rows[0].venue_id };
  }
  const { best, child } = await bestNear(q, input.record);
  if (best && best.s.score >= AUTO_MERGE_THRESHOLD) {
    await link(q, input.sourceEntityId, best.c.id, best.s.score, "auto", { matched: best.c.id, ...best.s.evidence });
    return { sourceEntityId: input.sourceEntityId, venueId: best.c.id, decision: "auto", created: false, parentVenueId: null, score: best.s.score, matchedVenueId: best.c.id };
  }
  const parentId = child ? child.c.id : null;
  const venueId = await createVenue(q, input, parentId);
  if (best && best.s.score >= REVIEW_THRESHOLD) {
    // New venue, but flag the near-miss for a human: a 'review' link to the candidate carries the evidence.
    await link(q, input.sourceEntityId, venueId, best.s.score, "review", { candidate: best.c.id, ...best.s.evidence });
    await audit(q, { actor: "system", action: "identity.review", targetKind: "venue", targetId: venueId, after: { candidate: best.c.id, score: best.s.score } });
    return { sourceEntityId: input.sourceEntityId, venueId, decision: "review", created: true, parentVenueId: parentId, score: best.s.score, matchedVenueId: best.c.id };
  }
  await link(q, input.sourceEntityId, venueId, best?.s.score ?? 0, "auto", { new_venue: true, ...(child ? { child_of: child.c.id, ...child.s.evidence } : {}), ...(best ? { nearest: best.c.id, nearest_score: best.s.score } : {}) });
  return { sourceEntityId: input.sourceEntityId, venueId, decision: "auto", created: true, parentVenueId: parentId, score: best?.s.score ?? 0, matchedVenueId: null };
}

/**
 * A new venue for a record only when nothing nearby could be it: no candidate scores even a review
 * (see REVIEW_THRESHOLD). Anything closer is left alone rather than risk a second card for one
 * place. For sources that only add to what the map already has (Overture's places OSM lacks).
 */
export async function createIfNew(q: Queryable, input: ResolveInput): Promise<{ venueId: string; parentVenueId: string | null; nearest: { venueId: string; score: number } | null } | { skipped: { venueId: string; score: number } }> {
  const { best, child } = await bestNear(q, input.record);
  if (best && best.s.score >= REVIEW_THRESHOLD) return { skipped: { venueId: best.c.id, score: best.s.score } };
  const parentId = child ? child.c.id : null;
  const venueId = await createVenue(q, input, parentId);
  await link(q, input.sourceEntityId, venueId, best?.s.score ?? 0, "auto", { new_venue: true, ...(child ? { child_of: child.c.id, ...child.s.evidence } : {}), ...(best ? { nearest: best.c.id, nearest_score: best.s.score } : {}) });
  return { venueId, parentVenueId: parentId, nearest: best ? { venueId: best.c.id, score: best.s.score } : null };
}

/** Human decision: merge venue `from` into `to`. Re-points links and facts; reversible via audit + superseded links. */
export async function mergeVenues(q: Queryable, from: string, to: string, actor: string, reason: string): Promise<void> {
  const links = await q.query<{ id: string; source_entity_id: string; score: string }>(`select id, source_entity_id, score from entity_links where venue_id = $1 and superseded_by is null`, [from]);
  for (const l of links.rows) {
    const ins = await q.query<{ id: string }>(`insert into entity_links (source_entity_id, venue_id, score, decision, evidence, decided_by) values ($1,$2,$3,'manual',$4,$5) returning id`, [l.source_entity_id, to, l.score, JSON.stringify({ merged_from: from, reason }), actor]);
    await q.query(`update entity_links set superseded_by = $2 where id = $1`, [l.id, ins.rows[0]!.id]);
  }
  await q.query(`update facts set subject_id = $2 where subject_kind = 'venue' and subject_id = $1`, [from, to]);
  await q.query(`update venues set publish_state = 'merged', merged_into = $2 where id = $1`, [from, to]);
  await q.query(`delete from current_facts where subject_kind = 'venue' and subject_id = $1`, [from]);
  await audit(q, { actor, action: "identity.merge", targetKind: "venue", targetId: from, after: { into: to, reason } });
}

/** Human decision: the review candidate was not the same place. Clears the flag, keeps the venue. */
export async function confirmSplit(q: Queryable, sourceEntityId: string, actor: string, reason: string): Promise<void> {
  await q.query(`update entity_links set decision = 'split', evidence = evidence || $2::jsonb, decided_by = $3, decided_at = now() where source_entity_id = $1 and superseded_by is null and decision = 'review'`, [sourceEntityId, JSON.stringify({ reason }), actor]);
  await audit(q, { actor, action: "identity.split", targetKind: "source_entity", targetId: sourceEntityId, after: { reason } });
}
