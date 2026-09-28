-- Free photos of venues from Wikimedia Commons: files a venue's OSM records name (wikimedia_commons,
-- an image link to Commons) and its Wikidata item's image (P18). Only metadata is stored; the app
-- shows a resized copy from upload.wikimedia.org with the credit its license requires.

insert into source_policies (id, name, product, license, terms_url, reviewed_at, allowed_ops, retention_days, attribution, geography, rate_limit, enabled, open_conditions, notes) values
  ('wikimedia', 'Wikimedia Commons and Wikidata', 'Commons and Wikidata APIs (file metadata only)', 'Per file: public domain, CC0, CC BY, CC BY-SA; Wikidata CC0',
   'https://commons.wikimedia.org/wiki/Commons:Reusing_content_outside_Wikimedia', '2026-09-28',
   '{fetch,retain,derive,display}', null,
   'Photos: Wikimedia Commons contributors (credited with each photo)', 'global',
   '{"min_interval_ms": 1000, "max_concurrent": 1}', true,
   '{"Show each photo''s credit (author, license, link to its Commons page) wherever the photo appears","Images are shown from upload.wikimedia.org; serving copies from our own CDN needs its own review"}',
   'Venue photos only where a mapper or Wikidata ties the file to the place. Non-free, uncredited and non-photo files are skipped.')
on conflict (id) do nothing;

create table if not exists venue_photos (
  venue_id    uuid not null references venues(id) on delete cascade,
  source_id   text not null references source_policies(id),
  file_title  text not null,
  rank        smallint not null check (rank >= 0),
  url         text not null check (url like 'https://%'),
  width       integer not null check (width > 0),
  height      integer not null check (height > 0),
  author      text,
  license     text not null,
  license_url text,
  source_url  text not null check (source_url like 'https://%'),
  alt         text,
  via         text not null,
  fetched_at  timestamptz not null,
  primary key (venue_id, source_id, rank),
  unique (venue_id, source_id, file_title)
);

-- Server-side only; the API serves photos with their credits.
alter table venue_photos enable row level security;
