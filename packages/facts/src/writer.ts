import { contentHash, DEFAULT_VALIDITY_MINUTES, DYNAMIC_ATTRIBUTES, type FactInput } from "@outrn/core";
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
  return null;
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
export async function retractSourceFacts(q: Queryable, subjectKind: string, subjectId: string, sourceId: string): Promise<number> {
  const r = await q.query(
    `update facts set superseded_at = now() where subject_kind = $1 and subject_id = $2 and source_id = $3 and superseded_at is null`,
    [subjectKind, subjectId, sourceId],
  );
  return r.rowCount ?? 0;
}
