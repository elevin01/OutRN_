-- Venues' own websites, found rather than listed by hand (founder decision, 2026-10-18): a venue no
-- source publishes hours for has its own website registered (`firstparty discover`), and the job
-- reads it as its robots.txt allows. Numbered 0024: 0023 is the OSM absence time.

-- Registered by discovery, not by hand.
alter table firstparty_sites add column if not exists auto boolean not null default false;

-- Each host's robots.txt (RFC 9309), read at most once a day; when it asked us to wait (429, 503);
-- and today's requests to it, against the policy's per-host daily limit.
create table if not exists firstparty_hosts (
  host              text primary key,
  robots_status     text not null check (robots_status in ('ok', 'none', 'unreachable')),
  robots_rules      jsonb not null default '[]'::jsonb,
  crawl_delay_s     numeric,
  robots_fetched_at timestamptz not null,
  retry_after       timestamptz,
  requests_on       date,
  requests          integer not null default 0
);

-- Server-side only, like every other table (0005): no policy, so no anonymous access.
alter table firstparty_hosts enable row level security;

update source_policies
   set geography = 'venues'' own websites (registered by hand, or found for venues without published hours)',
       reviewed_at = '2026-10-18',
       -- Hosts read side by side, each paced on its own: a site sees no more for there being others.
       rate_limit = '{"min_interval_ms": 5000, "max_concurrent": 8, "per_host_per_day": 4}',
       open_conditions = '{"Found automatically from venues'' own websites (founder decision 2026-10-18); never social, review, map, booking or ordering sites","robots.txt obeyed for our agent (RFC 9309): a site we may not read, or whose robots.txt we cannot reach, is not read","A host''s requests at least 5 s apart (longer when its robots.txt asks), at most four a day per host, eight hosts at a time; 429 and 503 back off at least six hours"}',
       notes = 'JSON-LD first; for hours, then microdata, then the page''s own words read strictly (no LLM). Facts extracted are evidence-linked; raw HTML is not retained.',
       updated_at = now()
 where id = 'firstparty';
