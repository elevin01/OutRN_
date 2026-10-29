-- Which films people are going to now, from TMDB (`outrn ingest films`): the films now playing in US
-- cinemas and trending this week, with TMDB's popularity. The twenty most popular are matched by title
-- to the screenings we list, as a `popularity` fact the engine reads as "popular right now". Needs a
-- key in the environment (TMDB_API_KEY: a v3 API key or a v4 read access token), never stored.
-- Numbered 0029: 0028 is the ticketing sources.
--
-- Registered DISABLED until TMDB's terms are read for OutRN's use (its API is free for non-commercial
-- use; commercial use needs an agreement with TMDB; it asks for attribution). Whoever reads them enables it:
--   update source_policies set enabled = true, reviewed_at = '<date read>', open_conditions = '{}' where id = 'tmdb';
--
-- Safe to re-apply: a re-apply keeps the switch, the review and its conditions as they were set.

insert into source_policies (id, name, product, license, terms_url, reviewed_at, allowed_ops, retention_days, attribution, geography, rate_limit, enabled, open_conditions, notes) values
  ('tmdb', 'TMDB', 'TMDB API v3: movie/now_playing (US), trending/movie/week', 'TMDB API terms of use (not yet reviewed)',
   'https://www.themoviedb.org/api-terms-of-use', null,
   '{fetch,retain,derive,display}', 2,
   'Film popularity: TMDB (This product uses the TMDB API but is not endorsed or certified by TMDB)', 'US',
   '{"min_interval_ms": 250, "max_concurrent": 1}', false,
   '{"Read the TMDB API terms of use (https://www.themoviedb.org/api-terms-of-use) for OutRN''s use: commercial use needs an agreement with TMDB, and the attribution it asks for must be shown where its data is","Record the review before enabling"}',
   'Seven pages a read (five of now playing, two of trending), every few hours. Kept: each film''s id, title, original title, popularity and release date; a screening''s popularity fact holds the film''s rank and lasts 36 hours unless refreshed.')
on conflict (id) do update set
  name = excluded.name, product = excluded.product, terms_url = excluded.terms_url, attribution = excluded.attribution,
  rate_limit = excluded.rate_limit, notes = excluded.notes, updated_at = now();
