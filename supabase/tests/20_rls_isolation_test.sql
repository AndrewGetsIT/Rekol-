-- Isolation tests for 20261011_multitenant_partners.sql
-- Every check raises an exception on failure (psql runs with ON_ERROR_STOP),
-- and prints PASS on success.

create schema t;
grant usage on schema t to anon, authenticated, service_role;

create function t.eq(label text, actual bigint, expected bigint) returns void language plpgsql as $$
begin
  if actual is distinct from expected then
    raise exception 'FAIL: % (got %, expected %)', label, actual, expected;
  end if;
  raise notice 'PASS: %', label;
end $$;

create function t.eq_text(label text, actual text, expected text) returns void language plpgsql as $$
begin
  if actual is distinct from expected then
    raise exception 'FAIL: % (got %, expected %)', label, actual, expected;
  end if;
  raise notice 'PASS: %', label;
end $$;

create function t.fails(label text, stmt text) returns void language plpgsql as $$
declare blocked boolean := false; msg text;
begin
  begin
    execute stmt;
  exception when others then
    blocked := true; msg := sqlerrm;
  end;
  if not blocked then
    raise exception 'FAIL: % (statement was allowed: %)', label, stmt;
  end if;
  raise notice 'PASS: % [blocked: %]', label, msg;
end $$;

create function t.as_user(uid text) returns void language sql as $$
  select set_config('request.jwt.claim.sub', uid, false);
$$;

grant execute on all functions in schema t to anon, authenticated, service_role;

-- ids
\set coachA   '00000000-0000-0000-0000-0000000000a1'
\set coachA2  '00000000-0000-0000-0000-0000000000a6'
\set mgrA1    '00000000-0000-0000-0000-0000000000a2'
\set ae1      '00000000-0000-0000-0000-0000000000a3'
\set ae2      '00000000-0000-0000-0000-0000000000a4'
\set ae3      '00000000-0000-0000-0000-0000000000a5'
\set coachB   '00000000-0000-0000-0000-0000000000b1'
\set aeB      '00000000-0000-0000-0000-0000000000b2'
\set legOwner '00000000-0000-0000-0000-0000000000c1'
\set legAE    '00000000-0000-0000-0000-0000000000c2'
\set outsider '00000000-0000-0000-0000-0000000000f1'

\echo '--- coach A (org owner) ---'
reset role; select t.as_user(:'coachA'); set role authenticated;
select t.eq('coachA sees only org A teams',            (select count(*) from teams), 2);
select t.eq('coachA sees no org B team',               (select count(*) from teams where id = '30000000-0000-0000-0000-0000000000b1'), 0);
select t.eq('coachA sees all org A team evals (5)',     (select count(*) from evaluations), 5);
select t.eq('coachA cannot see ae1 personal eval',     (select count(*) from evaluations where team_id is null), 0);
select t.eq('coachA cannot see org B eval',            (select count(*) from evaluations where id = '40000000-0000-0000-0000-000000000006'), 0);
select t.eq('coachA cannot see legacy evals',          (select count(*) from evaluations where user_id = :'legAE'), 0);
select t.eq('coachA reads own layer',                  (select count(*) from company_layers), 1);
select t.eq_text('coachA layer is A',                  (select definition->>'context' from company_layers), 'SECRET A');
select t.eq('coachA sees own org row only',            (select count(*) from organisations), 1);
select t.eq('coachA sees org A usage only (3)',        (select count(*) from usage_events), 3);
select t.eq('coachA sees roster of A1 + A2 (5)',       (select count(*) from team_members), 5);
update organisations set plan = 'internal', max_teams = 99 where id = '10000000-0000-0000-0000-00000000000a';
select t.fails('coachA cannot change a team cap',      $$update teams set monthly_eval_cap = 9999 where id = '30000000-0000-0000-0000-0000000000a1'$$);
select t.fails('coachA cannot swap a team layer',      $$update teams set company_layer_id = '20000000-0000-0000-0000-00000000000b' where id = '30000000-0000-0000-0000-0000000000a1'$$);
select t.fails('coachA cannot promote via client',     $$update team_members set role = 'manager' where user_id = '00000000-0000-0000-0000-0000000000a3'$$);
select t.fails('coachA cannot run offboarding',        $$select offboard_organisation('10000000-0000-0000-0000-00000000000b', 'Coach B Ltd')$$);
select t.fails('coachA cannot run export',             $$select export_organisation('10000000-0000-0000-0000-00000000000b')$$);
select t.fails('coachA cannot run purge',              $$select purge_expired_team_evaluations()$$);
select t.fails('coachA cannot read cap counter',       $$select team_evals_this_month('30000000-0000-0000-0000-0000000000b1')$$);
update teams set name = 'Client One Sales (renamed)' where id = '30000000-0000-0000-0000-0000000000a1';
reset role;
select t.eq_text('org plan unchanged by client update', (select plan from organisations where id = '10000000-0000-0000-0000-00000000000a'), 'partner_multi');
select t.eq_text('owner can still rename own team',     (select name from teams where id = '30000000-0000-0000-0000-0000000000a1'), 'Client One Sales (renamed)');

