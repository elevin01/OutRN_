-- Seed data that is policy, not fact: source registry, category defaults, context rules, test areas.
-- Everything here is versioned and overridable; nothing here is a claim about a real venue.

insert into source_policies (id, name, product, license, terms_url, reviewed_at, allowed_ops, retention_days, attribution, geography, rate_limit, enabled, open_conditions, notes) values
  ('osm', 'OpenStreetMap', 'Overpass API extract', 'ODbL 1.0',
   'https://www.openstreetmap.org/copyright', '2026-09-26',
   '{fetch,retain,derive,display}', null,
   '© OpenStreetMap contributors', 'global',
   '{"min_interval_ms": 2000, "max_concurrent": 1}', true,
   '{"Decide separable OSM-derived layer vs share-alike on the combined venue table before production merge","Do not point production at the free public Overpass instance"}',
   'Storable base catalog. Tags are not real-world verification; hours tags are often stale.'),

  ('foursquare_os', 'Foursquare OS Places', 'Open dataset (Iceberg/Parquet)', 'Apache-2.0',
   'https://docs.foursquare.com/data-products/docs/access-fsq-os-places', '2026-09-26',
   '{}', null,
   'Foursquare OS Places', 'global',
   '{}', false,
   '{"Obtain portal token / bulk export","No hours, price, ratings or photos in the open schema"}',
   'Second identity source and closure cross-check. Disabled until export is in hand.'),

  ('firstparty', 'First-party venue sites', 'Site-by-site fetch', 'Site terms',
   null, '2026-09-26',
   '{fetch,derive,display}', 30,
   null, 'registered sites only',
   '{"min_interval_ms": 5000, "max_concurrent": 2, "per_host_per_day": 4}', true,
   '{"Public visibility is not bulk-reuse permission; register each site with a reviewed reason"}',
   'JSON-LD first, then parser, then LLM extraction. Facts extracted are evidence-linked; raw HTML is not retained.'),

  ('nws', 'National Weather Service', 'api.weather.gov', 'US Government open data',
   'https://www.weather.gov/documentation/services-web-api', '2026-09-26',
   '{fetch,retain,derive,display}', 7,
   'NOAA / National Weather Service', 'US',
   '{"min_interval_ms": 1000, "max_concurrent": 1}', true,
   '{}',
   'Hourly forecast and alerts. Requires a User-Agent identifying the app.'),

  ('sunset', 'Sunset calculation', 'suncalc (local computation)', 'n/a',
   null, '2026-09-26',
   '{derive,display}', null, null, 'global', '{}', true, '{}',
   'Computed locally from coordinates and date. Sunset proves neither a view nor access.'),

  ('user_observation', 'User and scout observations', 'OutRN contribution loop', 'OutRN-owned',
   null, '2026-09-26',
   '{retain,derive,display}', null, null, 'service areas', '{}', true, '{}',
   'Closed-form answers after a possible visit. Weighted by contributor reliability.'),

  ('category_policy', 'Category defaults (estimates)', 'OutRN policy', 'OutRN-owned',
   null, '2026-09-26',
   '{derive,display}', null, null, 'global', '{}', true, '{}',
   'Source id used on estimate-class facts derived from category_policies so lineage is explicit.'),

  ('google_places', 'Google Places API (New)', 'Place Details / Nearby', 'Google Maps Platform Terms',
   'https://developers.google.com/maps/documentation/places/web-service/policies', '2026-09-26',
   '{}', 0,
   'Google', 'global', '{}', false,
   '{"Validate exact OutRN use against storage/derived-use restrictions","Set a monthly budget cap","Keep only place IDs; never persist content"}',
   'Optional bounded per-request enrichment. Off by default.'),

  ('ticketmaster', 'Ticketmaster Discovery', 'Discovery API v2', 'Ticketmaster API Terms',
   'https://developer.ticketmaster.com/products-and-docs/apis/discovery-api/v2/', '2026-09-26',
   '{}', 1,
   'Ticketmaster', 'US', '{"per_day": 5000, "per_second": 5}', false,
   '{"Confirm commercial/affiliate fit","Retention limited to service period; removals within 24h"}',
   'Conditional event connector for large venues.');

