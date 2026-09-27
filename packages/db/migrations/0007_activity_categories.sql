-- Activity venues were missing from the vocabulary (26 Sep: Homefield Bowl, Bowlero never ingested).
-- Defaults are ESTIMATES, like every row in category_policies.
insert into category_policies (category, min_useful_minutes, admission_buffer_minutes, kitchen_close_offset_minutes, last_entry_default_minutes, activity_type, rationale) values
  ('bowling',   60, 10, null, null, 'entertainment', 'A game or two; lanes may have a wait'),
  ('arcade',    40,  5, null, null, 'entertainment', null),
  ('nightclub', 60, 10, null, null, 'drink',         'Door policy and cover are often unknown'),
  ('activity',  60, 10, null, null, 'entertainment', 'Escape rooms, mini golf, rinks, climbing, karaoke, casinos; escape rooms are booked by the slot');
