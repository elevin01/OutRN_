-- Recommendation runs are kept for 30 days (engine RUN_RETENTION_DAYS); the API prunes them in
-- small batches. Rows that point at a run must not block that: they keep their own data and lose
-- only the link. Snapshots already cascade (0009).

alter table interaction_events drop constraint if exists interaction_events_run_id_fkey;
alter table interaction_events add constraint interaction_events_run_id_fkey
  foreign key (run_id) references recommendation_runs(id) on delete set null;

alter table trip_intents drop constraint if exists trip_intents_run_id_fkey;
alter table trip_intents add constraint trip_intents_run_id_fkey
  foreign key (run_id) references recommendation_runs(id) on delete set null;

comment on table recommendation_runs is
  'One row per engine run: coarsened request context (origin to ~1 km, seen/dismissed as counts) and every candidate decision. Kept 30 days.';
