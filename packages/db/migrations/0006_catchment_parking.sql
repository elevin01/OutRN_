-- Catchment semantics and the first parking context rule.
--
-- service_areas.radius_m is the ORIGIN catchment: where people open the app from (the backtest
-- samples origins inside it). The ingest extent is derived from it: radius_m plus the farthest a
-- trip within the mode's max travel time can reach (core maxReachMetres), so the catalog covers
-- everything the engine could call reachable from any origin in the catchment.
comment on column service_areas.radius_m is
  'Origin catchment radius (m): where users start. Ingest extent = radius_m + max reach for the travel mode.';

-- Westchester village lots are free after 6pm: no meter hunt, so the parking buffer on a drive
-- estimate drops in the evening. Estimate, not fact; per area, by local hour.
insert into context_rules (key, inputs_required, effect) values
  ('parking_westchester_village', '{hour_local}',
   '{"applies_to": {"area": ["bronxville"]}, "default_minutes": 8, "by_hour": [{"from": 18, "to": 6, "minutes": 5}], "note": "Village lots free after 6pm"}');
