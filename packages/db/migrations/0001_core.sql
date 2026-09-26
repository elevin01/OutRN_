-- OutRN core schema. Forward-only. Runs identically on local Postgres 16 + PostGIS and on Supabase.
-- Domains: source-owned (raw imports), OutRN-authored (policies, overrides, observations, users),
-- derived (venues, current_facts, runs). Restricted provider content gets its own retention columns.

create extension if not exists postgis;
create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Owned: service areas and policies
-- ---------------------------------------------------------------------------

create table service_areas (
  id            uuid primary key default gen_random_uuid(),
  slug          text not null unique,
  name          text not null,
  center        geography(point, 4326) not null,
  boundary      geography(polygon, 4326),
  radius_m      integer,                          -- used when boundary is null (test points)
  timezone      text not null default 'America/New_York',
  travel_mode   text not null check (travel_mode in ('walk','drive','transit')),
  launch_state  text not null default 'test' check (launch_state in ('test','ingest_only','private_beta','live','paused')),
  created_at    timestamptz not null default now()
);
create index service_areas_center_gix on service_areas using gist (center);

-- What each connector may fetch, retain, derive and display. Unknown permission = disabled.
create table source_policies (
  id               text primary key,               -- 'osm', 'foursquare_os', 'nws', 'firstparty', 'sunset', 'user_observation'
  name             text not null,
  product          text,
  license          text,
  terms_url        text,
  reviewed_at      date,
  allowed_ops      text[] not null default '{}',   -- subset of {fetch, retain, derive, display}
  allowed_fields   text[],                         -- null = all fields the connector knows
  retention_days   integer,                        -- null = indefinite (only for storable licenses)
  attribution      text,
  geography        text,
  quota            jsonb not null default '{}'::jsonb,       -- {"per_day": 5000}
  rate_limit       jsonb not null default '{}'::jsonb,       -- {"per_second": 1, "min_interval_ms": 1500}
  enabled          boolean not null default false,
  kill_switch      boolean not null default false,
  open_conditions  text[] not null default '{}',
  notes            text,
  updated_at       timestamptz not null default now()
);

create table category_policies (
  category                     text primary key,
  min_useful_minutes           integer not null,
  admission_buffer_minutes     integer not null default 5,
  kitchen_close_offset_minutes integer,            -- restaurants: kitchen stops N min before posted close
  last_entry_default_minutes   integer,            -- museums: assume admission stops N min before close, unless published
  activity_type                text not null,
  version                      integer not null default 1,
  rationale                    text
);

create table context_rules (
  id              uuid primary key default gen_random_uuid(),
  key             text not null unique,            -- 'sunset_viewpoint', 'rain_indoor', 'free_hours'
  inputs_required text[] not null default '{}',
  effect          jsonb not null,                  -- {"appeal_delta": 0.15, "applies_to": {"category": ["viewpoint","waterfront"]}}
  version         integer not null default 1,
  active_from     date,
  active_to       date,
  enabled         boolean not null default true
);

-- ---------------------------------------------------------------------------
-- Source-owned: runs and raw records
-- ---------------------------------------------------------------------------

create table ingestion_runs (
  id           uuid primary key default gen_random_uuid(),
  source_id    text not null references source_policies(id),
  area_id      uuid references service_areas(id),
  kind         text not null,                      -- 'overpass_area', 'firstparty_site', 'nws_forecast', 'replay'
  params       jsonb not null default '{}'::jsonb,
  cursor       jsonb,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  status       text not null default 'running' check (status in ('running','succeeded','failed','partial')),
  counts       jsonb not null default '{}'::jsonb, -- {"fetched": 1673, "new": 40, "changed": 3, "unchanged": 1630}
  cost_cents   integer not null default 0,
  error        text
);
create index ingestion_runs_source_idx on ingestion_runs (source_id, started_at desc);

