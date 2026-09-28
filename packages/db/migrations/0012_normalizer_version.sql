-- Which version of the source's normalizer last turned a raw record into facts, and when its facts
-- for the same tags next change (a closing or opening date arrives, a survey stops counting). The
-- next ingest re-normalizes a record the raw store sees as unchanged when either is due, so new
-- rules and scheduled dates reach existing supply without waiting for an upstream edit.

alter table source_entities add column if not exists normalized_with text;
alter table source_entities add column if not exists renormalize_at timestamptz;

comment on column source_entities.normalized_with is
  'Normalizer version that last produced facts from this record (e.g. OSM_NORMALIZE_VERSION); null = before versioning.';
comment on column source_entities.renormalize_at is
  'When the same tags next normalize differently (a scheduled date); null = nothing scheduled.';