\echo '--- coach A2 (org member, owns nothing directly) ---'
reset role; select t.as_user(:'coachA2'); set role authenticated;
select t.eq('coachA2 sees org A teams via org',        (select count(*) from teams), 2);
select t.eq('coachA2 sees org A team evals (5)',        (select count(*) from evaluations), 5);
select t.eq('coachA2 reads org A layer',               (select count(*) from company_layers), 1);
select t.eq('coachA2 my_team_layers = 1',              (select count(*) from my_team_layers()), 1);

\echo '--- client manager mgrA1 (manager role on A1 only) ---'
reset role; select t.as_user(:'mgrA1'); set role authenticated;
select t.eq('mgrA1 sees only team A1',                 (select count(*) from teams), 1);
select t.eq('mgrA1 sees A1 evals only (4)',            (select count(*) from evaluations), 4);
select t.eq('mgrA1 cannot see A2 eval',                (select count(*) from evaluations where team_id = '30000000-0000-0000-0000-0000000000a2'), 0);
select t.eq('mgrA1 cannot read coach layer (IP)',      (select count(*) from company_layers), 0);
select t.eq('mgrA1 cannot read organisation row',      (select count(*) from organisations), 0);
select t.eq('mgrA1 sees A1 usage (3)',                 (select count(*) from usage_events), 3);
select t.eq('mgrA1 sees A1 roster incl. invite (4)',   (select count(*) from team_members), 4);
select t.eq('mgrA1 gets layer label only',             (select count(*) from my_team_layers()), 1);
select t.eq_text('mgrA1 gets brand of org A',          (select brand_name from team_branding('30000000-0000-0000-0000-0000000000a1')), 'Coach A Academy');
update team_members set role = 'manager' where user_id = :'ae1';
reset role;
select t.eq_text('mgrA1 could not promote ae1',        (select role from team_members where user_id = '00000000-0000-0000-0000-0000000000a3'), 'ae');

