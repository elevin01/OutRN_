-- Paging snapshots for the public API (owned by @outrn/api).
--
-- A search computes its whole ordered result list once and freezes it here. Every page of that
-- search is a slice of this list, so "More options" never reshuffles, repeats or skips an option,
-- and never re-runs the engine. Pinning the clock alone could not guarantee that: facts, overrides
-- and occurrences change underneath. The list expires with the plans' times (the API's TTL);
-- after that a cursor answers CURSOR_EXPIRED with the search to run again.

create table recommendation_snapshots (
  run_id        uuid primary key references recommendation_runs(id) on delete cascade,
  -- The request as received (validated), for restarting an expired search.
  request       jsonb not null,
  -- The request with defaults applied (contract ResolvedRequest).
  resolved      jsonb not null,
  area          jsonb not null,
  -- Contract RecommendationItem[], in display order.
  items         jsonb not null,
  insufficient  jsonb,
  attributions  jsonb not null default '[]'::jsonb,
  as_of         timestamptz not null,
  generated_at  timestamptz not null,
  expires_at    timestamptz not null
);

create index recommendation_snapshots_expires_at on recommendation_snapshots (expires_at);

alter table recommendation_snapshots enable row level security;
