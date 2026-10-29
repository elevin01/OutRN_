-- Ticketed events from Ticketmaster's Discovery API and SeatGeek's API (`outrn ingest ticketmaster|seatgeek`):
-- concerts, comedy, theatre and sports at the venues that sell through them, the next two weeks around
-- each area. Each needs a free key from its developer site in the environment (TICKETMASTER_API_KEY,
-- SEATGEEK_CLIENT_ID), sent only to its own API and never stored. Numbered 0028: 0027 switched on NYC Parks.
--
-- Both are registered DISABLED until their terms are read for OutRN's use. Whoever reads them enables
-- one, recording the review:
--   update source_policies set enabled = true, reviewed_at = '<date read>', open_conditions = '{}' where id = 'ticketmaster';
--   update source_policies set enabled = true, reviewed_at = '<date read>', open_conditions = '{}' where id = 'seatgeek';
--
-- Kept: title, start, venue (ours when we know it), kinds from the API's classification, a price range,
-- an adults-only flag, the event's own page; SeatGeek's popularity score. Not descriptions or images.
-- A read of every page is the area's whole listing: what the API no longer lists is withdrawn on the
-- next read (refreshed every few hours by `outrn refresh`).
--
-- Safe to re-apply: a re-apply keeps each switch, review and its conditions as they were set.

update source_policies
   set allowed_ops = '{fetch,retain,derive,display}',
       attribution = 'Events: Ticketmaster (linked on the event)',
       rate_limit = '{"per_day": 5000, "per_second": 5}',
       notes = 'Discovery API v2 events within each area''s reach, 14 days ahead, up to 1,000 a read (its cap). Placed at the venue we know by name or address within 200 m, else at an event site. Withdrawn when a full read no longer lists them.',
       updated_at = now()
 where id = 'ticketmaster';

update source_policies
   set open_conditions = '{"Read the Ticketmaster Developer terms of use (https://developer.ticketmaster.com/support/terms-of-use/) for OutRN''s use (display, retention, attribution, linking to the event page) and record the review before enabling"}'
 where id = 'ticketmaster' and not enabled;

insert into source_policies (id, name, product, license, terms_url, reviewed_at, allowed_ops, retention_days, attribution, geography, rate_limit, enabled, open_conditions, notes) values
  ('seatgeek', 'SeatGeek', 'SeatGeek Platform API: events', 'SeatGeek API terms of use (not yet reviewed)',
   'https://seatgeek.com/api-terms', null,
   '{fetch,retain,derive,display}', 1,
   'Events: SeatGeek (linked on the event)', 'US',
   '{"min_interval_ms": 500, "max_concurrent": 1}', false,
   '{"Read the SeatGeek API terms of use (https://seatgeek.com/api-terms) for OutRN''s use (display, retention, attribution, linking to the event page) and record the review before enabling"}',
   'Events within each area''s reach, 14 days ahead, up to 1,000 a read. Placed at the venue we know by name or address within 200 m, else at an event site; one Ticketmaster already lists at the venue within 30 minutes is left out. Its score (0 to 1) is kept as how popular the event is.')
on conflict (id) do update set
  name = excluded.name, product = excluded.product, terms_url = excluded.terms_url, attribution = excluded.attribution,
  rate_limit = excluded.rate_limit, notes = excluded.notes, updated_at = now();
