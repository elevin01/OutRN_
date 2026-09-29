-- The latest hourly forecast for each area, from the National Weather Service (api.weather.gov:
-- free, no key; policy row 'nws' in 0002). A job refreshes it (`outrn weather refresh`); requests
-- only read it, and ignore one that is stale or does not cover the plan's start.
create table if not exists weather_forecasts (
  area_id           uuid primary key references service_areas(id) on delete cascade,
  source_id         text not null references source_policies(id),
  -- When the forecast was issued (NWS updateTime), else when it was fetched: its age is judged by this.
  issued_at         timestamptz not null,
  fetched_at        timestamptz not null,
  hours             jsonb not null check (jsonb_typeof(hours) = 'array'),
  ingestion_run_id  uuid references ingestion_runs(id) on delete set null
);

-- Server-side only, like every other table (0005): no policy, so no anonymous access.
alter table weather_forecasts enable row level security;
