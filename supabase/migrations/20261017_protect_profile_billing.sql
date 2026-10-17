-- =====================================================================
-- Rekol migration: stop signed-in users editing their own billing fields
--
-- File:    migrations/20261017_protect_profile_billing.sql
-- Problem: profiles RLS lets a user update their own row, so anyone signed in
--          can run, from the browser console:
--            supabase.from('profiles').update({ is_pro: true, eval_count: 0 })
--          and get Pro for free or reset their free allowance.
-- Fix:     browser requests (roles 'authenticated'/'anon') can still edit their
--          own name, digest settings and custom framework, but any change they
--          make to is_pro or eval_count is silently discarded. Only the server
--          (service role: Stripe webhook, evaluate.js) or the SQL editor can
--          change them. Silent rather than an error, so older cached copies of
--          the site that still try to bump eval_count don't break.
--
-- APPLY ONLY AFTER brief 0B is live, because 0B moves eval counting to the
-- server. Applied earlier, the free limit would stop counting until 0B ships.
--
-- If profiles has other billing columns (e.g. stripe_customer_id,
-- subscription_status, pro_until), add them to both branches below.
-- =====================================================================

begin;

create or replace function public.guard_profile_billing_fields()
returns trigger language plpgsql set search_path = public as $$
begin
  if current_user in ('authenticated', 'anon') then
    if tg_op = 'INSERT' then
      new.is_pro     := false;
      new.eval_count := 0;
    else
      new.is_pro     := old.is_pro;
      new.eval_count := old.eval_count;
    end if;
  end if;
  return new;
end $$;

revoke all on function public.guard_profile_billing_fields() from public, anon, authenticated;

drop trigger if exists trg_guard_profile_billing_fields on public.profiles;
create trigger trg_guard_profile_billing_fields
  before insert or update on public.profiles
  for each row execute function public.guard_profile_billing_fields();

commit;
