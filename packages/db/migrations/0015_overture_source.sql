-- Overture Maps places (docs.overturemaps.org): an open places dataset, conflated monthly from several
-- providers, read from its public S3 bucket (GeoParquet). Used only as a second opinion on venues OSM
-- gave us: whether a place still operates, and a website or phone number no other source has. It
-- creates no venues. A record is kept only when every one of its sources is CDLA-Permissive-2.0 or
-- CC0-1.0, so Foursquare's records (Apache-2.0) are left out.
--
-- Safe to re-apply (migrate --reapply 0015_overture_source.sql): a database that ran an earlier draft
-- gets this license, attribution and conditions; its operations, rate limit and switches stay as set.

insert into source_policies (id, name, product, license, terms_url, reviewed_at, allowed_ops, retention_days, attribution, geography, rate_limit, enabled, open_conditions, notes) values
  ('overture', 'Overture Maps places', 'Overture places theme (GeoParquet on the public S3 bucket)', 'CDLA-Permissive-2.0; AllThePlaces records CC0-1.0',
   'https://docs.overturemaps.org/attribution/', '2026-09-29',
   '{fetch,retain,derive,display}', null,
   'Places: Overture Maps Foundation (CDLA-Permissive-2.0)', 'global',
   '{"min_interval_ms": 200, "max_concurrent": 4}', true,
   '{"Keep the attribution wherever Overture-derived facts are shown","A record is kept only when it lists its sources and every one carries CDLA-Permissive-2.0 or CC0-1.0: any other license, or none, leaves it out at read time","Foursquare''s Apache-2.0 records are left out until its NOTICE ships with the data and the API''s developer documentation"}',
   'Status (open, or permanently closed by Overture''s own operating-status signal), website and phone, for venues matched by name and category within 120 m. Closures from company registers alone are ignored.')
on conflict (id) do update set
  name = excluded.name, product = excluded.product, license = excluded.license, terms_url = excluded.terms_url, reviewed_at = excluded.reviewed_at,
  attribution = excluded.attribution, open_conditions = excluded.open_conditions, notes = excluded.notes, updated_at = now();
