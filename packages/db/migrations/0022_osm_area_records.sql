-- Which areas' OpenStreetMap snapshots hold a record (`outrn ingest osm`). A snapshot lets go of
-- what it held and no longer has: inside its circle, where it speaks for everything; held "from
-- outside" a circle no wider than this one (a way meeting the circle, its point a little beyond),
-- where it could have kept it; and beyond anything the area keeps. A record is withdrawn once no
-- area holds it: another area's snapshot, from a mirror of another age say, may still have it. A
-- smaller snapshot says nothing of what a wider one held.
-- Numbered 0022: 0020 is the destinations source, 0021 NYC Parks.
--
-- Safe to re-apply (migrate --reapply 0022_osm_area_records.sql): the backfill only adds what is
-- missing.

create table if not exists osm_area_records (
  area_id           uuid not null references service_areas(id) on delete cascade,
  source_entity_id  uuid not null references source_entities(id) on delete cascade,
  run_id            uuid not null references ingestion_runs(id) on delete cascade,
  -- Held from outside a snapshot's circle of this radius (see above); null when held from inside.
  outside_of_m      integer check (outside_of_m > 0),
  primary key (area_id, source_entity_id)
);
create index if not exists osm_area_records_entity_idx on osm_area_records (source_entity_id);

-- Server-side only, like every other table (0005): no policy, so no anonymous access.
alter table osm_area_records enable row level security;

-- Records stored before this table: held by the area whose snapshot last saw them.
insert into osm_area_records (area_id, source_entity_id, run_id)
select r.area_id, s.id, s.last_seen_run_id
  from source_entities s join ingestion_runs r on r.id = s.last_seen_run_id
 where s.source_id = 'osm' and s.deleted_at is null and r.area_id is not null
on conflict (area_id, source_entity_id) do nothing;
