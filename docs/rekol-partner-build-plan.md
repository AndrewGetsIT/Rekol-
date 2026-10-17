# Rekol build plan: partners + direct SaaS

Prepared 11 October 2026. One product, two routes to market: coach partners who resell Rekol to their clients, and direct sales to SaaS teams. Both need the same foundation (organisations, roles, DB-backed company layers, metering, branding, data protection), so this plan builds that once.

What's already done and tested in this pack:

- `migrations/20261011_multitenant_partners.sql` — the full database foundation. Tested on Postgres 16 against a Supabase-equivalent setup: **94 isolation checks pass**, the migration applies twice cleanly (idempotent), and a deliberately broken version is caught by the suite (mutation test), so the tests really do detect leaks.
- `tests/` — the stub, seed data and isolation suite, re-runnable with `bash tests/run_tests.sh`.
- `layers/company-layer.schema.json` + `layers/example-spin-coach-layer.json` — the format a coach's methodology is stored in. Onboarding a coach becomes "fill in this JSON", validated automatically.
- `rekol-security-pack.md` — the customer-facing data handling note, sub-processor list and offboarding policy, with every unverified fact marked.

Everything below is a Claude Code brief, in order. Each phase ships independently. Do them on a branch and merge one phase at a time.

---

## Gap map

| Gap | Needed for | Status |
|---|---|---|
| Organisations above teams (coach view) | Partners, multi-team companies | Schema built + tested. UI: Phase 3 |
| Manager role (more than one manager per team) | Both | Schema built + tested. Server + UI: Phase 3 |
| Company layers in the database, not hard-coded | Partners (one per coach), LegalFly gate removal | Schema built + tested. evaluate.js: Phase 2 |
| Fair-use caps + token logging | Partners (150/team/month), cost control | Schema built + tested. evaluate.js: Phase 2 |
| White-label reports | Partners | Schema built. UI: Phase 4 |
| Weekly manager brief, deal-risk view, coaching follow-through | Both, the "VP of Sales" proof | Columns built. Phase 5 |
| Export, retention purge, offboarding | Partners (GDPR), any paid team | Functions built + tested. Admin endpoints: Phase 6 |
| Security note + sub-processor list | Any paid team | Drafted, needs your confirmations |
| Prompt caching, sign-in gate, analytics, partial-failure fix, CRM copy block | Both | Phase 0 briefs |
| Partner provisioning (one command per new coach) | Partners at scale | Phase 3 brief |
| Gong key import, HubSpot write-back, async scoring | Later | Phase 7 (Gong brief already exists) |

---

## Phase 0 — quick wins (no migration needed, ship first)

### 0A. Prompt caching, measured

An honest correction first: I called this the best item on the list earlier, and it can be, but only when requests reuse the same prompt prefix within about five minutes *and after the first request has started*. Rekol fires its quick pass and full batches in parallel, so today almost nothing would hit the cache, and cache writes cost a little more than normal input. So this brief restructures the prompt so caching can actually work, then measures it, and keeps it only if it saves money.

> **Change:** Restructure the prompts in `netlify/functions/evaluate.js` so every call for one evaluation (quick pass + each full batch) shares an identical prefix, then enable Anthropic prompt caching on that prefix.
>
> **Why:** The transcript and the framework definition are the biggest part of each request and are identical across the quick pass and all full batches. Caching them can cut input cost on the repeat calls substantially.
>
> **Files:** `netlify/functions/evaluate.js` (and `practice.js` if it re-sends the same transcript).
>
> **Inspect first:** how system/user content is assembled for quick mode and each full batch, whether tools are used (tools sit first in the cached prefix, so their definitions must be identical across calls), and how the batches are launched (parallel vs sequential).
>
> **Expected behaviour:**
> 1. Order every request as: [shared instructions + full framework/layer definition] → [transcript] → cache breakpoint (`cache_control: {type: "ephemeral"}` on the last shared block) → [mode-specific instructions: quick, or "score only these sections: …"]. Nothing that varies by call may come before the breakpoint.
> 2. Launch the first full batch, wait until it has started responding (or ~1s), then launch the others so they can read the cache. Keep total time well under the ~26s ceiling; if the stagger pushes long transcripts too close, drop the stagger and accept fewer cache hits.
> 3. Log `usage.cache_creation_input_tokens` and `usage.cache_read_input_tokens` for every call (console for now; `usage_events` after Phase 2). If cache creation is always 0, the shared prefix is below the model's minimum cacheable length; note it and stop.
> 4. Put it behind an env flag `PROMPT_CACHE=on|off`, default on. After a week, compare cost per eval with and without. Keep whichever is cheaper.
> 5. No change to scores, output shape or the UI.

### 0B. Sign-in before your own transcript

