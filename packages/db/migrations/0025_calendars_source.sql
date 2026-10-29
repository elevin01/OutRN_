-- Libraries', towns' and nature centers' own event calendars (`outrn ingest calendars`): LibCal and
-- other iCalendar feeds, WordPress's The Events Calendar, and CivicPlus town calendars, from a
-- reviewed list of feeds around the launch areas. Numbered 0025: 0024 is venues' own websites.
--
-- Enabled with the venues' own websites (founder decision, 2026-10-18): each publisher's own
-- calendar, read as its robots.txt allows our agent, politely, and keeping only what an event is
-- (title, times, place, link, kinds, who it's for, registration, price as stated), never its page.
--
-- Safe to re-apply (migrate --reapply 0025_calendars_source.sql): a re-apply keeps the switch, the
-- review and its conditions as they were set.

insert into source_policies (id, name, product, license, terms_url, reviewed_at, allowed_ops, retention_days, attribution, geography, rate_limit, enabled, open_conditions, notes) values
  ('calendars', 'Library and town calendars', 'Public event calendars: iCalendar (LibCal, WordPress Events Manager), The Events Calendar REST API, CivicPlus calendar RSS',
   'Each publisher''s site terms; robots.txt obeyed', null, '2026-10-18',
   '{fetch,retain,derive,display}', null,
   'Events: each library''s, town''s or park''s own calendar (linked on the event)', 'Southern Westchester and Greenwich',
   '{"min_interval_ms": 10000, "max_concurrent": 4}', true,
   '{"robots.txt obeyed for our agent (RFC 9309): a feed we may not read, or whose robots.txt we cannot reach, is not read","A host''s requests at least 10 s apart (longer when its robots.txt asks; CivicPlus towns share one pace), four feeds at a time, at most 12 pages of a paged feed per run","Kept: title, times, place, the event''s own link, kinds from its categories, for children, registration and price only as stated; not descriptions or images"}',
   'Feeds are a reviewed list (packages/ingest/src/calendars.ts) from a survey of 104 calendars around the launch areas on 18 Oct 2026; calendars that keep crawlers out (LibraryMarket, Google Calendar files, NYPL) are not in it. A library''s or nature center''s events go to its venue; a town''s are matched to a venue by the place they name, or left out. Meetings, closings, services and online events are left out. An event a complete read no longer lists is withdrawn.')
on conflict (id) do update set
  name = excluded.name, product = excluded.product, attribution = excluded.attribution, geography = excluded.geography,
  rate_limit = excluded.rate_limit, notes = excluded.notes, updated_at = now();
