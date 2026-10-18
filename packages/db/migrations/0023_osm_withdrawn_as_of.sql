-- When the data that withdrew a record was current: for OpenStreetMap, the snapshot's base time
-- (`osm3s.timestamp_osm_base`); null when it didn't say, and for records withdrawn before this column.
-- A snapshot older than this cannot bring the record back (a lagging mirror still lists what was
-- deleted since); a newer version of the record can.
alter table source_entities add column if not exists withdrawn_as_of timestamptz;
