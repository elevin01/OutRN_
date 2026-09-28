-- Which version of the source's normalizer last turned a raw record into facts, and when its facts
-- for the same tags next change (a closing or opening date arrives, a survey stops counting). The
-- next ingest re-normalizes a record the raw store sees as unchanged when either is due, so new
-- rules and scheduled dates reach existing supply without waiting for an upstream edit.

alter table source_entities add column if not exists normalized_with text;
alter table source_entities add column if not exists renormalize_at timestamptz;

comment on column source_entities.normalized_with is
  'Normalizer version that last produced facts from this record (e.g. OSM_NORMALIZE_VERSION); null = before versioning.';
-- A claim belongs to the source record it came from (OSM node/123), so two records of one venue (a
-- node and its building) keep their own claims instead of overwriting each other's. Null for sources
-- without per-record identity (founder, first-party), which behave as before.
alter table facts add column if not exists source_record text;

-- The fact ledger is append-only: a claim is written once per time it becomes its record's active
-- assertion. Only an ACTIVE claim is unique, so returning to an earlier claim (estimate → survey →
-- survey withdrawn) adds a new row instead of reviving the superseded one and erasing its history.
drop index if exists facts_idem_uidx;
create unique index facts_idem_uidx on facts (subject_kind, subject_id, attribute, source_id, (coalesce(source_record, '')), content_hash)
  where superseded_at is null;

comment on column source_entities.renormalize_at is
  'When the same tags next normalize differently (a scheduled date); null = nothing scheduled.';
