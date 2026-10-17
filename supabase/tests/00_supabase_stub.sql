-- Local stand-in for Supabase so the migration can be tested on plain Postgres.
-- Mirrors the parts that matter for security: the anon/authenticated/service_role
-- roles, auth.uid() from the JWT claim, default grants on public tables (so RLS is
-- the only thing protecting data, exactly as on Supabase), and Rekol's existing
-- tables with RLS approximating what is live today.

create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
grant usage on schema public to anon, authenticated, service_role;

create schema auth;
grant usage on schema auth to anon, authenticated, service_role;
create table auth.users (id uuid primary key, email text unique);

create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
grant execute on function auth.uid() to anon, authenticated, service_role;

-- Supabase grants everything on new public tables to the API roles by default
alter default privileges in schema public grant all on tables    to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;

-- ---- existing Rekol tables (approximation of production) ----

create table public.profiles (
  id uuid primary key references auth.users(id),
  email text, name text, eval_count int default 0, is_pro boolean default false,
  custom_framework jsonb, created_at timestamptz default now(),
  digest_enabled boolean default false, last_digest_sent timestamptz
);
alter table public.profiles enable row level security;
create policy profiles_own on public.profiles for all to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

create table public.evaluations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id),
  created_at timestamptz default now(),
  framework text, deal_name text, overall_score int,
  summary text, next_steps jsonb, sections jsonb
);
alter table public.evaluations enable row level security;
create policy evals_own on public.evaluations for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create table public.shared_evals (
  id uuid primary key default gen_random_uuid(),
  eval_json jsonb, team_code text, ae_name text, created_at timestamptz default now()
);
alter table public.shared_evals enable row level security;
create policy shares_public_read on public.shared_evals for select to anon, authenticated using (true);
create policy shares_auth_insert on public.shared_evals for insert to authenticated with check (true);

create table public.teams (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid references auth.users(id),
  name text, created_at timestamptz default now()
);
alter table public.teams enable row level security;
create policy teams_owner_all on public.teams for all to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create table public.team_members (
  id uuid primary key default gen_random_uuid(),
  team_id uuid references public.teams(id),
  user_id uuid references auth.users(id),
  invited_email text, status text default 'invited',
  joined_at timestamptz, created_at timestamptz default now()
);
alter table public.team_members enable row level security;
create policy tm_owner_all on public.team_members for all to authenticated
  using (exists (select 1 from public.teams t where t.id = team_id and t.owner_id = auth.uid()))
  with check (exists (select 1 from public.teams t where t.id = team_id and t.owner_id = auth.uid()));
create policy tm_self_read on public.team_members for select to authenticated
  using (user_id = auth.uid());
create policy tm_self_update on public.team_members for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
