-- NYC Parks events switched on (0021 registered the source disabled until its terms were read).
--
-- The founder read NYC Open Data's terms of use (https://opendata.cityofnewyork.us/overview/#termsofuse)
-- for this source on 29 October 2026, the date recorded below: the next two weeks of NYC Parks' public
-- events may be fetched, kept and shown, with the source credited ("Events: NYC Parks (NYC Open Data)").
-- To switch it off again, set enabled = false (or kill_switch = true); this file never runs twice.

update source_policies
   set enabled = true,
       reviewed_at = '2026-10-29',
       license = 'NYC Open Data terms of use',
       open_conditions = '{}',
       updated_at = now()
 where id = 'nyc_parks';
