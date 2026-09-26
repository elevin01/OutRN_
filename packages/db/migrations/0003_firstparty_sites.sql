-- Registry of first-party venue pages we are allowed to fetch. Bounded and reviewed:
-- a site enters this table with a reason, not because a `website` tag exists.

create table firstparty_sites (
  id               uuid primary key default gen_random_uuid(),
  venue_id         uuid not null references venues(id),
  url              text not null,
  reason           text not null,                  -- why this page: 'hours page', 'events calendar', 'venue homepage'
  enabled          boolean not null default true,
  fetch_interval_h integer not null default 168,   -- weekly by default; hours pages rarely change
  last_fetched_at  timestamptz,
  last_status      text,                           -- 'ok', 'no_jsonld', 'blocked', 'error:...'
  last_types       text[],
  created_at       timestamptz not null default now(),
  unique (venue_id, url)
);
create index firstparty_sites_due_idx on firstparty_sites (last_fetched_at) where enabled;
