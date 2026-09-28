import { contentHash, DEFAULT_VALIDITY_MINUTES, DYNAMIC_ATTRIBUTES, validateFactValue, type FactInput } from "@outrn/core";
import type { Queryable } from "@outrn/db";

/**
 * Append-only fact writer. A claim is its value AND the evidence behind it (class, evidence text,
 * observed_at). Re-asserting the source's identical ACTIVE claim is idempotent (it only refreshes
 * fetch time, confidence and validity). When the same source asserts a different value, or the same
 * value on different evidence (an estimate a mapper has since surveyed, a survey date withdrawn), the
 * older row is superseded rather than edited; and returning to an earlier claim adds a new row
 * rather than reviving the superseded one. The ledger keeps when and how a claim changed.
 */

/** Identity of a claim: what it says and what it rests on. The source's edit time is not part of it. */
export function claimHash(f: Pick<FactInput, "value" | "evidenceClass" | "evidence" | "observedAt">): string {
  return contentHash({ value: f.value, evidenceClass: f.evidenceClass, evidence: f.evidence ?? null, observedAt: f.observedAt?.toISOString() ?? null });
}

/**
 * Claims of one source record, plus the source's pre-record rows (source_record null) when a record
 * is named: those predate per-record claims and are retired by the first record-level write.
 */
const SAME_RECORD = (param: string) => `source_record is not distinct from ${param}`;
const RECORD_SCOPE = (param: string) => `(${SAME_RECORD(param)} or (${param}::text is not null and source_record is null))`;

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
    const hash = claimHash(f);
    let validUntil = f.validUntil ?? null;
    if (!validUntil && f.evidenceClass === "observation") {
      const mins = DEFAULT_VALIDITY_MINUTES[f.attribute];
      if (mins) validUntil = new Date((f.observedAt ?? f.fetchedAt).getTime() + mins * 60_000);
    }
    const ins = await q.query<{ id: string }>(
      `insert into facts (subject_kind, subject_id, attribute, value, evidence_class, source_id, evidence, source_updated_at, fetched_at, observed_at, valid_from, valid_until, confidence, lineage_group, ingestion_run_id, content_hash, source_record)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       on conflict (subject_kind, subject_id, attribute, source_id, (coalesce(source_record, '')), content_hash) where superseded_at is null do update
         set fetched_at = excluded.fetched_at,
             source_updated_at = coalesce(excluded.source_updated_at, facts.source_updated_at),
             confidence = excluded.confidence,
             valid_until = excluded.valid_until,
             ingestion_run_id = coalesce(excluded.ingestion_run_id, facts.ingestion_run_id)
       returning id, (xmax = 0) as inserted`,
      [f.subjectKind, f.subjectId, f.attribute, JSON.stringify(f.value), f.evidenceClass, f.sourceId, f.evidence ?? null, f.sourceUpdatedAt ?? null, f.fetchedAt, f.observedAt ?? null, f.validFrom ?? null, validUntil, f.confidence, f.lineageGroup ?? null, f.ingestionRunId ?? null, hash, f.sourceRecord ?? null],
    );
    const row = ins.rows[0] as { id: string; inserted: boolean };
    if (row.inserted) out.inserted++;
    else out.unchanged++;
    // Observations are point-in-time and never supersede each other; published/estimate claims from the
    // same source record do. A record's first claim also retires the source's pre-record rows.
    if (f.evidenceClass !== "observation") {
      const sup = await q.query(
        `update facts set superseded_at = now()
          where subject_kind = $1 and subject_id = $2 and attribute = $3 and source_id = $4
            and evidence_class <> 'observation' and superseded_at is null
            and ((${SAME_RECORD("$6")} and content_hash <> $5) or ($6::text is not null and source_record is null))`,
        [f.subjectKind, f.subjectId, f.attribute, f.sourceId, hash, f.sourceRecord ?? null],
      );
      out.superseded += sup.rowCount ?? 0;
    }
  }
  return out;
}

/**
 * Retract a source record's active claims on a subject for attributes it no longer asserts: a tag
 * removed upstream (a bar that now lists a cuisine, kitchen hours deleted) takes the fact derived
 * from it along. Other records of the same venue keep theirs. Observations stand.
 */
export async function retractSourceFactsExcept(q: Queryable, subjectKind: string, subjectId: string, sourceId: string, keep: readonly string[], sourceRecord: string | null = null): Promise<number> {
  const r = await q.query(
    `update facts set superseded_at = now()
      where subject_kind = $1 and subject_id = $2 and source_id = $3 and superseded_at is null
        and evidence_class <> 'observation' and not (attribute = any($4::text[])) and ${RECORD_SCOPE("$5")}`,
    [subjectKind, subjectId, sourceId, [...keep], sourceRecord],
  );
  return r.rowCount ?? 0;
}

/** Supersede every active fact a source (or one of its records) holds for a subject: the source tombstoned it. */
export async function retractSourceFacts(q: Queryable, subjectKind: string, subjectId: string, sourceId: string, sourceRecord: string | null = null): Promise<number> {
  const r = await q.query(
    `update facts set superseded_at = now() where subject_kind = $1 and subject_id = $2 and source_id = $3 and superseded_at is null and ${RECORD_SCOPE("$4")}`,
    [subjectKind, subjectId, sourceId, sourceRecord],
  );
  return r.rowCount ?? 0;
}
