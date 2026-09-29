-- Overture Maps places now also add the places OSM lacks, as venues of their own (`outrn ingest
-- overture`; the rules are in packages/ingest/src/overture.ts): open, a confident record not from a
-- company register alone, a kind we map (not fast food), a real name, not a chain, and nothing nearby
-- it could be. Such a venue has Overture as its only source, has no hours (so it is always Check
-- first), and loses its claims when a later read no longer supports it. `--no-new-places` turns it off.

update source_policies
   set notes = 'Status (open, or permanently closed by Overture''s own operating-status signal), website and phone, for venues matched by name and category within 120 m; closures from company registers alone are ignored. Also the places OSM lacks, as venues of their own, under strict rules (open, confidence 0.8+, not a company register alone, a mapped kind other than fast food, a real name, not a chain, nothing nearby it could be).',
       updated_at = now()
 where id = 'overture';
