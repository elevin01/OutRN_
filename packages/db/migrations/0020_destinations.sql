-- Destinations: places worth going out of the way for (a preserve, gardens, a beach, a lookout over
-- the Hudson, an estate), which an outing is built around (`outrn ingest destinations`). Which places
-- are destinations, and why in a line, is OutRN's own editorial call: a short curated list per region,
-- plus places whose record says what they are (a nature preserve, a sanctuary, an arboretum). It is
-- an estimate of what is worth the trip, never a fact about the place, and is shown as a reason only.
--
-- Safe to re-apply (migrate --reapply 0020_destinations.sql).

insert into source_policies (id, name, product, license, terms_url, reviewed_at, allowed_ops, retention_days, attribution, geography, rate_limit, enabled, open_conditions, notes) values
  ('curated', 'Curated destinations', 'OutRN editorial list', 'OutRN-owned',
   null, '2026-10-05',
   '{retain,derive,display}', null, null, 'service areas', '{}', true, '{}',
   'Which places are worth the trip, and a line on why, written by OutRN. Locations, names and contact details come from the place''s own record (Overture, OSM), never from this list.')
on conflict (id) do update set
  name = excluded.name, product = excluded.product, license = excluded.license, reviewed_at = excluded.reviewed_at,
  allowed_ops = excluded.allowed_ops, notes = excluded.notes, updated_at = now();
