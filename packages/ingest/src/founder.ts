import { randomUUID } from "node:crypto";
import { contentHash, type Attribute, type Category, type FactInput, type LatLon } from "@outrn/core";
import { assertSourceAllowed, audit, getArea, withTx, type Db, type Queryable } from "@outrn/db";
import { materializeSubjects, writeFacts } from "@outrn/facts";
import { matchKey, resolveOne, type ResolveOutcome } from "@outrn/identity";
import { finishRun, startRun } from "@outrn/sources";

/**
 * Founder-entered supply: facts checked directly (a call, a visit) and venues OSM does not have.
 * Written as published facts with source 'founder' and the founder's evidence, through the same
 * append-only writer and identity resolver as every other source — so a new founder value
 * supersedes the previous one, and a venue OSM already has is linked, not duplicated.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface VenueMatch {
  id: string;
  name: string;
  category: string;
  publishState: string;
  area: string | null;
  hours: string | null;
  hoursSources: string[];
}

const VENUE_MATCH_SELECT = `
  select v.id, v.canonical_name as name, v.category, v.publish_state, a.slug as area,
         cf.value->>'osm' as hours, cf.source_ids as sources
    from venues v
    left join service_areas a on a.id = v.area_id
    left join current_facts cf on cf.subject_kind = 'venue' and cf.subject_id = v.id and cf.attribute = 'opening_hours'`;

type VenueMatchRow = { id: string; name: string; category: string; publish_state: string; area: string | null; hours: string | null; sources: string[] | null };
const toMatch = (x: VenueMatchRow): VenueMatch => ({ id: x.id, name: x.name, category: x.category, publishState: x.publish_state, area: x.area, hours: x.hours, hoursSources: x.sources ?? [] });

export async function findVenues(q: Queryable, text: string, opts: { areaSlug?: string; limit?: number } = {}): Promise<VenueMatch[]> {
  const key = matchKey(text);
  const r = await q.query<VenueMatchRow>(
    `${VENUE_MATCH_SELECT}
      where v.publish_state <> 'merged'
        and (v.name_key = $1 or v.name_key like '%' || $1 || '%' or v.canonical_name ilike '%' || $2 || '%')
        and ($3::text is null or a.slug = $3)
      order by (v.name_key = $1) desc, (lower(v.canonical_name) = lower($2)) desc, v.canonical_name
      limit $4`,
    [key, text, opts.areaSlug ?? null, opts.limit ?? 20],
  );
  return r.rows.map(toMatch);
}

/** A venue id, or a name that identifies exactly one venue. Ambiguity is an error that lists the candidates. */
export async function resolveVenueRef(q: Queryable, ref: string, opts: { areaSlug?: string } = {}): Promise<VenueMatch> {
  if (UUID.test(ref)) {
    const r = await q.query<VenueMatchRow>(`${VENUE_MATCH_SELECT} where v.id = $1`, [ref]);
    const row = r.rows[0];
    if (!row) throw new Error(`no venue with id ${ref}`);
    if (row.publish_state === "merged") throw new Error(`venue ${ref} is merged into another venue`);
    return toMatch(row);
  }
  const matches = await findVenues(q, ref, opts);
  if (!matches.length) throw new Error(`no venue matches "${ref}"${opts.areaSlug ? ` in ${opts.areaSlug}` : ""}`);
  const exact = matches.filter((m) => m.name.toLowerCase() === ref.toLowerCase() || matchKey(m.name) === matchKey(ref));
  if (matches.length === 1) return matches[0]!;
  if (exact.length === 1) return exact[0]!;
  throw new Error(`"${ref}" matches ${matches.length} venues; use an id:\n${matches.slice(0, 10).map((m) => `  ${m.id}  ${m.name} [${m.category}]${m.area ? ` · ${m.area}` : ""}`).join("\n")}`);
}

export interface FounderFactInput {
  venueId: string;
  attribute: Attribute;
  value: unknown;
  /** What was checked and how: "called 9/26", "visited, sign on door". */
  evidence: string;
  /** When it was checked. This is a verification date, and may be rendered as "confirmed". */
  verifiedAt?: Date;
  confidence?: number;
  actor?: string;
}

function founderFact(venueId: string, attribute: Attribute, value: unknown, evidence: string, verifiedAt: Date, confidence: number, now: Date, runId: string | null = null): FactInput {
  return {
    subjectKind: "venue",
    subjectId: venueId,
    attribute,
    value,
    evidenceClass: "published",
    sourceId: "founder",
    evidence: `founder: ${evidence}`,
    sourceUpdatedAt: verifiedAt,
    fetchedAt: now,
    confidence,
    lineageGroup: "founder",
    ingestionRunId: runId,
  };
}

