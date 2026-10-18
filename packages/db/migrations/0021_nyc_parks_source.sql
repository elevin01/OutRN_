-- NYC Parks' public events (`outrn ingest nyc-parks`): the next two weeks of events on NYC Parks
-- properties that are open to the public, from NYC Open Data (dataset w3wp-dpdi, refreshed daily by
-- the Department of Parks and Recreation). Classes, tours, festivals, film nights and concerts, each
-- with when, where and whether to register first. Numbered 0021: 0020 is the destinations source.
--
-- Safe to re-apply (migrate --reapply 0021_nyc_parks_source.sql).

insert into source_policies (id, name, product, license, terms_url, reviewed_at, allowed_ops, retention_days, attribution, geography, rate_limit, enabled, open_conditions, notes) values
  ('nyc_parks', 'NYC Parks events', 'NYC Open Data: NYC Parks Public Events – Upcoming 14 Days (w3wp-dpdi)', 'NYC Open Data terms of use',
   'https://opendata.cityofnewyork.us/overview/#termsofuse', '2026-10-18',
   '{fetch,retain,derive,display}', null,
   'Events: NYC Parks (NYC Open Data)', 'New York City',
   '{"min_interval_ms": 2000, "max_concurrent": 1}', true,
   '{"Read the NYC Open Data terms of use before showing these events outside development: the page was not reachable from the build environment, so they have not been reviewed here"}',
   'One read of the whole table (about a thousand rows); an area keeps the events within its reach. Title, times, place, categories as interests, registration as admission, and free only when the listing says so. The dataset page is https://data.cityofnewyork.us/d/w3wp-dpdi.')
on conflict (id) do update set
  name = excluded.name, product = excluded.product, license = excluded.license, terms_url = excluded.terms_url, reviewed_at = excluded.reviewed_at,
  attribution = excluded.attribution, open_conditions = excluded.open_conditions, notes = excluded.notes, updated_at = now();
