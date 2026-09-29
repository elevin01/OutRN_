-- Overture Maps places (docs.overturemaps.org): an open places dataset, conflated monthly from Meta,
-- Microsoft, Foursquare, AllThePlaces and others, read from its public S3 bucket (GeoParquet). Used
-- only as a second opinion on venues OSM gave us: whether a place still operates, and a website or
-- phone number no other source has. It creates no venues.

insert into source_policies (id, name, product, license, terms_url, reviewed_at, allowed_ops, retention_days, attribution, geography, rate_limit, enabled, open_conditions, notes) values
  ('overture', 'Overture Maps places', 'Overture places theme (GeoParquet on the public S3 bucket)', 'CDLA-Permissive-2.0; Foursquare records Apache-2.0; AllThePlaces records CC0',
   'https://docs.overturemaps.org/attribution/', '2026-09-29',
   '{fetch,retain,derive,display}', null,
   'Places: Overture Maps Foundation (CDLA-Permissive-2.0), including Foursquare data (Apache-2.0)', 'global',
   '{"min_interval_ms": 200, "max_concurrent": 4}', true,
   '{"Keep the attribution wherever Overture-derived facts are shown","Records under any license other than CDLA-Permissive-2.0, Apache-2.0 or CC0-1.0 are left out at read time"}',
   'Status (open, or permanently closed by Overture''s own operating-status signal), website and phone, for venues matched by name and category within 120 m. Closures from company registers alone are ignored.')
on conflict (id) do nothing;
