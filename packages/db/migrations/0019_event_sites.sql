-- Pop-ups with no place of their own (fireworks from a pier, a street fair's block) are held at an
-- event site: a venue shown only through its events (`outrn ingest events`). Like a stage, it has no
-- visit of its own: the event's times are the visit. Defaults are ESTIMATES, like every row here.
insert into category_policies (category, min_useful_minutes, admission_buffer_minutes, kitchen_close_offset_minutes, last_entry_default_minutes, activity_type, rationale) values
  ('event_site', 0, 5, null, null, 'entertainment', 'Duration comes from the occurrence; a pop-up has no visit of its own, and no door to queue at')
on conflict (category) do update set min_useful_minutes = excluded.min_useful_minutes, admission_buffer_minutes = excluded.admission_buffer_minutes,
  kitchen_close_offset_minutes = excluded.kitchen_close_offset_minutes, last_entry_default_minutes = excluded.last_entry_default_minutes,
  activity_type = excluded.activity_type, rationale = excluded.rationale;
