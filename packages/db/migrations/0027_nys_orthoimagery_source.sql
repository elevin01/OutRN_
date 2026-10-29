-- An aerial photo of every place in New York: New York State's orthoimagery (NYS ITS Geospatial
-- Services, flown 2022-2025, 6 or 12 inch pixels), drawn by the state's own map server for a box
-- centred on the place. The API sends only the image's URL (packages/api/src/service/aerial.ts);
-- nothing is fetched or stored. Outside the state (Greenwich, across the Hudson) there is none.
--
-- Display only: switching it off (kill_switch or enabled = false) leaves every card's `aerial` null.
--
-- Safe to re-apply (migrate --reapply 0027_nys_orthoimagery_source.sql): a re-apply keeps the switch,
-- the review and its conditions as they were set.

insert into source_policies (id, name, product, license, terms_url, reviewed_at, allowed_ops, retention_days, attribution, geography, rate_limit, enabled, open_conditions, notes) values
  ('nys_orthoimagery', 'New York State orthoimagery', 'NYS ITS Geospatial Services: statewide orthoimagery map service (wms/Latest), 2022-2025',
   'New York State public data, free to use with credit', 'https://gis.ny.gov/orthoimagery', '2026-10-29',
   '{display}', null,
   'Aerial photos: NYS ITS Geospatial Services orthoimagery', 'New York State',
   '{}', true,
   '{"Shown only as an image the client loads from orthos.its.ny.gov, labelled as an aerial view with its credit","One 800x500 image a place, its box rounded to the metre so a place always has the same URL"}',
   'Built by aerialOf from the venue''s point; outside New York (NY_RINGS, from the Census Bureau''s TIGERweb) there is none.')
on conflict (id) do update set
  name = excluded.name, product = excluded.product, attribution = excluded.attribution, geography = excluded.geography,
  notes = excluded.notes, updated_at = now();