export async function setFounderFact(db: Db, input: FounderFactInput): Promise<{ inserted: number; superseded: number; winnerSources: string[] }> {
  if (!input.evidence.trim()) throw new Error("--evidence is required: say what you checked and how");
  await assertSourceAllowed(db, "founder", "retain");
  const now = new Date();
  const confidence = input.confidence ?? 0.9;
  return withTx(db, async (tx) => {
    const w = await writeFacts(tx, [founderFact(input.venueId, input.attribute, input.value, input.evidence, input.verifiedAt ?? now, confidence, now)]);
    if (w.rejected.length) throw new Error(`fact rejected: ${w.rejected.map((r) => r.reason).join("; ")}`);
    await audit(tx, { actor: input.actor ?? "founder", action: `fact.set.${input.attribute}`, targetKind: "venue", targetId: input.venueId, after: { value: input.value, evidence: input.evidence, verified_at: (input.verifiedAt ?? now).toISOString() } });
    // Materialization decides the winner and keeps venues.name/category in step with it; a founder
    // correction changes the venue row only if it actually wins over higher-trust sources.
    await materializeSubjects(tx, "venue", [input.venueId], now);
    const cur = await tx.query<{ source_ids: string[] }>(`select source_ids from current_facts where subject_kind = 'venue' and subject_id = $1 and attribute = $2`, [input.venueId, input.attribute]);
    return { inserted: w.inserted, superseded: w.superseded, winnerSources: cur.rows[0]?.source_ids ?? [] };
  });
}

export interface FounderVenueInput {
  name: string;
  category: Category;
  point: LatLon;
  evidence: string;
  areaSlug?: string;
  website?: string;
  phone?: string;
  /** OSM opening_hours syntax, already validated. */
  hours?: string;
  verifiedAt?: Date;
  actor?: string;
}

/** The named area, or the service area whose center is nearest the point. */
async function areaFor(q: Queryable, input: FounderVenueInput) {
  if (input.areaSlug) return getArea(q, input.areaSlug);
  const r = await q.query<{ slug: string }>(`select slug from service_areas order by center <-> ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography limit 1`, [input.point.lon, input.point.lat]);
  if (!r.rows[0]) throw new Error("no service area; pass --area");
  return getArea(q, r.rows[0].slug);
}

export async function addFounderVenue(db: Db, input: FounderVenueInput): Promise<ResolveOutcome & { area: string }> {
  if (!input.evidence.trim()) throw new Error("--evidence is required: say how you know this place exists");
  await assertSourceAllowed(db, "founder", "retain");
  const area = await areaFor(db, input);
  const now = new Date();
  const verifiedAt = input.verifiedAt ?? now;
  const runId = await startRun(db, { sourceId: "founder", areaId: area.id, kind: "founder_venue", params: { name: input.name } });
  try {
    const outcome = await withTx(db, async (tx) => {
      const tags: Record<string, string> = { name: input.name, "outrn:category": input.category };
      if (input.website) tags["website"] = input.website;
      if (input.phone) tags["phone"] = input.phone;
      if (input.hours) tags["opening_hours"] = input.hours;
      const raw = { point: input.point, tags, evidence: input.evidence };
      const se = await tx.query<{ id: string }>(
        `insert into source_entities (source_id, external_id, kind, raw, content_hash, geom, first_seen_run_id, last_seen_run_id, source_updated_at, fetched_at)
         values ('founder', $1, 'venue', $2, $3, ST_SetSRID(ST_MakePoint($4, $5), 4326)::geography, $6, $6, $7, $8) returning id`,
        [`founder/${randomUUID()}`, JSON.stringify(raw), contentHash(raw), input.point.lon, input.point.lat, runId, verifiedAt, now],
      );
      const out = await resolveOne(tx, {
        sourceEntityId: se.rows[0]!.id,
        areaId: area.id,
        timezone: area.timezone,
        record: { name: input.name, category: input.category, point: input.point, website: input.website ?? null, phone: input.phone ?? null, housenumber: null, street: null, brand: null, xids: {} },
      });
      const facts: FactInput[] = [
        founderFact(out.venueId, "name", { value: input.name }, input.evidence, verifiedAt, 0.9, now, runId),
        founderFact(out.venueId, "category", { value: input.category }, input.evidence, verifiedAt, 0.9, now, runId),
        founderFact(out.venueId, "business_status", { status: "operating" }, input.evidence, verifiedAt, 0.85, now, runId),
      ];
      if (input.website) facts.push(founderFact(out.venueId, "website", { value: input.website }, input.evidence, verifiedAt, 0.9, now, runId));
      if (input.phone) facts.push(founderFact(out.venueId, "phone", { value: input.phone }, input.evidence, verifiedAt, 0.9, now, runId));
      if (input.hours) facts.push(founderFact(out.venueId, "opening_hours", { osm: input.hours }, input.evidence, verifiedAt, 0.9, now, runId));
      const w = await writeFacts(tx, facts);
      if (w.rejected.length) throw new Error(`fact rejected: ${w.rejected.map((r) => `${r.attribute}: ${r.reason}`).join("; ")}`);
      await audit(tx, { actor: input.actor ?? "founder", action: "venue.add", targetKind: "venue", targetId: out.venueId, after: { name: input.name, decision: out.decision, created: out.created, matched: out.matchedVenueId, evidence: input.evidence } });
      await materializeSubjects(tx, "venue", [out.venueId], now);
      return out;
    });
    await finishRun(db, runId, { status: "succeeded", counts: { venues_created: outcome.created ? 1 : 0, venues_linked: outcome.created ? 0 : 1 } });
    return { ...outcome, area: area.slug };
  } catch (e) {
    await finishRun(db, runId, { status: "failed", error: (e as Error).message });
    throw e;
  }
}
