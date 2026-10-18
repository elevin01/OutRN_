-- NYC Parks' public events (`outrn ingest nyc-parks`): the next two weeks of events on NYC Parks
-- properties that are open to the public, from NYC Open Data (dataset w3wp-dpdi, refreshed daily by
-- the Department of Parks and Recreation). Classes, tours, festivals, film nights and concerts, each
-- with when, where and whether to register first. Numbered 0021: 0020 is the destinations source.
--
-- The source is registered DISABLED: its terms (NYC Open Data's terms of use) have not been read for
-- it, and nothing it gives may be fetched, kept or shown until they have. Whoever reads them enables
-- it, recording the review:
--   update source_policies set enabled = true, reviewed_at = '<date read>', open_conditions = '{}'
--    where id = 'nyc_parks';
--
-- Safe to re-apply (migrate --reapply 0021_nyc_parks_source.sql): a re-apply keeps the switch, the
-- review and its conditions as they were set.

insert into source_policies (id, name, product, license, terms_url, reviewed_at, allowed_ops, retention_days, attribution, geography, rate_limit, enabled, open_conditions, notes) values
  ('nyc_parks', 'NYC Parks events', 'NYC Open Data: NYC Parks Public Events – Upcoming 14 Days (w3wp-dpdi)', 'NYC Open Data terms of use (not yet reviewed)',
   'https://opendata.cityofnewyork.us/overview/#termsofuse', null,
   '{fetch,retain,derive,display}', null,
   'Events: NYC Parks (NYC Open Data)', 'New York City',
   '{"min_interval_ms": 2000, "max_concurrent": 1}', false,
   '{"Read the NYC Open Data terms of use and record the review (reviewed_at) before enabling: the page was not reachable from the build environment, so they have not been reviewed"}',
   'One read of the whole table (about a thousand rows); an area keeps the events within its reach, and an event its area''s read no longer lists is withdrawn once no area lists it. Title, times, place, categories as interests, registration as admission, and free only when the listing says so without condition. The dataset page is https://data.cityofnewyork.us/d/w3wp-dpdi.')
on conflict (id) do update set
  name = excluded.name, product = excluded.product, terms_url = excluded.terms_url,
  attribution = excluded.attribution, notes = excluded.notes, updated_at = now();

-- An event a source's complete listing for an area no longer has, and no other area's listing has
-- either, is withdrawn: kept on record, shown nowhere. Unlike cancelled, it says only that the source
-- stopped listing it. Listed again, it is scheduled again.
alter table occurrences drop constraint if exists occurrences_status_check;
alter table occurrences add constraint occurrences_status_check check (status in ('scheduled', 'cancelled', 'sold_out', 'ended', 'withdrawn'));

-- Which areas' listings have an event: one row per source, area and occurrence, from the area's last
-- complete read (ingestEvents with complete: true).
create table if not exists event_listings (
  source_id      text not null references source_policies(id),
  area_id        uuid not null references service_areas(id) on delete cascade,
  occurrence_id  uuid not null references occurrences(id) on delete cascade,
  run_id         uuid not null references ingestion_runs(id) on delete cascade,
  seen_at        timestamptz not null,
  primary key (source_id, area_id, occurrence_id)
);
create index if not exists event_listings_occurrence_idx on event_listings (occurrence_id);

-- Server-side only, like every other table (0005): no policy, so no anonymous access.
alter table event_listings enable row level security;

-- Anonymous readers (0005) see neither ended nor withdrawn events.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    drop policy if exists anon_read_occurrences on occurrences;
    create policy anon_read_occurrences on occurrences for select to anon
      using (status not in ('ended', 'withdrawn') and exists (select 1 from venues v where v.id = occurrences.venue_id and v.publish_state = 'eligible'));
  end if;
end $$;
