-- Founder-entered facts: hours called in, venues OSM lacks. OutRN-owned; published class with the
-- founder's evidence ("called 9/26"). Trust 0.85 in materialization: above OSM, below the venue's own site.
insert into source_policies (id, name, product, license, terms_url, reviewed_at, allowed_ops, retention_days, attribution, geography, rate_limit, enabled, open_conditions, notes) values
  ('founder', 'Founder verification', 'outrn facts set / venues add', 'OutRN-owned',
   null, '2026-09-27',
   '{retain,derive,display}', null, null, 'service areas', '{}', true, '{}',
   'Facts the founder checked directly (phone call, visit, venue reply). Every row carries evidence text and the date it was checked.');
