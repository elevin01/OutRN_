-- Westchester and the Bronx.
--
-- New areas start as 'ingest_only': the pipeline can fill them, the API does not serve them. Bring
-- one online with: outrn ingest osm --area <slug> → outrn backtest --area <slug> → outrn areas launch <slug>.
--
-- Centers are each downtown's main street (Fordham–Belmont for the Bronx), placed from local
-- knowledge rather than a geocoder: check them on a map and correct with `outrn areas set`.
-- radius_m is the origin catchment (where people open the app from); the ingest extent adds the
-- travel mode's reach (drive ≈ 13 km, transit ≈ 6 km), so neighbouring areas overlap and share venues.

insert into service_areas (slug, name, center, radius_m, timezone, travel_mode, launch_state) values
  ('bronx',        'The Bronx',                 ST_SetSRID(ST_MakePoint(-73.8800, 40.8520), 4326)::geography, 6000, 'America/New_York', 'transit', 'ingest_only'),
  ('yonkers',      'Yonkers',                   ST_SetSRID(ST_MakePoint(-73.8780, 40.9360), 4326)::geography, 4500, 'America/New_York', 'drive',   'ingest_only'),
  ('mount_vernon', 'Mount Vernon',              ST_SetSRID(ST_MakePoint(-73.8375, 40.9126), 4326)::geography, 2500, 'America/New_York', 'drive',   'ingest_only'),
  ('new_rochelle', 'New Rochelle',              ST_SetSRID(ST_MakePoint(-73.7830, 40.9115), 4326)::geography, 3500, 'America/New_York', 'drive',   'ingest_only'),
  ('scarsdale',    'Scarsdale',                 ST_SetSRID(ST_MakePoint(-73.8083, 40.9895), 4326)::geography, 2500, 'America/New_York', 'drive',   'ingest_only'),
  ('white_plains', 'White Plains',              ST_SetSRID(ST_MakePoint(-73.7640, 41.0340), 4326)::geography, 3000, 'America/New_York', 'drive',   'ingest_only'),
  ('mamaroneck',   'Mamaroneck & Larchmont',    ST_SetSRID(ST_MakePoint(-73.7423, 40.9384), 4326)::geography, 2500, 'America/New_York', 'drive',   'ingest_only'),
  ('rye',          'Rye',                       ST_SetSRID(ST_MakePoint(-73.6838, 40.9812), 4326)::geography, 2500, 'America/New_York', 'drive',   'ingest_only'),
  ('port_chester', 'Port Chester',              ST_SetSRID(ST_MakePoint(-73.6655, 41.0020), 4326)::geography, 2000, 'America/New_York', 'drive',   'ingest_only'),
  ('tarrytown',    'Tarrytown & Sleepy Hollow', ST_SetSRID(ST_MakePoint(-73.8620, 41.0800), 4326)::geography, 2500, 'America/New_York', 'drive',   'ingest_only')
on conflict (slug) do nothing;

-- Parking buffers on drive estimates. Estimates, not facts: refine per area as they're checked
-- (Bronxville's evening rule was; these are not yet).
insert into context_rules (key, inputs_required, effect) values
  ('parking_westchester_downtown', '{hour_local}',
   '{"applies_to": {"area": ["scarsdale", "rye", "mamaroneck", "tarrytown", "port_chester"]}, "default_minutes": 8, "by_hour": [], "note": "Village downtown lots and metered streets; not yet checked per village"}'),
  ('parking_westchester_city', '{hour_local}',
   '{"applies_to": {"area": ["white_plains", "new_rochelle", "yonkers", "mount_vernon"]}, "default_minutes": 10, "by_hour": [], "note": "City downtown garages and meters; not yet checked"}'),
  ('parking_bronx', '{hour_local}',
   '{"applies_to": {"area": ["bronx"]}, "default_minutes": 15, "by_hour": [{"from": 1, "to": 6, "minutes": 10}], "note": "Street parking hunt; transit is the area default"}')
on conflict (key) do nothing;
