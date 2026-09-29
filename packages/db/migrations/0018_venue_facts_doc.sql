-- A venue's current facts as one document, kept by materialization (packages/facts/src/materialize.ts,
-- refreshFactDocs), so a search reads one value per candidate instead of aggregating current_facts and
-- the facts behind each row for every venue in reach. The request path still enforces valid_until.
--
-- Safe to re-apply (migrate --reapply 0018_venue_facts_doc.sql): the backfill below is the same
-- expression as VENUE_FACTS_DOC_SQL in packages/core/src/evidence.ts, so it only rewrites what
-- materialization would write.

alter table venues add column if not exists facts_doc jsonb not null default '{}'::jsonb;

update venues v set facts_doc = coalesce((select jsonb_object_agg(cf.attribute, jsonb_build_object('value', cf.value, 'confidence', cf.confidence, 'evidence_class', cf.evidence_class, 'valid_until', cf.valid_until, 'independent_sources', cf.independent_sources, 'sources', cf.source_ids, 'conflict', cf.conflict, 'verified_at', (select max(case when f.source_id = 'founder' then f.source_updated_at when f.evidence_class = 'observation' then f.observed_at end) from facts f where f.id = any(cf.input_fact_ids)))) from current_facts cf where cf.subject_kind = 'venue' and cf.subject_id = v.id), '{}'::jsonb)
 where v.publish_state <> 'merged';
