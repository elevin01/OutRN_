import { contentHash, isCategory, matchKey, MATERIAL_ATTRIBUTES, type Attribute, type EvidenceClass } from "@outrn/core";
import type { Queryable } from "@outrn/db";

/**
 * Rebuilds current_facts for a set of subjects from the append-only facts table.
 *
 * Policy (versioned here; change it and re-run, never patch rows by hand):
 *  1. Only active facts count: not superseded, not past valid_until.
 *  2. Class beats confidence: a published fact always outranks an estimate for the same attribute.
 *  3. Within a class, order by source trust, then confidence, then recency.
 *  4. Agreement counts once per lineage group. Independent agreeing sources raise confidence
 *     as 1 − Π(1 − cᵢ), capped. Disagreement inside the winning class marks conflict and dampens,
 *     unless the disagreeing claim is both less trusted and older than the winner: a founder's
 *     call on 26 Sep corrects a 2020 OSM tag, it does not contest it. An OSM edit made after the
 *     call, or a claim from an equally trusted source, is still a conflict for review.
 *  5. Closures are conservative: a credible closed_permanently beats an "operating" claim, unless
 *     a more trusted source (a founder's check) has seen the place operating since. Only a
 *     permanent closure excludes the venue here; a temporary one (not open yet, closed for works)
 *     lapses on its own date, so the engine applies it per request instead of a state that only
 *     the next ingest could undo.
 *  6. The venue row's canonical name and category follow the winning name/category facts, so
 *     filtering and recommendations never disagree with current_facts (no source writes them directly).
 */

export const MATERIALIZE_POLICY_VERSION = "2026-09-29.1";

const CLASS_RANK: Record<EvidenceClass, number> = { published: 3, observation: 2, estimate: 1 };

const SOURCE_TRUST: Record<string, number> = {
  firstparty: 0.9,
  founder: 0.85, // checked by the founder (a call, a visit); below the venue's own site
  user_observation: 0.7,
  osm: 0.6,
  overture: 0.6, // conflated from several map providers: as trusted as OSM, never above a check
  foursquare_os: 0.6,
  google_places: 0.65,
  category_policy: 0.3,
};

interface FactRow {
  id: string;
  attribute: Attribute;
  value: unknown;
  evidence_class: EvidenceClass;
  source_id: string;
  confidence: string; // numeric comes back as string
  lineage_group: string | null;
  source_updated_at: Date | null;
  fetched_at: Date;
  observed_at: Date | null;
  valid_until: Date | null;
}

export interface MaterializeResult {
  subjects: number;
  attributes: number;
  conflicts: number;
  tasksCreated: number;
}

/** An observation dates from when it was seen; a published claim from its source's last change (an OSM edit postdates its survey). */
function recency(f: FactRow): number {
  const d = f.evidence_class === "observation" ? f.observed_at : (f.source_updated_at ?? f.observed_at);
  return (d ?? f.fetched_at).getTime();
}

function isClosure(f: FactRow): boolean {
  return f.attribute === "business_status" && (f.value as { status?: string })?.status?.startsWith("closed") === true && Number(f.confidence) >= 0.6;
}