\echo '--- AE ae1 (plain AE on A1) ---'
reset role; select t.as_user(:'ae1'); set role authenticated;
select t.eq('ae1 sees own evals only (5)',             (select count(*) from evaluations), 5);
select t.eq('ae1 cannot see teammate ae2',             (select count(*) from evaluations where user_id = :'ae2'), 0);
select t.eq('ae1 cannot read coach layer',             (select count(*) from company_layers), 0);
select t.eq('ae1 cannot read usage',                   (select count(*) from usage_events), 0);
select t.eq('ae1 sees own team row',                   (select count(*) from teams), 1);
select t.eq('ae1 sees own roster row only',            (select count(*) from team_members), 1);
select t.eq('ae1 my_team_layers = 1',                  (select count(*) from my_team_layers()), 1);
select t.eq_text('ae1 gets brand of org A',            (select brand_name from team_branding('30000000-0000-0000-0000-0000000000a1')), 'Coach A Academy');
select t.eq('ae1 gets no brand for org B team',        (select count(*) from team_branding('30000000-0000-0000-0000-0000000000b1')), 0);
select t.fails('ae1 cannot self-promote',              $$update team_members set role = 'manager' where user_id = '00000000-0000-0000-0000-0000000000a3'$$);
select t.fails('ae1 cannot file eval into org B team', $$insert into evaluations (user_id, team_id) values ('00000000-0000-0000-0000-0000000000a3', '30000000-0000-0000-0000-0000000000b1')$$);
select t.fails('ae1 cannot move eval into org B team', $$update evaluations set team_id = '30000000-0000-0000-0000-0000000000b1' where id = '40000000-0000-0000-0000-000000000001'$$);
select t.fails('ae1 cannot tag share with org B team', $$insert into shared_evals (eval_json, team_id) values ('{}', '30000000-0000-0000-0000-0000000000b1')$$);
select t.fails('ae1 cannot write usage events',        $$insert into usage_events (team_id, kind) values ('30000000-0000-0000-0000-0000000000a1', 'eval_quick')$$);
select t.fails('ae1 cannot create org-linked team',    $$insert into teams (owner_id, name, org_id) values ('00000000-0000-0000-0000-0000000000a3', 'x', '10000000-0000-0000-0000-00000000000b')$$);
insert into evaluations (user_id, team_id, deal_name) values (:'ae1', '30000000-0000-0000-0000-0000000000a1', 'New A1 deal');
select t.eq('ae1 can file eval into own team',         (select count(*) from evaluations where deal_name = 'New A1 deal'), 1);
insert into evaluations (user_id, deal_name) values (:'ae1', 'New personal deal');
select t.eq('ae1 personal evals still work',           (select count(*) from evaluations where deal_name = 'New personal deal'), 1);

\echo '--- coach B (other partner) ---'
reset role; select t.as_user(:'coachB'); set role authenticated;
select t.eq('coachB sees only team B1',                (select count(*) from teams), 1);
select t.eq('coachB sees only org B eval',             (select count(*) from evaluations), 1);
select t.eq_text('coachB reads only layer B',          (select definition->>'context' from company_layers), 'SECRET B');
select t.eq('coachB sees only org B usage',            (select count(*) from usage_events), 1);

\echo '--- legacy team (no org) behaves as before ---'
reset role; select t.as_user(:'legOwner'); set role authenticated;
select t.eq('legacy owner sees legacy team',           (select count(*) from teams), 1);
select t.eq('legacy owner sees roster',                (select count(*) from team_members), 1);
select t.eq('legacy owner sees team-tagged eval',      (select count(*) from evaluations), 1);
select t.eq('legacy owner gets no branding',           (select count(*) from team_branding('30000000-0000-0000-0000-0000000000c1')), 0);
reset role; select t.as_user(:'legAE'); set role authenticated;
select t.eq('legacy AE sees own two evals',            (select count(*) from evaluations), 2);

\echo '--- outsider and anon ---'
reset role; select t.as_user(:'outsider'); set role authenticated;
select t.eq('outsider sees no teams',                  (select count(*) from teams), 0);
select t.eq('outsider sees no evals',                  (select count(*) from evaluations), 0);
select t.eq('outsider sees no layers',                 (select count(*) from company_layers), 0);
select t.eq('outsider sees no orgs',                   (select count(*) from organisations), 0);
select t.eq('outsider sees no usage',                  (select count(*) from usage_events), 0);
select t.eq('outsider sees no roster',                 (select count(*) from team_members), 0);
reset role; select t.as_user(''); set role anon;
select t.eq('anon sees no evals',                      (select count(*) from evaluations), 0);
select t.eq('anon sees no teams',                      (select count(*) from teams), 0);
select t.eq('anon sees no layers',                     (select count(*) from company_layers), 0);
select t.eq('anon still reads public shares',          (select count(*) from shared_evals), 3);