create table source_entities (
  id                uuid primary key default gen_random_uuid(),
  source_id         text not null references source_policies(id),
  external_id       text not null,                 -- 'node/123', 'way/456', foursquare fsq_id, URL for firstparty
  kind              text not null check (kind in ('venue','occurrence','area_snapshot')),
  raw               jsonb not null,
  content_hash      text not null,
  geom              geography(point, 4326),
  first_seen_run_id uuid references ingestion_runs(id),
  last_seen_run_id  uuid references ingestion_runs(id),
  source_updated_at timestamptz,
  fetched_at        timestamptz not null,
  retention_until   timestamptz,                   -- enforced by the expiry job for restricted sources
  deleted_at        timestamptz,                   -- source removed it; we keep the tombstone
  unique (source_id, external_id)
);
create index source_entities_geom_gix on source_entities using gist (geom);
create index source_entities_kind_idx on source_entities (source_id, kind);

-- ---------------------------------------------------------------------------
-- Derived + owned: venues, links, occurrences
-- ---------------------------------------------------------------------------

create table venues (
  id               uuid primary key default gen_random_uuid(),
  canonical_name   text not null,
  name_key         text not null,                  -- normalized for matching
  geom             geography(point, 4326) not null,
  category         text not null,
  area_id          uuid references service_areas(id),
  timezone         text not null default 'America/New_York',
  publish_state    text not null default 'candidate'
                   check (publish_state in ('candidate','eligible','excluded','suspended','merged')),
  parent_venue_id  uuid references venues(id),     -- museum café inside a museum
  merged_into      uuid references venues(id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index venues_geom_gix on venues using gist (geom);
create index venues_state_cat_idx on venues (publish_state, category);
create index venues_name_key_idx on venues (name_key);

-- Every source record → venue decision, with evidence, reversible. History is kept via superseded_by.
create table entity_links (
  id                uuid primary key default gen_random_uuid(),
  source_entity_id  uuid not null references source_entities(id),
  venue_id          uuid not null references venues(id),
  score             numeric(5,3) not null,
  decision          text not null check (decision in ('auto','review','manual','rejected','split')),
  evidence          jsonb not null default '{}'::jsonb,
  decided_by        text not null default 'system',
  decided_at        timestamptz not null default now(),
  superseded_by     uuid references entity_links(id)
);
create index entity_links_venue_idx on entity_links (venue_id) where superseded_by is null;
create index entity_links_source_idx on entity_links (source_entity_id) where superseded_by is null;
create index entity_links_review_idx on entity_links (decision) where decision = 'review' and superseded_by is null;

create table occurrences (
  id                uuid primary key default gen_random_uuid(),
  venue_id          uuid not null references venues(id),
  source_entity_id  uuid references source_entities(id),
  title             text not null,
  start_at          timestamptz not null,
  end_at            timestamptz,
  entry_cutoff_at   timestamptz,                   -- published late-entry cutoff, if any
  late_entry        boolean,                       -- null = unknown
  timezone          text not null default 'America/New_York',
  status            text not null default 'scheduled' check (status in ('scheduled','cancelled','sold_out','ended')),
  recurrence_key    text,                          -- links materialized instances of one recurring event
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index occurrences_start_idx on occurrences (start_at, status);
create index occurrences_venue_idx on occurrences (venue_id);

-- ---------------------------------------------------------------------------
-- Facts: append-only evidence. current_facts: the materialized best value.
-- ---------------------------------------------------------------------------

create table facts (
  id                 uuid primary key default gen_random_uuid(),
  subject_kind       text not null check (subject_kind in ('venue','occurrence')),
  subject_id         uuid not null,
  attribute          text not null,
  value              jsonb not null,
  evidence_class     text not null check (evidence_class in ('published','observation','estimate')),
  source_id          text not null references source_policies(id),
  evidence           text,                         -- quote or URL a reviewer can check
  source_updated_at  timestamptz,                  -- when the source says it changed this
  fetched_at         timestamptz not null,         -- when we retrieved it
  observed_at        timestamptz,                  -- when a human saw it (observations)
  valid_from         timestamptz,
  valid_until        timestamptz,
  confidence         numeric(4,3) not null check (confidence between 0 and 1),
  lineage_group      text,                         -- sources sharing an upstream share a group
  ingestion_run_id   uuid references ingestion_runs(id),
  content_hash       text not null,
  created_at         timestamptz not null default now(),
  superseded_at      timestamptz                   -- set when the same source re-asserts a different value
);
create unique index facts_idem_uidx on facts (subject_kind, subject_id, attribute, source_id, content_hash);
create index facts_subject_idx on facts (subject_kind, subject_id, attribute) where superseded_at is null;
create index facts_expiry_idx on facts (valid_until) where superseded_at is null and valid_until is not null;

create table current_facts (
  subject_kind   text not null,
  subject_id     uuid not null,
  attribute      text not null,
  value          jsonb not null,
  evidence_class text not null,
  confidence     numeric(4,3) not null,
  source_ids     text[] not null,
  input_fact_ids uuid[] not null,
  independent_sources integer not null default 1,
  conflict       boolean not null default false,
  valid_until    timestamptz,
  computed_at    timestamptz not null default now(),
  primary key (subject_kind, subject_id, attribute)
);
create index current_facts_subject_idx on current_facts (subject_id);

-- ---------------------------------------------------------------------------
-- Owned: overrides, runs, interactions, contributions
-- ---------------------------------------------------------------------------

create table venue_overrides (
  id          uuid primary key default gen_random_uuid(),
  venue_id    uuid not null references venues(id),
  kind        text not null check (kind in ('boost','exclude','review')),
  weight      numeric(4,3) not null default 0,     -- boost: appeal delta
  reason      text not null,
  owner       text not null,
  review_at   date,
  expires_at  timestamptz,
  created_at  timestamptz not null default now()
);
create index venue_overrides_venue_idx on venue_overrides (venue_id);

create table recommendation_runs (
  id              uuid primary key default gen_random_uuid(),
  area_id         uuid references service_areas(id),
  context         jsonb not null,                  -- coarse location, window, mode, budget, chips (no precise coords)
  candidate_count integer not null,
  results         jsonb not null,                  -- [{item_kind, item_id, class, reasons[], scores{}, excluded_by?}]
  shortlist       jsonb not null,                  -- [{item_kind, item_id, class, reason_codes[]}]
  engine_version  text not null,
  weights_version text not null,
  duration_ms     integer,
  created_at      timestamptz not null default now()
);
create index recommendation_runs_created_idx on recommendation_runs (created_at desc);

create table interaction_events (
  id          uuid primary key default gen_random_uuid(),
  device_id   text not null,
  run_id      uuid references recommendation_runs(id),
  item_kind   text,
  item_id     uuid,
  type        text not null check (type in ('impression','detail','save','unsave','dismiss','go','book','share','report')),
  payload     jsonb not null default '{}'::jsonb,  -- dismiss: {"reason": "too_far"}
  created_at  timestamptz not null default now()
);
create index interaction_events_device_idx on interaction_events (device_id, created_at desc);
create index interaction_events_item_idx on interaction_events (item_id, type);

create table trip_intents (
  id                   uuid primary key default gen_random_uuid(),
  device_id            text not null,
  run_id               uuid references recommendation_runs(id),
  item_kind            text not null,
  item_id              uuid not null,
  arrival_window_start timestamptz not null,
  arrival_window_end   timestamptz not null,
  consent              jsonb not null default '{}'::jsonb, -- {"prompt": true, "location": false}
  prompt_state         text not null default 'pending' check (prompt_state in ('pending','asked','answered','skipped','expired')),
  outcome              text check (outcome in ('went','did_not_go','not_yet')),
  created_at           timestamptz not null default now()
);
create index trip_intents_window_idx on trip_intents (arrival_window_end) where prompt_state = 'pending';

create table contributors (
  id           uuid primary key default gen_random_uuid(),
  device_id    text unique,
  auth_user_id uuid unique,                        -- Supabase auth.users.id when signed in
  role         text not null default 'contributor' check (role in ('contributor','scout','editor','admin')),
  created_at   timestamptz not null default now()
);

create table contributor_reliability (
  contributor_id  uuid not null references contributors(id),
  attribute       text not null,
  reliability     numeric(4,3) not null default 0.500,
  resolved_trials integer not null default 0,
  agreements      integer not null default 0,
  abuse_flags     integer not null default 0,
  updated_at      timestamptz not null default now(),
  primary key (contributor_id, attribute)
);

create table observations (
  id                uuid primary key default gen_random_uuid(),
  subject_kind      text not null check (subject_kind in ('venue','occurrence')),
  subject_id        uuid not null,
  attribute         text not null,
  value             jsonb not null,                -- closed-form answer only
  observed_at       timestamptz not null,
  contributor_id    uuid references contributors(id),
  trip_intent_id    uuid references trip_intents(id),
  proximity         jsonb,                         -- {"distance_m": 42, "accuracy_m": 15} — evidence, not proof
  moderation_state  text not null default 'accepted' check (moderation_state in ('accepted','held','rejected')),
  fact_id           uuid references facts(id),     -- the fact row this observation produced
  created_at        timestamptz not null default now()
);
create index observations_subject_idx on observations (subject_id, attribute, observed_at desc);

create table verification_tasks (
  id             uuid primary key default gen_random_uuid(),
  subject_kind   text not null,
  subject_id     uuid not null,
  attribute      text not null,
  question       text not null,
  options        jsonb not null,                   -- ["open","closed","not_sure"]
  priority       numeric(8,3) not null,            -- exposure × consequence × uncertainty
  dedupe_key     text not null unique,
  expires_at     timestamptz not null,
  resolved_at    timestamptz,
  created_at     timestamptz not null default now()
);
create index verification_tasks_open_idx on verification_tasks (priority desc) where resolved_at is null;

create table reports (
  id            uuid primary key default gen_random_uuid(),
  subject_kind  text not null,
  subject_id    uuid not null,
  issue         text not null,                     -- 'wrong_hours','closed','full','wrong_price','not_here','other'
  evidence      text,
  reporter_ref  text,                              -- device id or contributor id
  status        text not null default 'open' check (status in ('open','resolved','dismissed')),
  outcome       text,
  created_at    timestamptz not null default now(),
  resolved_at   timestamptz
);

create table jobs (
  id               uuid primary key default gen_random_uuid(),
  kind             text not null,
  idempotency_key  text not null unique,
  payload          jsonb not null default '{}'::jsonb,
  status           text not null default 'queued' check (status in ('queued','running','done','failed','dead')),
  attempts         integer not null default 0,
  run_after        timestamptz not null default now(),
  last_error       text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index jobs_ready_idx on jobs (run_after) where status = 'queued';

create table audit_log (
  id          bigserial primary key,
  actor       text not null,
  action      text not null,
  target_kind text not null,
  target_id   text,
  before      jsonb,
  after       jsonb,
  at          timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

create or replace function touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

create trigger venues_touch before update on venues for each row execute function touch_updated_at();
create trigger occurrences_touch before update on occurrences for each row execute function touch_updated_at();
create trigger jobs_touch before update on jobs for each row execute function touch_updated_at();

comment on table facts is 'Append-only evidence. Never update value in place; insert a new row and set superseded_at on the old one.';
comment on table current_facts is 'Rebuildable. Dropping and re-materializing must always be safe.';
comment on column source_entities.retention_until is 'Set from source_policies.retention_days for restricted sources; expiry job deletes raw and dependent derived rows.';
