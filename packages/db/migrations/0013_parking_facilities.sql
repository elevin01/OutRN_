-- Parking near venues: public lots, garages and street bays from OSM (amenity=parking), kept in the
-- raw store as their own kind and derived at ingest into parking_facilities. Only places anyone may
-- park (no private, customer-only or permit lots) are derived. A drive plan names the nearest one
-- within a short walk and counts the walk from it.

alter table source_entities drop constraint if exists source_entities_kind_check;
alter table source_entities add constraint source_entities_kind_check
  check (kind in ('venue', 'occurrence', 'area_snapshot', 'parking'));

create table if not exists parking_facilities (
  source_entity_id  uuid primary key references source_entities(id) on delete cascade,
  geom              geography(point, 4326) not null,
  name              text,
  kind              text not null check (kind in ('lot', 'garage', 'street')),
  fee               text not null check (fee in ('free', 'paid', 'unknown')),
  capacity          integer check (capacity is null or capacity > 0),
  opening_hours     text,
  source_updated_at timestamptz,
  derived_at        timestamptz not null default now()
);
create index if not exists parking_facilities_geom_gix on parking_facilities using gist (geom);

-- Server-side only, like the raw store it is derived from.
alter table parking_facilities enable row level security;

-- Each venue's nearest public parking within a short walk, nearest first (rank 0), worked out at
-- ingest: a nearest-neighbour search per venue is too slow for the request path at area scale. A few
-- are kept so a plan can pass over one that is closed for the visit. Recomputed for every venue near
-- a snapshot's extent on each ingest.
create table if not exists venue_parking (
  venue_id          uuid not null references venues(id) on delete cascade,
  rank              smallint not null check (rank >= 0),
  source_entity_id  uuid not null references parking_facilities(source_entity_id) on delete cascade,
  distance_m        real not null check (distance_m >= 0),
  primary key (venue_id, rank)
);
create index if not exists venue_parking_source_idx on venue_parking (source_entity_id);

alter table venue_parking enable row level security;