\echo '--- server-side rules (service role / SQL editor) ---'
reset role; set role service_role;
select t.eq('cap counter: A1 has 2 evals this month',  team_evals_this_month('30000000-0000-0000-0000-0000000000a1'), 2);
select t.eq('public shares allowed by default',        (select count(*) from organisations where allow_public_shares), 2);
select t.fails('layer from another org is rejected',   $$update teams set company_layer_id = '20000000-0000-0000-0000-00000000000b' where id = '30000000-0000-0000-0000-0000000000a1'$$);
select t.fails('org B max_teams (1) is enforced',      $$insert into teams (owner_id, name, org_id) values ('00000000-0000-0000-0000-0000000000b1', 'extra', '10000000-0000-0000-0000-00000000000b')$$);
update team_members set role = 'manager' where user_id = :'ae2';
select t.eq_text('server can promote to manager',      (select role from team_members where user_id = '00000000-0000-0000-0000-0000000000a4'), 'manager');
update team_members set role = 'ae' where user_id = :'ae2';
select t.eq('export org A has 2 teams',                jsonb_array_length(export_organisation('10000000-0000-0000-0000-00000000000a')->'teams'), 2);
select t.eq('purge removes 1 expired team eval',       purge_expired_team_evaluations(), 1);
select t.eq('old personal eval is NOT purged',         (select count(*) from evaluations where id = '40000000-0000-0000-0000-000000000010'), 1);
select t.fails('offboard needs exact org name',        $$select offboard_organisation('10000000-0000-0000-0000-00000000000a', 'coach a')$$);
select offboard_organisation('10000000-0000-0000-0000-00000000000a', 'Coach A Ltd');

reset role;
select t.eq('org A gone',                              (select count(*) from organisations where id = '10000000-0000-0000-0000-00000000000a'), 0);
select t.eq('org A teams gone',                        (select count(*) from teams where id in ('30000000-0000-0000-0000-0000000000a1','30000000-0000-0000-0000-0000000000a2')), 0);
select t.eq('org A team evals gone',                   (select count(*) from evaluations where user_id in ('00000000-0000-0000-0000-0000000000a3','00000000-0000-0000-0000-0000000000a4','00000000-0000-0000-0000-0000000000a5') and deal_name not like '%ersonal%'), 0);
select t.eq('org A layer gone',                        (select count(*) from company_layers where org_id = '10000000-0000-0000-0000-00000000000a'), 0);
select t.eq('org A share gone',                        (select count(*) from shared_evals where id = '50000000-0000-0000-0000-0000000000a1'), 0);
select t.eq('org A usage gone',                        (select count(*) from usage_events where org_id = '10000000-0000-0000-0000-00000000000a'), 0);
select t.eq('org A roster gone',                       (select count(*) from team_members where invited_email in ('ae1@example.com','ae2@example.com','ae3@example.com','mgrA1@example.com','pending@example.com')), 0);
select t.eq('ae1 personal evals survive offboarding',  (select count(*) from evaluations where user_id = '00000000-0000-0000-0000-0000000000a3' and team_id is null), 3);
select t.eq('org B untouched: team',                   (select count(*) from teams where org_id = '10000000-0000-0000-0000-00000000000b'), 1);
select t.eq('org B untouched: eval',                   (select count(*) from evaluations where id = '40000000-0000-0000-0000-000000000006'), 1);
select t.eq('org B untouched: share',                  (select count(*) from shared_evals where id = '50000000-0000-0000-0000-0000000000b1'), 1);
select t.eq('untagged share untouched',                (select count(*) from shared_evals where id = '50000000-0000-0000-0000-0000000000f1'), 1);
select t.eq('legacy team untouched',                   (select count(*) from teams where id = '30000000-0000-0000-0000-0000000000c1'), 1);
select t.eq('offboarding logged (no personal data)',   (select count(*) from offboarding_log where org_name = 'Coach A Ltd'), 1);

\echo 'ALL TESTS PASSED'
