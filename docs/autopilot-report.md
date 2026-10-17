# Autopilot report (run 2)

Branch `autopilot/quick-wins`. Nothing merged, nothing pushed to `main`, production database never touched.

## 0. Before you merge (owner checklist)

1. **Netlify env vars:** `RETRY_TOKEN_SECRET` (any long random string; without it retries fail closed and are logged as "RETRY_TOKEN_SECRET not set"). Later items may add `PROMPT_CACHE` (default off).
2. **Deploy-preview checks:** signed out, click "Try a demo transcript" and run it (should work, no sign-in). Paste your own text and run: sign-in prompt appears with "Sign in to score your own call. Takes 10 seconds."; after signing in the evaluation starts by itself. Signed in, run an evaluation and check Profile count in Supabase goes up by 1. Break a batch is hard to do live; if a section ever fails you should see "Couldn't score this section. Retry".
3. **Order:** merge `autopilot/quick-wins` -> check it live -> only then apply `supabase/migrations/20261017_protect_profile_billing.sql` in the Supabase SQL editor. (Applied earlier, the free limit would stop counting.)
4. `20261011_multitenant_partners.sql` is in the repo but NOT part of this branch's behaviour; run 3 (partners) depends on it.

## 1. Summary

| Item | Status | Tests |
|---|---|---|
| Pack, DB suite, safety net | done | 29 baseline; DB suite 103 checks (93 + 10 profile guard) ALL PASSED |
| 0D never lose a score | done | 44 passed |
