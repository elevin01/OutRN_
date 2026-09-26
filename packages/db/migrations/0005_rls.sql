-- Row-level security for Supabase. Anonymous consumers read published venues, occurrences and
-- current facts only. Everything else is server-side (service role) or role-gated.
-- Safe on a local cluster without Supabase roles: policies are created only when the roles exist.

alter table venues              enable row level security;
alter table occurrences         enable row level security;
alter table current_facts       enable row level security;
alter table facts               enable row level security;
alter table source_entities     enable row level security;
alter table entity_links        enable row level security;
alter table venue_overrides     enable row level security;
alter table recommendation_runs enable row level security;
alter table interaction_events  enable row level security;
alter table trip_intents        enable row level security;
alter table observations        enable row level security;
alter table verification_tasks  enable row level security;
alter table reports             enable row level security;
alter table contributors        enable row level security;
alter table contributor_reliability enable row level security;
alter table source_policies     enable row level security;
alter table ingestion_runs      enable row level security;
alter table firstparty_sites    enable row level security;
alter table jobs                enable row level security;
alter table audit_log           enable row level security;
alter table category_policies   enable row level security;
alter table context_rules       enable row level security;
alter table service_areas       enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    create policy anon_read_eligible_venues on venues for select to anon using (publish_state = 'eligible');
    create policy anon_read_occurrences on occurrences for select to anon
      using (status <> 'ended' and exists (select 1 from venues v where v.id = occurrences.venue_id and v.publish_state = 'eligible'));
    create policy anon_read_current_facts on current_facts for select to anon
      using (subject_kind = 'venue' and exists (select 1 from venues v where v.id = current_facts.subject_id and v.publish_state = 'eligible')
             or subject_kind = 'occurrence');
    create policy anon_read_areas on service_areas for select to anon using (launch_state in ('private_beta','live'));
    create policy anon_read_category_policies on category_policies for select to anon using (true);
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    -- Contributors see and write only their own records; editors/admins go through the server.
    create policy own_contributor on contributors for select to authenticated using (auth_user_id = auth.uid());
    create policy own_observations on observations for select to authenticated
      using (contributor_id in (select id from contributors where auth_user_id = auth.uid()));
    create policy insert_own_observations on observations for insert to authenticated
      with check (contributor_id in (select id from contributors where auth_user_id = auth.uid()));
    create policy read_open_tasks on verification_tasks for select to authenticated using (resolved_at is null);
  end if;
end $$;

comment on table venues is 'RLS: anon reads eligible only. Service role (server) bypasses RLS for the API and workers.';
