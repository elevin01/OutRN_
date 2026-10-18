-- When a record was last seen missing where it would have shown: the data time (for OpenStreetMap,
-- `osm3s.timestamp_osm_base`) of the newest snapshot that lacked it inside its circle, or held it from
-- outside a circle no wider and let go of it. Kept while another area still holds the record, so the
-- newest sign of its absence survives whichever area lets go of it last; cleared by a snapshot as new
-- that has it. Null when unknown, and for records stored before this column.
-- A snapshot older than this cannot hold the record or bring it back (a lagging mirror still lists
-- what was deleted since); a newer version of the record can.
alter table source_entities add column if not exists absent_as_of timestamptz;
