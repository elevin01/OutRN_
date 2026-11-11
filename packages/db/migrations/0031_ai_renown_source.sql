-- Renown: which places Claude recognises by name as worth going to (`outrn ai renown`). Numbered
-- 0031: 0030 is Claude reading venues' pages.
--
-- The engine knew a place was known only from an encyclopedia entry on its map record, which a few
-- dozen places have. Asked the same question, a model names Russ & Daughters, Scarr's Pizza and the
-- Bronx Zoo from memory. This job asks it, once per place: Claude is given the names, kinds and
-- streets of an area's venues, a hundred at a time, and says which it recognises as notable or as a
-- destination, with a few words on what each is known for. Nothing is fetched from anywhere.
--
-- What it is: an estimate, and only that (evidence class estimate, confidence 0.5). A model's memory
-- is not a source: it never says a place is open, exists or is good, and it is never asked about one
-- we do not already hold from a real source. It only lifts: a place it does not recognise, or finds
-- ordinary, gets no fact at all, so nothing here is a low mark against a business. Ranking only
-- (engine draw.ts); the note is kept for audit (`outrn facts show`) and is not shown on a card.
-- Chains are not asked about.
--
-- Spending: the same cap as every other use of Claude (OUTRN_AI_DAILY_BUDGET_USD over any 24 hours,
-- counted into ingestion_runs.cost_cents). A place is asked about again after 180 days.
--
-- Switched on (the founder asked for it, 11 November 2026). enabled = false (or kill_switch = true)
-- stops it; the facts it wrote stop counting when they are retracted (`outrn ai renown --clear`).

insert into source_policies (id, name, product, license, terms_url, reviewed_at, allowed_ops, retention_days, attribution, geography, rate_limit, enabled, open_conditions, notes) values
  ('ai_renown', 'Places Claude recognises by name', 'Claude (Anthropic Messages API) over venue names, kinds and streets we already hold; nothing fetched',
   'Anthropic API terms; output is OutRN''s own estimate', null, '2026-11-11',
   '{derive,retain}', null,
   '', 'served areas',
   '{}', true,
   '{}',
   'Kept: a level (notable or destination) and a few words on what the place is known for, as an estimate. Never a low rating, never shown as a claim, never about a chain.')
on conflict (id) do update set
  name = excluded.name, product = excluded.product, notes = excluded.notes, updated_at = now();

-- When each venue was last asked about, and what came of it ('none', 'notable', 'destination'): a
-- venue is asked about at most once in 180 days, whatever the answer.
create table if not exists ai_renown_asks (
  venue_id  uuid not null references venues(id) on delete cascade,
  asked_at  timestamptz not null default now(),
  level     text not null,
  model     text
);
create index if not exists ai_renown_asks_venue_idx on ai_renown_asks (venue_id, asked_at desc);

-- Server-side only, like every other table (0005): no policy, so no anonymous access.
alter table ai_renown_asks enable row level security;
