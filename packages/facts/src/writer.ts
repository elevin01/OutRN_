import { contentHash, DEFAULT_VALIDITY_MINUTES, DYNAMIC_ATTRIBUTES, validateFactValue, type FactInput } from "@outrn/core";
import type { Queryable } from "@outrn/db";

/**
 * Append-only fact writer. Idempotent on (subject, attribute, source, content hash).
 * When the same source re-asserts a DIFFERENT value for the same attribute, the older
 * row is superseded rather than overwritten, so history is preserved.
 */

export interface WriteResult {
  inserted: number;
  unchanged: number;
  superseded: number;
  rejected: { attribute: string; reason: string }[];
}

function validate(f: FactInput): string | null {
  if (f.confidence < 0 || f.confidence > 1 || Number.isNaN(f.confidence)) return "confidence out of range";
  if (f.evidenceClass === "published" && !f.evidence) return "published facts need evidence";
  if (f.evidenceClass === "observation" && !f.observedAt) return "observations need observed_at";
  if (DYNAMIC_ATTRIBUTES.has(f.attribute) && f.evidenceClass !== "observation") return `${f.attribute} may only be an observation`;
  if (f.value === undefined || f.value === null) return "value is required";
  // Shape, not just presence: a malformed value must never reach the engine.
  return validateFactValue(f.attribute, f.value);
}

export async function writeFacts(q: Queryable, facts: FactInput[]): Promise<WriteResult> {
  const out: WriteResult = { inserted: 0, unchanged: 0, superseded: 0, rejected: [] };
  for (const f of facts) {
    const bad = validate(f);
    if (bad) {
      out.rejected.push({ attribute: f.attribute, reason: bad });
      continue;
    }
    const hash = contentHash(f.value);
    let validUntil = f.validUntil ?? null;
    if (!validUntil && f.evidenceClass === "observation") {
      const mins = DEFAULT_VALIDITY_MINUTES[f.attribute];
      if (mins) validUntil = new Date((f.observedAt ?? f.fetchedAt).getTime() + mins * 60_000);
    }
    const ins = await q.query<{ id: string }>(
      `insert into facts (subject_kind, subject_id, attribute, value, evidence_class, source_id, evidence, source_updated_at, fetched_at, observed_at, valid_from, valid_until, confidence, lineage_group, ingestion_run_id, content_hash)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       on conflict (subject_kind, subject_id, attribute, source_id, content_hash) do update
         set fetched_at = excluded.fetched_at,
             -- The same value can come back on new evidence, and the latest assertion's evidence is
             -- the claim's: an OSM estimate a mapper has since surveyed becomes published with the
             -- survey date as observed_at, and a survey tag removed upstream takes its date along.
             -- (An observation always carries its own observed_at.)
             evidence_class = excluded.evidence_class,
             evidence = excluded.evidence,
             observed_at = excluded.observed_at,
             source_updated_at = coalesce(excluded.source_updated_at, facts.source_updated_at),
             confidence = excluded.confidence,
             valid_until = excluded.valid_until,
             ingestion_run_id = coalesce(excluded.ingestion_run_id, facts.ingestion_run_id),
             superseded_at = null
       returning id, (xmax = 0) as inserted`,
      [f.subjectKind, f.subjectId, f.attribute, JSON.stringify(f.value), f.evidenceClass, f.sourceId, f.evidence ?? null, f.sourceUpdatedAt ?? null, f.fetchedAt, f.observedAt ?? null, f.validFrom ?? null, validUntil, f.confidence, f.lineageGroup ?? null, f.ingestionRunId ?? null, hash],
    );
    const row = ins.rows[0] as { id: string; inserted: boolean };
    if (row.inserted) out.inserted++;
    else out.unchanged++;
    // Observations are point-in-time and never supersede each other; published/estimate facts from the same source do.
    if (f.evidenceClass !== "observation") {
      const sup = await q.query(
        `update facts set superseded_at = now()
          where subject_kind = $1 and subject_id = $2 and attribute = $3 and source_id = $4
            and evidence_class <> 'observation' and content_hash <> $5 and superseded_at is null`,
        [f.subjectKind, f.subjectId, f.attribute, f.sourceId, hash],
      );
      out.superseded += sup.rowCount ?? 0;
    }
  }
  return out;
}

/** Supersede every active non-observation fact a source holds for a subject (used when a source tombstones a record). */
/**
 * Retract a source's active claims on a subject for attributes it no longer asserts. For a subject
 * whose whole input from the source is one record: a tag removed upstream (a bar that now lists a
 * cuisine, kitchen hours deleted) must take the fact derived from it along. Observations stand.
 */
export async function retractSourceFactsExcept(q: Queryable, subjectKind: string, subjectId: string, sourceId: string, keep: readonly string[]): Promise<number> {
  const r = await q.query(
    `update facts set superseded_at = now()
      where subject_kind = $1 and subject_id = $2 and source_id = $3 and superseded_at is null
        and evidence_class <> 'observation' and not (attribute = any($4::text[]))`,
    [subjectKind, subjectId, sourceId, [...keep]],
  );
  return r.rowCount ?? 0;
}

export async function retractSourceFacts(q: Queryable, subjectKind: string, subjectId: string, sourceId: string): Promise<number> {
  const r = await q.query(
    `update facts set superseded_at = now() where subject_kind = $1 and subject_id = $2 and source_id = $3 and superseded_at is null`,
    [subjectKind, subjectId, sourceId],
  );
  return r.rowCount ?? 0;
}
