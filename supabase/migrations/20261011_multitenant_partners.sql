-- =====================================================================
-- Rekol migration: multi-tenant organisations, roles, company layers,
-- usage metering, white-label branding, retention and offboarding.
--
-- File:    migrations/20261011_multitenant_partners.sql
-- Target:  Supabase project iqdnmlzamqqskfjysfzg (public schema)
-- Author:  prepared for Andrew Lennon / Itua.io
--
-- WHAT THIS ADDS
--   organisations      a coach/consultancy (partner) or a direct company
--   org_members        people who can see every team in an organisation (coach view)
--   company_layers     DB-backed methodology layers (replaces hard-coded allowlists)
--   usage_events       per-call token + eval metering, drives fair-use caps
--   offboarding_log    proof-of-deletion record (no personal data)
--   teams.*            org_id, company_layer_id, monthly_eval_cap, status
--   team_members.role  'ae' | 'manager'  (default 'ae', existing rows backfilled)
--   evaluations.*      team_id, deal_key, company_layer_id/version,
--                      coaching_focus, section_status, crm_summary
--   shared_evals.team_id  so shares can be deleted on offboarding
--   organisations.allow_public_shares  lets a client switch off public share links
--
-- SAFETY PROPERTIES (all covered by tests/rls_isolation_test.sql)
--   * Purely additive. No existing column, row or policy is dropped.
--   * Existing personal use and legacy (org-less) teams behave exactly as before.
--   * A plain AE can never see a teammate's evaluations.
--   * A manager sees only their own team. A coach sees only their own org's teams.
--   * Company layer definitions (a coach's IP) are never readable by AEs or
--     client managers; evaluate.js reads them with the service role.
--   * Clients cannot change roles, caps, plans, org links or layers; only the
--     service role (Netlify functions) or the SQL editor can.
--   * Offboarding / purge / export functions are service-role only.
--
-- HOW TO APPLY
--   Run the whole file once in the Supabase SQL editor (it is wrapped in a
--   transaction, so it either fully applies or does nothing). Then run the
--   advisor check (Database > Advisors) and confirm no new RLS warnings.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. New tables
-- ---------------------------------------------------------------------

create table if not exists public.organisations (
  id                    uuid primary key default gen_random_uuid(),
  name                  text not null,
  kind                  text not null default 'company'
                          check (kind in ('coach', 'company', 'internal')),
  owner_id              uuid not null references auth.users(id) on delete restrict,
  -- white-label branding (all optional; null = Rekol default look)
  brand_name            text,
  brand_logo_url        text,
  brand_accent          text check (brand_accent is null or brand_accent ~ '^#[0-9a-fA-F]{6}$'),
  powered_by_rekol      boolean not null default true,
  -- when false, share.js must refuse to create public share links for this org's teams
  allow_public_shares   boolean not null default true,
  -- commercial
  plan                  text not null default 'pilot'
                          check (plan in ('pilot', 'team', 'partner_single', 'partner_multi', 'internal')),
  max_teams             int  not null default 1 check (max_teams >= 0),
  -- data protection
  data_retention_days   int  not null default 365 check (data_retention_days between 30 and 3650),
  status                text not null default 'active'
                          check (status in ('active', 'suspended', 'offboarding')),
  offboard_requested_at timestamptz,
  created_at            timestamptz not null default now()
);

create table if not exists public.org_members (
  org_id     uuid not null references public.organisations(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  role       text not null default 'coach' check (role in ('owner', 'admin', 'coach')),
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);

create table if not exists public.company_layers (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organisations(id) on delete cascade,
  name        text not null,
  backbone    text not null check (backbone in ('MEDDIC', 'BANT', 'SPIN', 'CUSTOM')),
  -- {"context": "...", "sections": [{"name": "...", "what_good_looks_like": "...",
  --   "evidence_rules": "...", "coaching_language": "..."}]}
  definition  jsonb not null,
  version     int  not null default 1 check (version >= 1),
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (org_id, name, version)
);

create table if not exists public.usage_events (
  id                 bigint generated always as identity primary key,
  created_at         timestamptz not null default now(),
  user_id            uuid references auth.users(id) on delete set null,
  team_id            uuid references public.teams(id) on delete cascade,
  org_id             uuid references public.organisations(id) on delete cascade,
  -- one 'eval_quick' row per evaluation (this is what the fair-use cap counts);
  -- one 'eval_full_batch' row per full-mode batch call.
  kind               text not null default 'eval_quick'
                       check (kind in ('eval_quick', 'eval_full_batch', 'practice', 'digest', 'import')),
  model              text,
  input_tokens       int not null default 0,
  output_tokens      int not null default 0,
  cache_read_tokens  int not null default 0,
  cache_write_tokens int not null default 0,
  latency_ms         int,
  ok                 boolean not null default true
);

create index if not exists usage_events_team_month_idx on public.usage_events (team_id, kind, created_at);
create index if not exists usage_events_org_month_idx  on public.usage_events (org_id, created_at);

create table if not exists public.offboarding_log (
  id                  bigint generated always as identity primary key,
  org_id              uuid not null,
  org_name            text not null,
  teams_deleted       int  not null,
  evaluations_deleted int  not null,
  shares_deleted      int  not null,
  layers_deleted      int  not null,
  completed_at        timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 2. Additive columns on existing tables
-- ---------------------------------------------------------------------

alter table public.teams
  add column if not exists org_id           uuid references public.organisations(id) on delete cascade,
  add column if not exists company_layer_id uuid references public.company_layers(id) on delete set null,
  add column if not exists monthly_eval_cap int  not null default 150 check (monthly_eval_cap >= 0),
  add column if not exists status           text not null default 'active' check (status in ('active', 'suspended'));

create index if not exists teams_org_idx on public.teams (org_id);

-- existing rows are backfilled to 'ae' by the default
alter table public.team_members
  add column if not exists role text not null default 'ae' check (role in ('ae', 'manager'));

alter table public.evaluations
  add column if not exists team_id               uuid references public.teams(id) on delete set null,
  add column if not exists deal_key              text,   -- normalised deal name, for the deal-risk view
  add column if not exists company_layer_id      uuid references public.company_layers(id) on delete set null,
  add column if not exists company_layer_version int,
  add column if not exists coaching_focus        text,   -- the one coaching point, for follow-through tracking
  add column if not exists section_status        jsonb,  -- {"<section>": "done" | "failed"}
  add column if not exists crm_summary           jsonb;  -- copy-to-CRM field block

create index if not exists evaluations_team_created_idx on public.evaluations (team_id, created_at);
create index if not exists evaluations_team_deal_idx    on public.evaluations (team_id, deal_key);

alter table public.shared_evals
  add column if not exists team_id uuid references public.teams(id) on delete cascade;

-- ---------------------------------------------------------------------
-- 3. Helper functions (security definer so policies never recurse)
--    These only answer questions about the *calling* user.
-- ---------------------------------------------------------------------

create or replace function public.is_org_member(p_org uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from organisations o where o.id = p_org and o.owner_id = auth.uid())
      or exists (select 1 from org_members m where m.org_id = p_org and m.user_id = auth.uid());
$$;

create or replace function public.is_org_admin(p_org uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from organisations o where o.id = p_org and o.owner_id = auth.uid())
      or exists (select 1 from org_members m
                  where m.org_id = p_org and m.user_id = auth.uid() and m.role in ('owner', 'admin'));
$$;

-- active member (any role) or owner of the team
create or replace function public.is_team_member(p_team uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from teams t where t.id = p_team and t.owner_id = auth.uid())
      or exists (select 1 from team_members tm
                  where tm.team_id = p_team and tm.user_id = auth.uid() and tm.status = 'active');
$$;

-- owner of the team, or an active member with role 'manager'
create or replace function public.can_manage_team(p_team uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from teams t where t.id = p_team and t.owner_id = auth.uid())
      or exists (select 1 from team_members tm
                  where tm.team_id = p_team and tm.user_id = auth.uid()
                    and tm.status = 'active' and tm.role = 'manager');
$$;

-- can see the whole team's results: team managers, plus the coach/org that owns the team
create or replace function public.can_oversee_team(p_team uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.can_manage_team(p_team)
      or exists (select 1 from teams t
                  where t.id = p_team and t.org_id is not null and public.is_org_member(t.org_id));
$$;

-- labels (never definitions) of the layers on the caller's teams, for the UI
create or replace function public.my_team_layers()
returns table (team_id uuid, layer_id uuid, layer_name text, backbone text, version int)
language sql stable security definer set search_path = public as $$
  select t.id, cl.id, cl.name, cl.backbone, cl.version
    from teams t
    join company_layers cl on cl.id = t.company_layer_id
   where public.is_team_member(t.id) or public.can_oversee_team(t.id);
$$;

-- white-label branding for a team the caller belongs to or oversees
create or replace function public.team_branding(p_team uuid)
returns table (brand_name text, brand_logo_url text, brand_accent text, powered_by_rekol boolean)
language sql stable security definer set search_path = public as $$
  select o.brand_name, o.brand_logo_url, o.brand_accent, o.powered_by_rekol
    from teams t
    join organisations o on o.id = t.org_id
   where t.id = p_team
     and (public.is_team_member(p_team) or public.can_oversee_team(p_team));
$$;

-- fair-use counter (server side only)
create or replace function public.team_evals_this_month(p_team uuid)
returns int language sql stable security definer set search_path = public as $$
  select count(*)::int
    from usage_events
   where team_id = p_team
     and kind = 'eval_quick'
     and ok
     and created_at >= date_trunc('month', now());
$$;

-- ---------------------------------------------------------------------
-- 4. Guard triggers: clients cannot escalate privileges or change billing
--    (current_user is 'authenticated' / 'anon' for browser requests and
--     'service_role' / 'postgres' for Netlify functions and the SQL editor)
-- ---------------------------------------------------------------------

create or replace function public.guard_team_members_role()
returns trigger language plpgsql set search_path = public as $$
begin
  if current_user in ('authenticated', 'anon') then
    if tg_op = 'INSERT' and new.role <> 'ae' then
      raise exception 'only the server can create managers' using errcode = '42501';
    end if;
    if tg_op = 'UPDATE' and new.role is distinct from old.role then
      raise exception 'only the server can change roles' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists trg_guard_team_members_role on public.team_members;
create trigger trg_guard_team_members_role
  before insert or update on public.team_members
  for each row execute function public.guard_team_members_role();

create or replace function public.guard_teams_admin_fields()
returns trigger language plpgsql set search_path = public as $$
begin
  if current_user in ('authenticated', 'anon') then
    if tg_op = 'INSERT' and (new.org_id is not null or new.company_layer_id is not null
                             or new.monthly_eval_cap <> 150 or new.status <> 'active') then
      raise exception 'org, layer, cap and status are set by the server' using errcode = '42501';
    end if;
    if tg_op = 'UPDATE' and (new.org_id           is distinct from old.org_id
                          or new.company_layer_id is distinct from old.company_layer_id
                          or new.monthly_eval_cap is distinct from old.monthly_eval_cap
                          or new.status           is distinct from old.status
                          or new.owner_id         is distinct from old.owner_id) then
      raise exception 'org, layer, cap, status and owner are set by the server' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists trg_guard_teams_admin_fields on public.teams;
create trigger trg_guard_teams_admin_fields
  before insert or update on public.teams
  for each row execute function public.guard_teams_admin_fields();

-- a team may only use a layer that belongs to its own organisation (applies to everyone)
create or replace function public.check_team_layer_org()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.company_layer_id is not null then
    if new.org_id is null or not exists (
         select 1 from company_layers cl
          where cl.id = new.company_layer_id and cl.org_id = new.org_id) then
      raise exception 'company layer must belong to the team''s organisation';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists trg_check_team_layer_org on public.teams;
create trigger trg_check_team_layer_org
  before insert or update of company_layer_id, org_id on public.teams
  for each row execute function public.check_team_layer_org();

-- enforce max_teams per organisation (applies to everyone)
create or replace function public.check_org_team_limit()
returns trigger language plpgsql set search_path = public as $$
declare v_max int; v_count int;
begin
  if new.org_id is not null and (tg_op = 'INSERT' or new.org_id is distinct from old.org_id) then
    select max_teams into v_max from organisations where id = new.org_id;
    select count(*) into v_count from teams where org_id = new.org_id;
    if v_count >= v_max then
      raise exception 'organisation team limit reached (%)', v_max;
    end if;
  end if;
  return new;
end $$;

drop trigger if exists trg_check_org_team_limit on public.teams;
create trigger trg_check_org_team_limit
  before insert or update of org_id on public.teams
  for each row execute function public.check_org_team_limit();

create or replace function public.touch_company_layer()
returns trigger language plpgsql set search_path = public as $$
begin new.updated_at := now(); return new; end $$;

drop trigger if exists trg_touch_company_layer on public.company_layers;
create trigger trg_touch_company_layer
  before update on public.company_layers
  for each row execute function public.touch_company_layer();

-- ---------------------------------------------------------------------
-- 5. Row-level security
-- ---------------------------------------------------------------------

alter table public.organisations   enable row level security;
alter table public.org_members     enable row level security;
alter table public.company_layers  enable row level security;
alter table public.usage_events    enable row level security;
alter table public.offboarding_log enable row level security;  -- no policies: service role only

-- organisations: members can read; nobody writes from the browser
drop policy if exists org_select_members on public.organisations;
create policy org_select_members on public.organisations
  for select to authenticated using (public.is_org_member(id));

-- org_members: members can see who else is in their org
drop policy if exists orgmem_select_members on public.org_members;
create policy orgmem_select_members on public.org_members
  for select to authenticated using (public.is_org_member(org_id));

-- company_layers: only the org (the coach) can read its own definitions
drop policy if exists layer_select_org on public.company_layers;
create policy layer_select_org on public.company_layers
  for select to authenticated using (public.is_org_member(org_id));

-- usage_events: org members and team managers can read; only the server writes
drop policy if exists usage_select_overseers on public.usage_events;
create policy usage_select_overseers on public.usage_events
  for select to authenticated using (
    (org_id  is not null and public.is_org_member(org_id))
 or (team_id is not null and public.can_oversee_team(team_id))
  );

-- teams: add read access for team members, managers and the owning org
-- (existing owner/member policies are left untouched; permissive policies OR together)
drop policy if exists teams_select_members_v2 on public.teams;
create policy teams_select_members_v2 on public.teams
  for select to authenticated using (public.is_team_member(id) or public.can_oversee_team(id));

-- team_members: managers and the owning org can see the roster
drop policy if exists tm_select_overseers on public.team_members;
create policy tm_select_overseers on public.team_members
  for select to authenticated using (user_id = auth.uid() or public.can_oversee_team(team_id));

-- evaluations: managers and the owning org can read TEAM evaluations
-- (personal evaluations with team_id null stay visible to their author only)
drop policy if exists evals_select_overseers on public.evaluations;
create policy evals_select_overseers on public.evaluations
  for select to authenticated using (team_id is not null and public.can_oversee_team(team_id));

-- evaluations: you can only file an evaluation into a team you actually belong to
drop policy if exists evals_team_membership_insert on public.evaluations;
create policy evals_team_membership_insert on public.evaluations
  as restrictive for insert to authenticated
  with check (team_id is null or public.is_team_member(team_id));

drop policy if exists evals_team_membership_update on public.evaluations;
create policy evals_team_membership_update on public.evaluations
  as restrictive for update to authenticated
  using (true)
  with check (team_id is null or public.is_team_member(team_id));

-- shared_evals: you can only tag a share with a team you belong to
drop policy if exists shares_team_membership_insert on public.shared_evals;
create policy shares_team_membership_insert on public.shared_evals
  as restrictive for insert to authenticated
  with check (team_id is null or public.is_team_member(team_id));

-- ---------------------------------------------------------------------
-- 6. Data protection: export, retention purge, offboarding
--    (service role only, never callable from the browser)
-- ---------------------------------------------------------------------

create or replace function public.export_organisation(p_org uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'organisation', (select to_jsonb(o) - 'owner_id' from organisations o where o.id = p_org),
    'exported_at',  now(),
    'teams', coalesce((
      select jsonb_agg(jsonb_build_object(
               'team', to_jsonb(t),
               'members', coalesce((select jsonb_agg(to_jsonb(tm)) from team_members tm where tm.team_id = t.id), '[]'::jsonb),
               'evaluations', coalesce((select jsonb_agg(to_jsonb(e)) from evaluations e where e.team_id = t.id), '[]'::jsonb)))
        from teams t where t.org_id = p_org), '[]'::jsonb),
    'company_layers', coalesce((select jsonb_agg(to_jsonb(cl)) from company_layers cl where cl.org_id = p_org), '[]'::jsonb)
  );
$$;

create or replace function public.purge_expired_team_evaluations()
returns int language plpgsql security definer set search_path = public as $$
declare v_count int;
begin
  delete from evaluations e
   using teams t, organisations o
   where e.team_id = t.id
     and t.org_id  = o.id
     and e.created_at < now() - make_interval(days => o.data_retention_days);
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- p_confirm must equal the organisation name exactly, as a guard against typos
create or replace function public.offboard_organisation(p_org uuid, p_confirm text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_name   text;
  v_teams  int;
  v_evals  int;
  v_shares int;
  v_layers int;
begin
  select name into v_name from organisations where id = p_org for update;
  if v_name is null then
    raise exception 'organisation % not found', p_org;
  end if;
  if p_confirm is distinct from v_name then
    raise exception 'confirmation text must equal the organisation name';
  end if;

  delete from shared_evals where team_id in (select id from teams where org_id = p_org);
  get diagnostics v_shares = row_count;

  delete from evaluations where team_id in (select id from teams where org_id = p_org);
  get diagnostics v_evals = row_count;

  delete from usage_events where org_id = p_org or team_id in (select id from teams where org_id = p_org);
  delete from team_members where team_id in (select id from teams where org_id = p_org);

  delete from teams where org_id = p_org;
  get diagnostics v_teams = row_count;

  delete from company_layers where org_id = p_org;
  get diagnostics v_layers = row_count;

  delete from org_members   where org_id = p_org;
  delete from organisations where id     = p_org;

  insert into offboarding_log (org_id, org_name, teams_deleted, evaluations_deleted, shares_deleted, layers_deleted)
  values (p_org, v_name, v_teams, v_evals, v_shares, v_layers);

  return jsonb_build_object('org', v_name, 'teams', v_teams, 'evaluations', v_evals,
                            'shares', v_shares, 'layers', v_layers);
end $$;

-- lock down the server-only functions
revoke all on function public.team_evals_this_month(uuid)        from public, anon, authenticated;
revoke all on function public.export_organisation(uuid)          from public, anon, authenticated;
revoke all on function public.purge_expired_team_evaluations()   from public, anon, authenticated;
revoke all on function public.offboard_organisation(uuid, text)  from public, anon, authenticated;
grant execute on function public.team_evals_this_month(uuid)       to service_role;
grant execute on function public.export_organisation(uuid)         to service_role;
grant execute on function public.purge_expired_team_evaluations()  to service_role;
grant execute on function public.offboard_organisation(uuid, text) to service_role;

-- the trigger functions should never be called directly
revoke all on function public.guard_team_members_role()   from public, anon, authenticated;
revoke all on function public.guard_teams_admin_fields()  from public, anon, authenticated;
revoke all on function public.check_team_layer_org()      from public, anon, authenticated;
revoke all on function public.check_org_team_limit()      from public, anon, authenticated;
revoke all on function public.touch_company_layer()       from public, anon, authenticated;

commit;
