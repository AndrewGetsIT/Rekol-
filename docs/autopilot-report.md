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
| 0E Copy for HubSpot | done | 8 tests (91 total) |
| 0C Analytics (Plausible) | done | 9 tests (100 total) |
| 0A Prompt caching (PROMPT_CACHE, default off) | done | 11 tests (111 total) |
| Phases 2-6 | not started (separate run 3) | - |

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

## 4b. 0E notes

- The block is built client-side only. Saving it to `evaluations.crm_summary` is **not done**: that column only exists after the partners migration, and the browser's evaluation id is not the database id, so there is nothing safe to update yet. Do it with Phase 2's save logic.
- No layer exists yet, so `crm_field` is honoured only if a section carries one; today labels are section names.
- The `crm_copied` analytics event is added by 0C.

## 4c. 0C notes

- Plausible script for `getrekol.com` added; the commented-out GA tag removed. Nothing records until you create the Plausible site. To see `framework`/`mode` in the dashboard, add them as custom properties in Plausible.
- `signin_completed` only fires for a sign-in that followed a prompt in the same tab (sessionStorage flag), so a magic link opened in a new tab is not counted. This undercounts rather than over-counts.
- Events: demo_run, eval_started, eval_completed (once per evaluation, when all sections loaded, including via retry), eval_failed, signin_prompted, signin_completed, paywall_shown, share_created, team_created, crm_copied. A test asserts every one fires somewhere and that no property other than a built-in framework name and quick/full mode can be sent.

## 4d. 0A notes (prompt caching)

- **Default is off**: with `PROMPT_CACHE` unset or anything but `on`, requests are exactly as before (a test pins this). To try it: set `PROMPT_CACHE=on` in Netlify, run a few evaluations, and read the Netlify function logs for lines like `Full mode (group 1/2) usage — input: .. output: .. cache_write: .. cache_read: ..` (numbers only, no text). Compare cost per evaluation with it on and off for a week and keep the cheaper.
- **Check this first:** for `claude-haiku-4-5` the minimum cacheable prefix is **4,096 tokens**. Typical transcripts (a few hundred to a couple of thousand words) plus the framework text are below that, so `cache_write` will read 0 on every call and caching cannot help; leave it off. It only matters for long transcripts or LegalFly.
- When on: every call for one evaluation shares an identical `tools` array (both tools; the section tool lists all of the framework's section names) and an identical `system` block (shared instructions + full framework + transcript) with `cache_control` on that block, after the transcript. Only the short user message differs per call. `tool_choice` still forces the right tool per call; per Anthropic's rules changing `tool_choice` leaves the tools+system cache valid.
- Behaviour differences when on (and why): (1) quick mode uses the full framework text, so LegalFly's shorter quick-only summary is not used (needed for an identical prefix; MEDDIC/BANT/SPIN/Custom are unchanged); (2) the per-batch section-name enum and exact item count in the tool schema cannot be per-batch in a shared schema, so the server now checks that each batch returned exactly its assigned sections (a wrong set is retried/failed like any malformed result); the instruction still says how many entries to return; (3) the first full-mode batch gets a ~1s head start before the others launch (skipped for transcripts over 60,000 characters). The browser still sends the quick and full requests as two separate parallel requests, so quick vs full sharing a cache entry is opportunistic.
- Not measurable here: actual cache hit rates and cost (needs live traffic). Scores/prompts under the flag were only checked with the fake model, not against the real one; compare a few evaluations side by side before leaving it on.

## 7. Not done in this run

Phases 2-6 (separate run 3 on `autopilot/partners-foundation`). 0E, 0C, 0A: see summary table.