export async function materializeSubjects(q: Queryable, subjectKind: "venue" | "occurrence", subjectIds: string[], now = new Date()): Promise<MaterializeResult> {
  const result: MaterializeResult = { subjects: 0, attributes: 0, conflicts: 0, tasksCreated: 0 };
  for (const subjectId of subjectIds) {
    const rows = (
      await q.query<FactRow>(
        `select id, attribute, value, evidence_class, source_id, confidence, lineage_group, source_updated_at, fetched_at, observed_at, valid_until
           from facts where subject_kind = $1 and subject_id = $2 and superseded_at is null and (valid_until is null or valid_until > $3)`,
        [subjectKind, subjectId, now],
      )
    ).rows;
    result.subjects++;
    await q.query(`delete from current_facts where subject_kind = $1 and subject_id = $2`, [subjectKind, subjectId]);
    const byAttr = new Map<Attribute, FactRow[]>();
    for (const r of rows) {
      const list = byAttr.get(r.attribute) ?? [];
      list.push(r);
      byAttr.set(r.attribute, list);
    }
    for (const [attribute, list] of byAttr) {
      // A closure goes first, unless a more trusted source (a founder's check) has seen the place
      // operating since: map data re-asserts its closure on every run and can't be corrected from here.
      const answered = (f: FactRow) =>
        list.some((o) => (o.value as { status?: string })?.status === "operating" && (SOURCE_TRUST[o.source_id] ?? 0.5) > (SOURCE_TRUST[f.source_id] ?? 0.5) && recency(o) > recency(f));
      list.sort((a, b) => {
        const ca = isClosure(a) && !answered(a) ? 1 : 0;
        const cb = isClosure(b) && !answered(b) ? 1 : 0;
        if (ca !== cb) return cb - ca; // closures first
        const cr = CLASS_RANK[b.evidence_class] - CLASS_RANK[a.evidence_class];
        if (cr !== 0) return cr;
        const tr = (SOURCE_TRUST[b.source_id] ?? 0.5) - (SOURCE_TRUST[a.source_id] ?? 0.5);
        if (tr !== 0) return tr;
        const cf = Number(b.confidence) - Number(a.confidence);
        if (cf !== 0) return cf;
        return recency(b) - recency(a);
      });
      const winner = list[0]!;
      const winnerHash = contentHash(winner.value);
      const sameClass = list.filter((f) => f.evidence_class === winner.evidence_class);
      const agreeing = sameClass.filter((f) => contentHash(f.value) === winnerHash);
      const winnerTrust = SOURCE_TRUST[winner.source_id] ?? 0.5;
      const disagreeing = sameClass.filter((f) => contentHash(f.value) !== winnerHash && ((SOURCE_TRUST[f.source_id] ?? 0.5) >= winnerTrust || recency(f) > recency(winner))).length;
      // One vote per lineage group (or per source when no group is declared).
      const groups = new Map<string, number>();
      for (const f of agreeing) {
        const g = f.lineage_group ?? f.source_id;
        groups.set(g, Math.max(groups.get(g) ?? 0, Number(f.confidence)));
      }
      let conf = 1;
      for (const c of groups.values()) conf *= 1 - Math.min(0.95, c);
      conf = 1 - conf;
      const conflict = disagreeing > 0;
      if (conflict) conf *= 0.7;
      conf = Math.max(0.05, Math.min(0.97, conf));
      const validUntil = agreeing.reduce<Date | null>((m, f) => (f.valid_until && (!m || f.valid_until < m) ? f.valid_until : m), null);
      await q.query(
        `insert into current_facts (subject_kind, subject_id, attribute, value, evidence_class, confidence, source_ids, input_fact_ids, independent_sources, conflict, valid_until, computed_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [subjectKind, subjectId, attribute, JSON.stringify(winner.value), winner.evidence_class, conf.toFixed(3), [...new Set(agreeing.map((f) => f.source_id))], agreeing.map((f) => f.id), groups.size, conflict, validUntil, now],
      );
      result.attributes++;
      if (conflict) result.conflicts++;
    }
    if (subjectKind === "venue") {
      result.tasksCreated += await updateVenuePublishState(q, subjectId, byAttr, now);
    }
  }
  return result;
}

/** Map data whose closures alone should be confirmed by someone, by display name. */
const MAP_SOURCES = new Map([
  ["osm", "OpenStreetMap"],
  ["overture", "Overture Maps"],
]);

const CONSEQUENCE: Partial<Record<Attribute, number>> = { opening_hours: 1.0, business_status: 1.0, admission: 0.8, price: 0.4 };

async function updateVenuePublishState(q: Queryable, venueId: string, byAttr: Map<Attribute, FactRow[]>, now: Date): Promise<number> {
  const cur = (await q.query<{ attribute: Attribute; value: unknown; confidence: string; source_ids: string[] }>(`select attribute, value, confidence, source_ids from current_facts where subject_kind = 'venue' and subject_id = $1`, [venueId])).rows;
  const get = (a: Attribute) => cur.find((c) => c.attribute === a);
  const status = (get("business_status")?.value as { status?: string } | undefined)?.status;
  const excluded = (await q.query(`select 1 from venue_overrides where venue_id = $1 and kind = 'exclude' and (expires_at is null or expires_at > $2) limit 1`, [venueId, now])).rowCount ?? 0;
  const v = (await q.query<{ publish_state: string; canonical_name: string; category: string }>(`select publish_state, canonical_name, category from venues where id = $1`, [venueId])).rows[0];
  if (!v) return 0;
  if (v.publish_state !== "merged") {
    const winName = (get("name")?.value as { value?: unknown } | undefined)?.value;
    const winCategory = (get("category")?.value as { value?: unknown } | undefined)?.value;
    const name = typeof winName === "string" && winName.trim() ? winName.trim() : v.canonical_name;
    const category = typeof winCategory === "string" && isCategory(winCategory) ? winCategory : v.category;
    if (name !== v.canonical_name || category !== v.category) {
      await q.query(`update venues set canonical_name = $2, name_key = $3, category = $4, updated_at = now() where id = $1`, [venueId, name, matchKey(name), category]);
      v.canonical_name = name;
      v.category = category;
    }
  }
  let next = v.publish_state;
  if (v.publish_state !== "suspended" && v.publish_state !== "merged") {
    if (excluded) next = "excluded";
    else if (status === "closed_permanently") next = "excluded";
    // No source speaks for it any more (OSM deleted it, Overture no longer lists it): not shown.
    else if (!cur.length) next = "candidate";
    else if (v.canonical_name && v.category) next = "eligible";
    else next = "candidate";
  }
  if (next !== v.publish_state) await q.query(`update venues set publish_state = $2 where id = $1`, [venueId, next]);
  let created = 0;
  // Anyone can edit OSM, and Overture's closures are inferred: when map data alone delists a published
  // venue, someone should confirm it, so a vandal's edit (or a wrong signal) does not quietly hide a place.
  const closure = get("business_status");
  if (v.publish_state === "eligible" && next === "excluded" && !excluded && closure?.source_ids.length && closure.source_ids.every((s) => MAP_SOURCES.has(s))) {
    const r = await q.query(
      `insert into verification_tasks (subject_kind, subject_id, attribute, question, options, priority, dedupe_key, expires_at)
       values ('venue', $1, 'business_status', $2, $3, 1.0, $4, $5)
       on conflict (dedupe_key) do update set priority = excluded.priority, expires_at = excluded.expires_at
       returning (xmax = 0) as inserted`,
      // OSM's closures keep the key they always had; one Overture takes part in gets its own, so an
      // OSM closure check already answered does not swallow a new Overture one.
      [venueId, `${closure.source_ids.map((s) => MAP_SOURCES.get(s)).join(" and ")} now ${closure.source_ids.length > 1 ? "say" : "says"} this place has closed. Has it?`, JSON.stringify(["operating", "closed", "not_sure"]), `venue:${venueId}:${closure.source_ids.includes("overture") ? "map_closure" : "osm_closure"}`, new Date(now.getTime() + 14 * 86_400_000)],
    );
    if ((r.rows[0] as { inserted: boolean }).inserted) created++;
  }
  if (next !== "eligible") return created;
  // Verification tasks for material facts that are missing or weak.
  for (const attr of MATERIAL_ATTRIBUTES) {
    const c = get(attr);
    const conf = c ? Number(c.confidence) : 0;
    if (conf >= 0.5) continue;
    const consequence = CONSEQUENCE[attr] ?? 0.5;
    const priority = 1.0 * consequence * (1 - conf);
    const question = attr === "opening_hours" ? "Is this place open right now?" : attr === "admission" ? "Could you walk in, or did you need a ticket or reservation?" : "Is this place still operating?";
    const options = attr === "opening_hours" ? ["open", "closed", "not_sure"] : attr === "admission" ? ["walk_in", "reservation", "ticket", "not_sure"] : ["operating", "closed", "not_sure"];
    const r = await q.query(
      `insert into verification_tasks (subject_kind, subject_id, attribute, question, options, priority, dedupe_key, expires_at)
       values ('venue', $1, $2, $3, $4, $5, $6, $7)
       on conflict (dedupe_key) do update set priority = excluded.priority, expires_at = excluded.expires_at
       returning (xmax = 0) as inserted`,
      [venueId, attr, question, JSON.stringify(options), priority.toFixed(3), `venue:${venueId}:${attr}`, new Date(now.getTime() + 14 * 86_400_000)],
    );
    if ((r.rows[0] as { inserted: boolean }).inserted) created++;
  }
  void byAttr;
  return created;
}

/** Convenience: materialize every venue (optionally within one area). */
export async function materializeAll(q: Queryable, areaId?: string): Promise<MaterializeResult> {
  const ids = (
    await q.query<{ id: string }>(
      areaId ? `select id from venues where publish_state <> 'merged' and area_id = $1` : `select id from venues where publish_state <> 'merged'`,
      areaId ? [areaId] : [],
    )
  ).rows.map((r) => r.id);
  return materializeSubjects(q, "venue", ids);
}
