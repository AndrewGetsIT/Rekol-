# Autopilot report (run 2)

Branch `autopilot/quick-wins`. Nothing merged, nothing pushed to `main`, production database never touched.

## 0. Before you merge (owner checklist)

1. **Netlify env vars:** set `RETRY_TOKEN_SECRET` (any long random string, e.g. 40+ characters). Without it everything works except "Retry failed sections", which fails closed with a server log line `RETRY_TOKEN_SECRET not set`. `SUPABASE_SERVICE_KEY` must already be set (evaluate.js now uses it to count evaluations).
2. **Deploy-preview checks:** signed out, click "Try a demo transcript" and run it (should work, no sign-in). Paste your own text and run: sign-in prompt appears with "Sign in to score your own call. Takes 10 seconds."; after signing in the evaluation starts by itself. Signed in, run an evaluation and check Profile count in Supabase goes up by 1. Break a batch is hard to do live; if a section ever fails you should see "Couldn't score this section. Retry".
3. **Order:** merge `autopilot/quick-wins` -> check it live -> only then apply `supabase/migrations/20261017_protect_profile_billing.sql` in the Supabase SQL editor. (Applied earlier, the free limit would stop counting.)
4. `20261011_multitenant_partners.sql` is in the repo but NOT part of this branch's behaviour; run 3 (partners) depends on it.

## 1. Summary

| Item | Status | Tests |
|---|---|---|
| Pack, DB suite, safety net | done | 29 baseline; DB suite 103 checks (93 + 10 profile guard) ALL PASSED |
| 0D never lose a score | done | 44 passed |
| 0B sign-in before own transcript (server) | done | auth-gate 15 server tests |
| 0B hardening 2a retry tokens | done | 9 tests |
| 0B hardening 2b pending transcript in sessionStorage | done | in browser tests |
| 0B hardening 2c browser tests | done | 13 browser tests |
| 0B hardening 2d profile billing guard (SQL + DB tests) | done, NOT applied | DB suite 103 checks ALL TESTS PASSED + PROFILE GUARD TESTS PASSED |
| 0E, 0C, 0A, Phases 2-6 | not started in this run (see below) | - |

Totals at last commit: `npm test` 83 passed; DB suite 103 checks passed.

## 2. Co-manager work on `main` (read-only review, nothing touched)

Uncommitted in `~/dev/Rekol-/Rekol`: `index.html` (+60/-), `ae-drilldown.js`, `team-dashboard.js`, `team-invite.js` (107 insertions, 27 deletions). No SQL file.
- **Role column:** the diff does not create it; the code relies on `team_members.role`, which exists in the live database because it was added directly in Supabase earlier (migration `add_role_to_team_members`, plus three additive SELECT policies and a `private.is_active_team_manager` helper). So the code and the live DB agree, but nothing in git records that DB change.
- **Who sees the manager dashboard:** owner OR an active `team_members` row with `role='manager'` (client `fetchMyTeams()`, `team-dashboard.js`, `ae-drilldown.js`). AEs never get it. Invites: co-managers can invite AEs, only the owner can invite a co-manager; invite UI gains an AE / Co-manager toggle and a CO-MANAGER badge.
- **Overlap with Phase 3:** same files and same intent. Phase 3 replaces every `owner_id` check with `can_oversee_team(team_id)` (owner, role='manager' managers, plus org coaches), so it supersedes the in-code checks. `20261011` does `add column if not exists role` (a no-op on the live DB, same check constraint) and adds its own SELECT policies and a guard trigger (browser inserts may only create role 'ae'); they OR with the existing co-manager policies, so no conflict. Expect merge conflicts in those four files; the invite toggle/badge UI is the part Phase 3 does not replace.
- **Recommendation:** commit the co-manager work on its own branch and merge it before partners; do not merge it into quick-wins.

## 3. Security-relevant changes

- `evaluate.js`: signed-out visitors can only score the demo transcript (401 `sign_in_required` otherwise); free-tier limit enforced server-side (402 `upgrade_required`, counted after a successful quick pass with compare-and-set; never for the demo, full mode or retries); retries need an HMAC `retry_token` bound to user + transcript hash + framework + 30 min expiry (403 otherwise; fails closed without `RETRY_TOKEN_SECRET`); `sections` subset validated (400). LegalFly gate untouched and still evaluated first.
- `index.html`: the browser no longer writes `eval_count`. Pending transcript (resume after sign-in) is in `sessionStorage` only, cleared on resume, on dismissing the modal, after 30 minutes and on page load (legacy localStorage copy removed).
- `supabase/migrations/20261017_protect_profile_billing.sql` (not applied): silently discards browser changes to `is_pro` / `eval_count`. Writers confirmed to use the service role: `stripe-webhook.js` (is_pro) and `evaluate.js` (eval_count). `profiles` has no other billing columns (id, email, name, eval_count, is_pro, custom_framework, created_at, digest_enabled, last_digest_sent).

## 4. Untested or assumed

- Not tested in a real browser: the look of the "not scored" card, the sign-in modal line, sign-in resume (Google redirect keeps the tab, so sessionStorage survives; a **magic link opened in a new tab will not resume**, by design of sessionStorage: the user just pastes again).
- Live Supabase behaviour of `section_status` fallback, the `eval_count` compare-and-set PATCH (`eval_count=eq.N` with `Prefer: return=representation`) and the real `profiles` row shape are assumed from PostgREST conventions and the mocks.
- Netlify env var `RETRY_TOKEN_SECRET` must exist for retries to work.

## 5. Decisions made without asking

1. **Run 1's clone and branch were lost** (scratchpad cleared, nothing pushed). Everything was rebuilt from the transcript in `/private/tmp/ap`; the work is re-created, not lost.
2. **Repo layout:** the GitHub repo root is `Rekol-/`, the app is in `Rekol/`. `docs/`, `supabase/`, `layers/`, `tests/`, `package.json` are at the repo root, outside the Netlify base folder.
3. **Tests mock `https`, not `fetch`** (functions use Node's `https`).
4. **The brief's section shape includes `quote`; the code has none.** Tests pin the real shape (name, score, status, covered, gaps, coaching, next_step).
5. **DB suite is 93 checks (+10 profile guard = 103).** `run_tests.sh` only changed for macOS portability.
6. **Baseline contract test allows one extra field** (`retry_token`) in full-mode responses; everything else in the baseline is unchanged.
7. **Fail open when the profile cannot be read** (a Supabase hiccup should not block every evaluation); such evaluations are not counted.
8. **The free-tier check runs at the start of quick and first-pass full.** The quick and full requests start together, so the 10th evaluation's full pass sees the pre-increment count. Retries skip the check but need the retry token.
9. Postgres 16 installed with Homebrew to run the DB suite (not running as a service).

## 6. Failures

None reverted. Run stopped after 0B hardening; see step 3 below if more was done.

## 7. Not done in this run

Phases 2-6 (separate run 3 on `autopilot/partners-foundation`). 0E, 0C, 0A: see summary table.
