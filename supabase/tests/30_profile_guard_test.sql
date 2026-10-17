-- Tests for 20261017_protect_profile_billing.sql (runs after 20_rls_isolation_test.sql,
-- reusing its t.* helpers and the seeded auth.users).

\set ae1 '00000000-0000-0000-0000-0000000000a3'
\set ae2 '00000000-0000-0000-0000-0000000000a4'
\set aeB '00000000-0000-0000-0000-0000000000b2'

reset role;
insert into profiles (id, email, name, eval_count, is_pro)
values ('00000000-0000-0000-0000-0000000000a3', 'ae1@example.com', 'AE One', 7, false);

\echo '--- profile billing guard: browser requests ---'
reset role; select t.as_user(:'ae1'); set role authenticated;
update profiles set is_pro = true where id = :'ae1';
update profiles set eval_count = 0 where id = :'ae1';
update profiles set name = 'AE One renamed', digest_enabled = true where id = :'ae1';
select t.eq_text('user cannot make themselves Pro',     (select is_pro::text from profiles where id = '00000000-0000-0000-0000-0000000000a3'), 'false');
select t.eq('user cannot reset their eval count',      (select eval_count from profiles where id = '00000000-0000-0000-0000-0000000000a3'), 7);
select t.eq_text('user can still edit their name',     (select name from profiles where id = '00000000-0000-0000-0000-0000000000a3'), 'AE One renamed');
select t.eq_text('user can still change digest opt-in',(select digest_enabled::text from profiles where id = '00000000-0000-0000-0000-0000000000a3'), 'true');
select t.eq('user still cannot see others profiles',   (select count(*) from profiles where id <> '00000000-0000-0000-0000-0000000000a3'), 0);

reset role; select t.as_user(:'ae2'); set role authenticated;
insert into profiles (id, email, eval_count, is_pro) values (:'ae2', 'ae2@example.com', -50, true);
select t.eq_text('new profile cannot start as Pro',    (select is_pro::text from profiles where id = '00000000-0000-0000-0000-0000000000a4'), 'false');
select t.eq('new profile starts at 0 evals',           (select eval_count from profiles where id = '00000000-0000-0000-0000-0000000000a4'), 0);
select t.fails('user cannot edit another profile row', $$insert into profiles (id, email) values ('00000000-0000-0000-0000-0000000000b2', 'x')$$);

\echo '--- profile billing guard: server ---'
reset role; set role service_role;
update profiles set is_pro = true, eval_count = 8 where id = :'ae1';
select t.eq_text('server (Stripe webhook) can set Pro', (select is_pro::text from profiles where id = '00000000-0000-0000-0000-0000000000a3'), 'true');
select t.eq('server (evaluate.js) can count evals',    (select eval_count from profiles where id = '00000000-0000-0000-0000-0000000000a3'), 8);

\echo 'PROFILE GUARD TESTS PASSED'