-- Category defaults are ESTIMATES. They fill gaps until a venue-specific published value exists.
insert into category_policies (category, min_useful_minutes, admission_buffer_minutes, kitchen_close_offset_minutes, last_entry_default_minutes, activity_type, rationale) values
  ('restaurant',   60, 10, 40,   null, 'food',          'Kitchens typically stop 30–45 min before posted close'),
  ('cafe',         30,  5, null, null, 'food',          'A coffee is worth it at 30 min'),
  ('dessert',      25,  5, null, null, 'food',          null),
  ('bar',          45,  5, null, null, 'drink',         'Bar close is not kitchen close'),
  ('museum',       80, 10, null, 60,   'culture',       'Assume admission stops an hour before close unless published; some are tour-only'),
  ('gallery',      40,  5, null, 30,   'culture',       null),
  ('arts_centre',  60, 10, null, 30,   'culture',       null),
  ('theatre',      0,  15, null, null, 'entertainment', 'Duration comes from the occurrence'),
  ('cinema',       0,  15, null, null, 'entertainment', 'Duration comes from the occurrence; showtime is not seat availability'),
  ('live_music',   0,  15, null, null, 'entertainment', 'Duration comes from the occurrence'),
  ('community',    45,  5, null, null, 'culture',       null),
  ('market',       45,  5, null, null, 'browse',        'Published start may be setup time'),
  ('park',         45,  5, null, null, 'outdoors',      'Sunset and weather rules apply'),
  ('garden',       45,  5, null, 30,   'outdoors',      'Gardens often close at dusk with last entry earlier'),
  ('waterfront',   40,  5, null, null, 'outdoors',      'Mapped near water is not a view'),
  ('viewpoint',    25,  5, null, null, 'outdoors',      null),
  ('attraction',   60, 10, null, 45,   'culture',       null),
  ('library',      45,  5, null, null, 'culture',       null),
  ('bookshop',     30,  5, null, null, 'browse',        null),
  ('other',        45,  5, null, null, 'browse',        null);

insert into context_rules (key, inputs_required, effect, active_from, active_to) values
  ('sunset_viewpoint', '{sunset_time,weather.cloud_cover}',
   '{"appeal_delta": 0.15, "applies_to": {"category": ["viewpoint","waterfront","park"]}, "window_before_min": 60, "window_after_min": 20, "max_cloud_cover": 70, "reason": "SUNSET_WINDOW"}', null, null),
  ('rain_indoor', '{weather.precip_probability}',
   '{"appeal_delta_outdoor": -0.25, "appeal_delta_indoor": 0.05, "min_precip_probability": 50, "reason": "WEATHER_SUITABLE"}', null, null),
  ('cold_indoor', '{weather.temperature_f}',
   '{"appeal_delta_outdoor": -0.15, "max_temperature_f": 38, "reason": "WEATHER_SUITABLE"}', null, null),
  ('closes_soon_penalty', '{}',
   '{"fit_delta": -0.10, "slack_under_min": 20, "reason": "CLOSES_SOON"}', null, null);

-- Two test points from the 26 Sep audit. Radius is the ingest extent, not a claimed catchment.
insert into service_areas (slug, name, center, radius_m, timezone, travel_mode, launch_state) values
  ('les',        'Lower East Side (test point)', ST_SetSRID(ST_MakePoint(-73.9880, 40.7185), 4326)::geography, 1500, 'America/New_York', 'walk',  'test'),
  ('bronxville', 'Bronxville (test point)',      ST_SetSRID(ST_MakePoint(-73.8350, 40.9410), 4326)::geography, 1500, 'America/New_York', 'drive', 'test');