> **Change:** Signed-out visitors can run the built-in demo transcript as often as they like. Scoring their own transcript requires sign-in (Google one-click or magic link). Signed-in users keep the 10 free evaluations, then the paywall.
>
> **Why:** Closes the localStorage free-tier bypass for good and turns anonymous usage into captured leads.
>
> **Files:** `index.html` (run button flow), `netlify/functions/evaluate.js` (server-side enforcement).
>
> **Inspect first:** where `eval_count` is incremented and checked today, and whether evaluate.js checks it at all or trusts the browser.
>
> **Expected behaviour:**
> 1. In evaluate.js, if the request has no valid Supabase token, accept it only if the transcript matches the demo transcript (compare a SHA-256 hash of the normalised text with a constant). Otherwise return 401 `{error: "sign_in_required"}`.
> 2. For signed-in non-pro users, read `profiles.eval_count` server-side with the service role, reject with 402 `{error: "upgrade_required"}` at 10, and increment it server-side after a successful quick pass. The browser stops being the source of truth.
> 3. In the UI, a 401 opens the existing sign-in modal with the line "Sign in to score your own call. Takes 10 seconds." and, after sign-in, re-runs the evaluation automatically with the transcript still in the box.
> 4. The demo transcript path must not increment anything.

### 0C. Analytics (cookieless)

> **Change:** Add Plausible (cookieless, so no consent banner) to `index.html`, plus custom events.
>
> **Why:** Without a baseline, the pilot and any partner launch can't be measured.
>
> **Files:** `index.html`.
>
> **Expected behaviour:** Track pageviews and these events only: `demo_run`, `eval_started`, `eval_completed`, `eval_failed`, `signin_prompted`, `signin_completed`, `paywall_shown`, `share_created`, `team_created`, `crm_copied`. Properties allowed: framework name and mode. **Never** send transcript text, emails, names, deal names or scores to analytics. Remove the commented-out GA tag.

### 0D. Never lose a score (partial-failure fix)

