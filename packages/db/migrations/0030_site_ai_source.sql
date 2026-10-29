-- Events Claude reads from venues' own pages that no structured data describes (`outrn ai events`), and
-- its re-check of events about to start (`outrn ai recheck`). Numbered 0030: 0029 is TMDB.
--
-- The pages are fetched through the firstparty gate (robots.txt per request, a host's requests 5 s
-- apart and four a day, shared with the firstparty job); nothing is fetched that job may not fetch.
-- Only theatres', cinemas', music rooms', arts centers', museums' and community centers' own pages,
-- when they list no events any other way. Claude must quote the page for each event; its title, date
-- and time are checked against the page's own text before anything is written, and an event that fails
-- is left out. A re-check marks an event cancelled or sold out only on the page's own words.
--
-- Spending: OUTRN_AI_DAILY_BUDGET_USD (default 1.00) over any 24 hours, counted from each response's
-- token usage into ingestion_runs.cost_cents; a request whose most it could cost would pass the cap is
-- not sent. Needs ANTHROPIC_API_KEY; the model is OUTRN_AI_MODEL (default claude-opus-5-5).
--
-- Switched on (the founder chose Claude reading with a daily cap, 29 October 2026). enabled = false
-- (or kill_switch = true) stops it.

insert into source_policies (id, name, product, license, terms_url, reviewed_at, allowed_ops, retention_days, attribution, geography, rate_limit, enabled, open_conditions, notes) values
  ('site_ai', 'Events read by Claude from venues'' own pages', 'Claude (Anthropic Messages API) over a venue''s events page''s visible text, verified against it',
   'Each site''s terms; robots.txt obeyed (the firstparty gate)', null, '2026-10-29',
   '{fetch,retain,derive,display}', null,
   'Events: each venue''s own website (linked on the event), read by Claude', 'venues'' own websites',
   '{"min_interval_ms": 5000, "per_host_per_day": 4}', true,
   '{}',
   'Kept: title, start (and end when stated), a price only as the page states it, sold out when it says so, the page''s link, and the quote it was read from as evidence. Not descriptions or images. A page lists some of a venue''s events: nothing is withdrawn for missing from one.')
on conflict (id) do update set
  name = excluded.name, product = excluded.product, attribution = excluded.attribution, notes = excluded.notes, updated_at = now();

-- When each venue's page was last read by Claude, and what came of it: a page is read at most once in 20 hours.
create table if not exists ai_page_reads (
  site_id    uuid not null references firstparty_sites(id) on delete cascade,
  read_at    timestamptz not null default now(),
  url        text not null,
  status     text not null,
  events     integer not null default 0,
  cost_usd   numeric(10, 6) not null default 0,
  model      text
);
create index if not exists ai_page_reads_site_idx on ai_page_reads (site_id, read_at desc);

-- When each event was last re-checked before it starts, and what its page said.
create table if not exists ai_rechecks (
  occurrence_id uuid not null references occurrences(id) on delete cascade,
  checked_at    timestamptz not null default now(),
  status        text not null,
  cost_usd      numeric(10, 6) not null default 0,
  model         text
);
create index if not exists ai_rechecks_occurrence_idx on ai_rechecks (occurrence_id, checked_at desc);

-- Server-side only, like every other table (0005): no policy, so no anonymous access.
alter table ai_page_reads enable row level security;
alter table ai_rechecks enable row level security;
