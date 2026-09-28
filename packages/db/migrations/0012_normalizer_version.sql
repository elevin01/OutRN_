-- Which version of the source's normalizer last turned a raw record into facts. When the rules
-- change, the next ingest re-normalizes records the raw store sees as unchanged, so new rules reach
-- existing supply without waiting for every OSM element to be edited.

alter table source_entities add column if not exists normalized_with text;

comment on column source_entities.normalized_with is
  'Normalizer version that last produced facts from this record (e.g. OSM_NORMALIZE_VERSION); null = before versioning.';