> **Change:** If the quick pass succeeds and a full batch fails, keep the score on screen, show the sections that did load, and offer to retry only the failed sections.
>
> **Why:** Today a failed full pass sends the user back home and loses the result. It's on the known-issues list.
>
> **Files:** `index.html` (output rendering, error handling), `netlify/functions/evaluate.js` (accept a `sections` subset to score).
>
> **Expected behaviour:**
> 1. Track each batch as `done` or `failed`. Render done sections normally; failed ones show "Couldn't score this section. Retry" with a button that calls evaluate.js for just those sections.
> 2. The eval is saved once all sections are done, or when the user leaves with some failed (save what exists, with `section_status` recording which failed, once Phase 1's column exists).
> 3. Only a failed quick pass returns the user to the form, with the transcript still in the box.
> 4. Retrying must not count as a new evaluation against the free tier or a team cap.

### 0E. Copy to CRM

> **Change:** Add a "Copy for HubSpot" button to the output view that copies a tidy field block built from the evaluation.
>
> **Why:** Proves the "call quality lives on the deal record" value with zero integration. If reps use it, the HubSpot write-back is worth building. The `crm_copied` event tells you.
>
> **Files:** `index.html` only. No extra model call.
>
> **Expected behaviour:** Build the block client-side from existing output. For each section, use the layer's `crm_field` label if present, otherwise the section name, and its covered text plus the first gap. Then add `Next step:` (first next step), `Risks:` (names of red sections), `Score:` overall and `Scored by Rekol on <date>`. Plain text, one `Label: value` per line, under 1,500 characters. Show "Copied" for two seconds. Save it to `evaluations.crm_summary` once the column exists.

---

## Phase 1 — apply the database migration

> **Change:** Run `migrations/20261011_multitenant_partners.sql` in the Supabase SQL editor (it's one transaction, so it either fully applies or does nothing). Commit the file to the repo under `supabase/migrations/`.
>
> **Before running:** confirm in Table Editor that `evaluations` has a `user_id` and `created_at` column and that `teams`/`team_members` match the names in the file. The migration only adds things and assumes nothing else.
>
> **After running:** Database → Advisors → Security: confirm no new warnings. Then, logged in as yourself, check History, Trends and the Manager dashboard all still work exactly as before. Nothing in the app uses the new tables yet, so nothing should change.
>
> **Note:** the Supabase API was timing out from my side when I tried to inspect the live database on 11 October, so I built and tested against the schema we confirmed earlier. Worth checking the project isn't paused (Supabase dashboard → project status) before you run it.

---

## Phase 2 — company layers from the database, metering and caps

> **Change:** evaluate.js loads the team's company layer from `company_layers` (service role), enforces the team's monthly cap, and logs every model call to `usage_events`. The hard-coded LegalFly allowlist and framework text are removed from the code.
>
> **Why:** One code path serves every coach and company. Caps protect your margin. Removing the LegalFly text from the codebase also means your employer's playbook no longer lives in Rekol's source at all, which strengthens the separation story.
>
> **Files:** `netlify/functions/evaluate.js`, a small shared helper (e.g. `netlify/functions/_lib/context.js`), `index.html` (team picker + layer label).
>
> **Expected behaviour:**
> 1. The request may include `team_id`. If present: verify the token, verify with the service role that the user is an active member or owner of that team, the team's `status` is active and its organisation's `status` is active. Otherwise 403.
> 2. If the team has a `company_layer_id`, load `definition`, `backbone` and `version` with the service role and build the prompt from the backbone + layer exactly as the LegalFly layer works today. The definition is never returned to the browser.
> 3. Before scoring, call `team_evals_this_month(team_id)`. If it is at or over `monthly_eval_cap`, return 429 `{error: "team_cap_reached"}` and show "Your team has used this month's evaluations. Your coach can raise the limit." No cap for personal (no team) evaluations; they keep the existing free/pro rules.
> 4. After each Anthropic call, insert a `usage_events` row with the service role: `user_id`, `team_id`, `org_id`, `kind` (`eval_quick` once per evaluation, `eval_full_batch` per batch), `model`, input/output/cache tokens from `response.usage`, `latency_ms`, `ok`. Retries of failed sections log `eval_full_batch` only.
> 5. The client saves the evaluation with `team_id`, `deal_key` (lower-cased, trimmed, single-spaced deal name), `company_layer_id` and `company_layer_version`. RLS already blocks saving into a team the user isn't in.
> 6. **LegalFly migration:** create an organisation `kind='internal'`, owner = your personal account, `allow_public_shares=false`; insert the LegalFly layer as a `company_layers` row (copy the text exactly from the current server-side constant); attach it to your team. Verify a LegalFly eval runs end to end with all nine sections from the team, and only then delete the allowlist and the constant from the code. Logged out and as any other user, there must be no trace of it.
> 7. In the UI, a signed-in user who belongs to a team sees a "Scoring for: <team name> · <layer name>" chip and can switch to personal. Layer names come from `rpc('my_team_layers')`.
> 8. Timing: the DB lookups add one round trip; keep total time under the ceiling. Fetch the layer and the cap count in parallel.

---

## Phase 3 — roles, coach view and partner provisioning

> **Change:** Add manager promotion, a coach view across all of an organisation's teams, and an admin-only provisioning endpoint that sets up a new coach in one call.
>
> **Why:** This is what makes coach number two take an hour instead of a fortnight.
>
> **Files:** existing team/manager functions (team-dashboard.js, ae-drilldown.js, invite functions), new `netlify/functions/set-team-role.js`, new `netlify/functions/admin-provision-partner.js`, `index.html` (new `v-coach` view, manager dashboard takes a `team_id`).
>
> **Expected behaviour:**
> 1. **Access checks everywhere use one rule.** Replace every "is this user the team owner" check in the dashboard functions with a call to the SQL helper `can_oversee_team(team_id)`, made with a Supabase client carrying the *user's* JWT (so `auth.uid()` is the caller). Owners, managers and the owning organisation's coaches pass; plain AEs and everyone else get 403. This is the single most important line in the phase: a missed check here is a cross-team leak, so grep for every `owner_id` comparison.
> 2. `set-team-role.js`: POST `{team_id, user_id, role: "manager"|"ae"}`. Allowed if the caller is the team owner or an admin of the team's organisation. Uses the service role to write (the database blocks role changes from the browser by design). The owner can't be demoted.
> 3. `v-coach`: for users who are members of an organisation, list its teams with: evaluations this month vs cap, average score, weakest stage, active reps. Clicking a team opens the existing manager dashboard for that `team_id`. The nav shows "Coach" only for organisation members.
> 4. `admin-provision-partner.js`: callable only by emails in an `ADMIN_EMAILS` env var. Input: coach email, organisation name, kind, plan, `max_teams`, brand name/logo URL/accent, the layer JSON, first team name, client manager email, AE emails, cap. It validates the layer against `layers/company-layer.schema.json`, then creates the organisation, owner membership, layer, team (owner = coach, layer attached), and invites (manager invite flagged so the role is set to `manager` when they accept). Returns everything it created. If any step fails it deletes what it created. If the coach hasn't signed up yet, return a clear error asking them to sign in once first.
> 5. Invites: when an invited user signs in and auto-matches, apply the role recorded on their invite via the service role.

---

## Phase 4 — white-label reports

> **Change:** When an evaluation belongs to a team in an organisation with branding, the report carries the coach's brand.
>
> **Files:** `index.html` (output view, print styles), `netlify/functions/share.js` and the `/e/*` shared page, `netlify/functions/digest.js` email template.
>
> **Expected behaviour:**
> 1. Get branding with `rpc('team_branding', {p_team})`. Show the logo and `brand_name` in the report header; if `powered_by_rekol` is true, a small "Powered by Rekol" footer.
> 2. `brand_accent` replaces `--ac` only on report surfaces (header rule, score ring, buttons in the report). Red/amber/green never change, they carry meaning. No branding = the current teal design exactly.
> 3. **Security:** render `brand_name` with `textContent`, never `innerHTML`. Only accept `https://` logo URLs (or a Supabase Storage public bucket `brand-logos`), shown via `<img>` with fixed max dimensions. Validate the accent as `#RRGGBB` (the database also enforces this).
> 4. Add a print stylesheet so "Download scorecard" opens the browser's Save as PDF with a clean one-page, branded layout.
> 5. `share.js`: when sharing a team evaluation, write `team_id` and embed the branding in the stored JSON so the public page renders it. If the organisation has `allow_public_shares = false`, refuse with "Sharing is turned off for this team."

---

## Phase 5 — the "VP of Sales" layer: weekly brief, deal risk, follow-through

> **Change:** Turn the weekly digest into a finished manager brief, add a deal-risk view, and track whether coaching lands.
>
> **Files:** `netlify/functions/digest.js`, `index.html` (`v-manager`), save logic for evaluations.
>
> **Expected behaviour:**
> 1. **Coaching focus on save:** when an evaluation is saved, set `coaching_focus` to the lowest-scoring section's name plus its coaching line.
> 2. **Deal-risk view** in the manager dashboard: group the team's evaluations by `deal_key`; per deal show call count, latest score per section and a flag "Still red after 2 calls: <section>" for any section marked `critical` in the layer (for MEDDIC without a layer: Economic Buyer, Decision Process, Identify Pain). Sort flagged deals first.
> 3. **Follow-through:** per rep, for each coaching focus, show the score of that section on the next three evaluations: "Coached on Implication on 3 Oct → 34, 52, 61". Team level: "4 of 6 coaching points improved within 3 calls."
> 4. **Weekly manager brief** (Monday 8am UTC, existing schedule), sent to team owners, managers and coaches, branded per Phase 4. Contents: evaluations this week by rep; the team's weakest stage with one evidence quote; one coaching point per rep with the quote behind it; flagged deals; follow-through summary. Build the numbers in code, then make **one** small model call over the aggregated data (never full transcripts) to write the 4 or 5 sentences of narrative. Log it to `usage_events` as `digest`.
> 5. Respect `digest_enabled`. Skip teams with no evaluations that week.

---

## Phase 6 — data protection operations

> **Change:** Admin endpoints for export and offboarding, a daily retention purge, and log hygiene.
>
> **Files:** new `netlify/functions/admin-export-org.js`, `admin-offboard-org.js`, scheduled `purge-retention.js`, `netlify.toml`, all functions (log review).
>
> **Expected behaviour:**
> 1. `admin-export-org` (ADMIN_EMAILS only): returns `export_organisation(org_id)` as a downloadable JSON file.
> 2. `admin-offboard-org` (ADMIN_EMAILS only): requires the organisation name typed exactly; always produces the export first and returns it; then calls `offboard_organisation(org_id, name)` and returns the deletion counts. The database writes an `offboarding_log` row as proof.
> 3. `purge-retention`: scheduled daily, calls `purge_expired_team_evaluations()` and logs the count.
> 4. **Logs:** search every function for `console.log` of request bodies, transcripts, prompts or model output and remove them. Log ids, counts and timings only. Netlify keeps function logs, so a logged transcript is stored personal data.
> 5. **Confirm and record (needed for the security pack):** whether full transcripts are stored anywhere (evaluations, shared_evals JSON, localStorage, logs); the Supabase project region (Settings → General); the Netlify functions region (Project configuration → Functions → Region). If you move to Netlify Pro, set functions to `lhr` (London).

---

## Phase 7 — later

- **Gong key import:** brief already written (Feature 6 in `rekol-features-brief.md`). Log imports as `usage_events.kind = 'import'`.
- **HubSpot write-back:** only once `crm_copied` events show reps actually use 0E. Customer's HubSpot admin creates a private app token; Rekol writes the 0E fields as deal properties. No partner approval needed.
- **Async scoring** (Netlify background functions + Supabase Realtime): when transcript length or volume actually breaks the batching approach, not before.

---

## Cost sanity check

At Haiku list prices, an evaluation is roughly a few US cents to around ten cents depending on transcript length (one quick call plus up to three full batches). Even at the full fair-use cap of 150 evaluations, a team costs single-digit to low double-digit pounds a month in model spend against a £249 price. Treat this as an estimate until Phase 2's `usage_events` gives you the real number; then you'll have exact cost per team.
