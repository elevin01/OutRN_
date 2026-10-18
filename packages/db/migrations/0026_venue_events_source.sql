-- What venues' own websites list as their events (theatres, music rooms, arts centers): read with
-- their pages by the firstparty job (`outrn firstparty run`), through its gate (robots.txt per
-- request, a host's requests paced and capped a day), from where the home page says the site lists
-- them: The Events Calendar's REST API, an iCalendar feed it links, or a page of its own for events
-- (its JSON-LD). Numbered 0026: 0025 is library and town calendars.
--
-- Its own source, below a founder's check in trust: nobody checked such a site is the venue's (most
-- are found from a listed website). Written as calendars' events are (placement, kinds, who it is
-- for, the minors rules), and never withdrawn for missing from a read: a page lists some of a
-- venue's events, not all, so an event leaves when it is over or the site marks it cancelled.
--
-- Safe to re-apply (migrate --reapply 0026_venue_events_source.sql): a re-apply keeps the switch,
-- the review and its conditions as they were set.

insert into source_policies (id, name, product, license, terms_url, reviewed_at, allowed_ops, retention_days, attribution, geography, rate_limit, enabled, open_conditions, notes) values
  ('venue_events', 'Venues'' own event listings', 'Event listings on venues'' own websites: The Events Calendar REST API, iCalendar, schema.org Event JSON-LD',
   'Each site''s terms; robots.txt obeyed', null, '2026-10-18',
   '{fetch,retain,derive,display}', null,
   'Events: each venue''s own website (linked on the event)', 'venues'' own websites (registered by hand, or found from a listed website)',
   '{"min_interval_ms": 5000, "max_concurrent": 8, "per_host_per_day": 4}', true,
   '{"Read only with the venue''s own pages, through the firstparty gate: robots.txt per request, at least 5 s between a host''s requests, four a day per host","Kept: title, times, place, the event''s own link, kinds from its schema.org types or categories, for children, registration and price only as stated; not descriptions or images","At most 100 events a page and 12 pages a feed; an event is placed at the venue unless it names another place nearby"}',
   'Feeds are found on venues'' own home pages (eventsFeedOf). Events are written like calendars'' (calendarEventInput), never withdrawn for missing from a read.')
on conflict (id) do update set
  name = excluded.name, product = excluded.product, attribution = excluded.attribution, geography = excluded.geography,
  rate_limit = excluded.rate_limit, notes = excluded.notes, updated_at = now();
