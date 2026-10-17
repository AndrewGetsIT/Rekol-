const https = require('https')
const crypto = require('crypto')

const SUPA_HOST = 'iqdnmlzamqqskfjysfzg.supabase.co'
const SUPA_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlxZG5tbHphbXFxc2tmanlzZnpnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYzNTU3NTMsImV4cCI6MjA5MTkzMTc1M30.bYFx7o_Cvr8SoLPHO_dlguOZ9x7bX9ekf_IIDUSbIYo'

// LegalFly is a private framework, scoped to one account only — everyone
// else's requests must be rejected before the LegalFly methodology (see
// FW_DESC.LegalFly below) is ever assembled into a prompt or sent
// anywhere. This is the real security boundary; index.html's tab-hiding
// is a UX nicety on top of it, not a substitute for it — a hidden button
// doesn't stop a direct API call.
const LEGALFLY_ALLOWED_EMAIL = 'andrewlennon16@gmail.com'

// Signed-out visitors may only score the built-in demo transcript (the text
// behind "Try a demo transcript" in index.html). Their own transcripts need
// a signed-in account. Compared by SHA-256 of the whitespace-normalised
// text, so there is no copy of the demo text to keep in sync here — a test
// (tests/auth-gate.test.js) fails if index.html's demo text ever drifts from
// this hash.
const DEMO_TRANSCRIPT_SHA256 = 'c9d9f51dd3fa83bb2caa72d12f84eddf6f6383be86f8b4d295c158e15073a2f0'
function normaliseTranscript(t) { return String(t || '').replace(/\s+/g, ' ').trim() }
function sha256Hex(t) { return crypto.createHash('sha256').update(normaliseTranscript(t)).digest('hex') }
function isDemoTranscript(t) { return sha256Hex(t) === DEMO_TRANSCRIPT_SHA256 }

// Free tier: this many evaluations per signed-in, non-pro account. Counted
// here on the server (profiles.eval_count) — the browser's copy is only for
// display, so clearing localStorage no longer resets anything.
const FREE_LIMIT = 10

// Prompt caching stagger (only used when PROMPT_CACHE=on): how long the first
// full-mode batch gets to start before the others launch, and the transcript
// size above which the stagger is skipped to protect the time budget.
const CACHE_STAGGER_MS = 1000
const CACHE_STAGGER_MAX_CHARS = 60000

// Retry tokens. Re-scoring failed sections (a `sections` subset) is not
// metered, so it must not be usable as a free way to score a new
// transcript. A full pass that was allowed (signed in, under the limit)
// returns retry_token = expiry + '.' + HMAC-SHA256(secret,
// user_id | sha256(normalised transcript) | framework | expiry). A retry
// must present a token that matches the same user, transcript and
// framework and has not expired (30 minutes). No RETRY_TOKEN_SECRET means
// retries fail closed.
const RETRY_TOKEN_TTL_MS = 30 * 60 * 1000
function retrySignature(userId, transcript, framework, expiry) {
  return crypto.createHmac('sha256', process.env.RETRY_TOKEN_SECRET)
    .update([userId, sha256Hex(transcript), String(framework), String(expiry)].join('|'))
    .digest('hex')
}
function issueRetryToken(userId, transcript, framework) {
  if (!process.env.RETRY_TOKEN_SECRET) {
    console.error('RETRY_TOKEN_SECRET not set — retry tokens cannot be issued, retries will fail')
    return null
  }
  const expiry = Date.now() + RETRY_TOKEN_TTL_MS
  return expiry + '.' + retrySignature(userId, transcript, framework, expiry)
}
function verifyRetryToken(userId, transcript, framework, token) {
  if (!process.env.RETRY_TOKEN_SECRET) {
    console.error('RETRY_TOKEN_SECRET not set — retries are disabled')
    return false
  }
  if (typeof token !== 'string') return false
  const parts = token.split('.')
  if (parts.length !== 2 || !/^\d+$/.test(parts[0]) || !/^[0-9a-f]{64}$/.test(parts[1])) return false
  const expiry = Number(parts[0])
  if (expiry < Date.now()) return false
  const expected = Buffer.from(retrySignature(userId, transcript, framework, expiry), 'hex')
  return crypto.timingSafeEqual(expected, Buffer.from(parts[1], 'hex'))
}

// Supabase REST with the service role (bypasses RLS). Used only to read and
// bump the caller's own profile row; the caller's identity comes from
// verifyUser(), never from the request body.
function supabaseService(method, path, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null
    const headers = Object.assign({
      'Content-Type': 'application/json',
      'apikey': process.env.SUPABASE_SERVICE_KEY,
      'Authorization': 'Bearer ' + process.env.SUPABASE_SERVICE_KEY,
    }, extraHeaders || {})
    if (data) headers['Content-Length'] = Buffer.byteLength(data)
    const req = https.request({ hostname: SUPA_HOST, path: path, method: method, headers: headers }, (res) => {
      let raw = ''
      res.on('data', chunk => raw += chunk)
      res.on('end', () => resolve({ status: res.statusCode, body: raw }))
    })
    req.on('error', reject)
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('Timeout')) })
    if (data) req.write(data)
    req.end()
  })
}

// Returns { known: true, count, isPro, exists } or { known: false } if the
// profile could not be read (the caller decides what to do about that).
async function readProfile(userId) {
  try {
    const res = await supabaseService('GET', '/rest/v1/profiles?id=eq.' + encodeURIComponent(userId) + '&select=eval_count,is_pro', null)
    if (res.status !== 200) return { known: false }
    const rows = JSON.parse(res.body)
    if (!rows.length) return { known: true, exists: false, count: 0, isPro: false }
    return { known: true, exists: true, count: rows[0].eval_count || 0, isPro: !!rows[0].is_pro }
  } catch (e) {
    return { known: false }
  }
}

// Compare-and-set increment: only writes if the count is still what we read,
// so two evaluations finishing at once cannot both write the same number.
// Re-reads and retries a couple of times on conflict.
async function bumpEvalCount(userId, profile) {
  let count = profile.count
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await supabaseService(
        'PATCH',
        '/rest/v1/profiles?id=eq.' + encodeURIComponent(userId) + '&eval_count=eq.' + count,
        { eval_count: count + 1 },
        { 'Prefer': 'return=representation' }
      )
      if (res.status >= 200 && res.status < 300) {
        const rows = res.body ? JSON.parse(res.body) : []
        if (rows.length) return true
      } else {
        return false
      }
    } catch (e) { return false }
    const fresh = await readProfile(userId)
    if (!fresh.known || !fresh.exists) return false
    count = fresh.count
  }
  return false
}

// Same verifyUser pattern already used in team-invite.js/team-dashboard.js/
// ae-drilldown.js — asks Supabase Auth who a bearer token belongs to.
// evaluate.js has never needed auth before (the product works anonymously
// by design), so this is net-new here, used only for the LegalFly gate.
function verifyUser(authHeader) {
  return new Promise((resolve) => {
    if (!authHeader) return resolve(null)
    const token = authHeader.replace(/^Bearer\s+/i, '')
    const options = {
      hostname: SUPA_HOST,
      path: '/auth/v1/user',
      method: 'GET',
      headers: { 'Authorization': 'Bearer ' + token, 'apikey': SUPA_ANON_KEY },
    }
    const req = https.request(options, (res) => {
      let raw = ''
      res.on('data', chunk => raw += chunk)
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve(null)
        try {
          const user = JSON.parse(raw)
          resolve(user && user.id ? user : null)
        } catch (e) { resolve(null) }
      })
    })
    req.on('error', () => resolve(null))
    req.end()
  })
}

function post(data, onStart) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data)
    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
    }
    const req = https.request(options, (res) => {
      if (onStart) onStart()
      let raw = ''
      res.on('data', chunk => raw += chunk)
      res.on('end', () => resolve({ status: res.statusCode, body: raw }))
    })
    req.on('error', (err) => { console.error('HTTPS error:', err); reject(err) })
    req.setTimeout(55000, () => { req.destroy(); reject(new Error('Timeout')) })
    req.write(body)
    req.end()
  })
}

// Calls the Anthropic API with a forced tool call (tool_choice targeting a
// single tool whose input_schema defines the exact shape we want) instead
// of asking for free-text JSON. This eliminates the "malformed JSON" bug
// class entirely rather than patching around it: the old text-completion
// approach asked the model to hand-author a JSON string, and a quote-heavy
// transcript (a prospect quoting a contract clause, a number "in quotes",
// etc.) reliably produced an unescaped `"` or stray trailing prose that
// broke JSON.parse — retrying just re-sent the same input and failed
// identically. With tool use, Anthropic's API returns the tool call's
// `input` as an already-parsed object; there's no free-text JSON for the
// model to get wrong, and no JSON.parse on model-authored text at all.
//
// A 429 (rate-limited) still gets its own short backoff-and-retry path:
// full mode fires two section-group calls concurrently, each carrying the
// full transcript, so a long transcript can push concurrent input-token
// volume over the account's tokens-per-minute limit. A brief backoff is
// usually enough to clear that.
//
// A missing/incomplete tool_use block (e.g. generation cut off by
// max_tokens before the tool call finished) still gets one retry — rare
// with tool use, but a fresh generation is cheap insurance against hard
// 502ing on the first bad attempt.
//
// That retry is time-budget-aware, not just attempt-count-aware: retrying
// is only worth it if there's plausibly enough of the ~26s Netlify ceiling
// left for the retry to actually finish. A full-mode group call routinely
// takes 10-25s on its own — real production timing showed individual
// group calls occasionally running as long as ~25-28s even on their FIRST
// attempt, so a retry can be just as slow as the call it's replacing.
// MIN_REMAINING_FOR_RETRY_MS is set assuming the retry could itself take
// up to ~20s in the worst case: only retry if that leaves the total
// safely under RETRY_BUDGET_MS. An earlier, looser floor (10s) still let
// a real request hit 29.9s once a retry that itself ran long was added on
// top of an already-slow first attempt — this floor is deliberately
// conservative to make that mathematically impossible: elapsed-at-failure
// must be small (the failure has to show up fast) for a retry to be
// attempted at all. That means most "took a while, then came back
// malformed" failures won't get an in-function retry — that's intentional
// and safe; the existing client-side 502 retry (untouched) is the right
// layer for those, since it restarts with a completely fresh time budget
// instead of squeezing a retry into whatever's left of this one.
//
const RETRY_BUDGET_MS = 24000
const MIN_REMAINING_FOR_RETRY_MS = 20000
//
// Returns { result } on success (already a parsed object — no further
// parsing needed by the caller), or { error, status } otherwise — error is
// a human-readable string that includes Anthropic's real status/body so
// failures are visible in the response itself, not just in server logs we
// have no way to read from here.
// expectedSectionCount is optional (quick mode's tool has no `sections`
// field at all) — when given, a result whose `sections` array is missing,
// not actually an array, or the wrong length is treated the same as
// malformed JSON and gets the same retry-once treatment. Without this, a
// tool call that technically "succeeds" (a valid object, just with an
// empty or truncated sections array — e.g. cut short near max_tokens)
// would sail past the only check that used to exist here, and the
// incompleteness would only surface much later at the merge/completeness
// guard, by which point there's no time budget left to retry just that
// one call — the whole eval fails instead of quietly retrying the one
// piece that needed it.
// Logs token usage for a call: numbers only, never any request or response text.
// cache_creation stays 0 on every call when the shared prefix is below the
// model's minimum cacheable length (4096 tokens for Haiku 4.5), which is the
// signal that caching cannot help at this transcript size.
function logUsage(label, usage) {
  if (!usage) return
  console.log(label + ' usage — input:', usage.input_tokens, 'output:', usage.output_tokens,
    'cache_write:', usage.cache_creation_input_tokens || 0, 'cache_read:', usage.cache_read_input_tokens || 0)
}

// opts (optional): { onStart } fires when the response begins; { expectedNames }
// requires every returned section name to be one of the names this call was
// assigned, exactly once (the shared cached tool schema cannot enforce that per
// batch the way the per-call schema's enum does, so it is checked here).
async function postToolCall(payload, label, startTime, expectedSectionCount, opts) {
  let attempt = 0
  while (true) {
    attempt++
    let response
    try {
      response = await post(payload, opts && opts.onStart)
    } catch (err) {
      console.error(label + ' request failed:', err.message)
      return { error: label + ' — request failed: ' + err.message, status: null }
    }

    if (response.status === 429 && attempt < 3) {
      const wait = 800 * attempt
      console.error(label + ' rate-limited (429, attempt ' + attempt + ') — retrying in ' + wait + 'ms')
      await new Promise(resolve => setTimeout(resolve, wait))
      continue
    }

    if (response.status !== 200) {
      const snippet = (response.body || '').slice(0, 300)
      console.error(label + ' Anthropic error ' + response.status + ':', snippet)
      return { error: label + ' — Anthropic ' + response.status + ': ' + snippet, status: response.status }
    }

    try {
      const data = JSON.parse(response.body)
      logUsage(label, data.usage)
      const toolUse = (data.content || []).find(c => c.type === 'tool_use')
      if (!toolUse || typeof toolUse.input !== 'object' || toolUse.input === null) {
        throw new Error('No tool_use result in response (stop_reason: ' + data.stop_reason + ')')
      }
      if (expectedSectionCount !== undefined) {
        const secs = toolUse.input.sections
        if (!Array.isArray(secs) || secs.length !== expectedSectionCount) {
          throw new Error('Expected ' + expectedSectionCount + ' sections, got ' + (Array.isArray(secs) ? secs.length : typeof secs) + ' (stop_reason: ' + data.stop_reason + ')')
        }
      }
      if (opts && opts.expectedNames) {
        const names = (toolUse.input.sections || []).map(x => x && x.name)
        const ok = names.every(n => opts.expectedNames.includes(n)) && new Set(names).size === names.length
        if (!ok) throw new Error('Returned sections do not match the ones assigned to this call')
      }
      return { result: toolUse.input }
    } catch (e) {
      console.error(label + ' malformed tool response (attempt ' + attempt + '):', e.message)
      const elapsed = Date.now() - startTime
      const remaining = RETRY_BUDGET_MS - elapsed
      if (attempt >= 2 || remaining < MIN_REMAINING_FOR_RETRY_MS) {
        console.error(label + ' — not retrying (attempt ' + attempt + ', ' + remaining + 'ms left of budget)')
        return { error: label + ' — returned no valid structured result: ' + e.message, status: response.status }
      }
      console.error(label + ' — retrying (' + remaining + 'ms left of budget)')
      // one retry allowed — still enough of the time budget left, loop again
    }
  }
}

exports.handler = async function (event) {
  const startTime = Date.now()
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' }

  try {
    let { transcript, framework, customFields, dealName, persona, mode, dealStage, sections: onlySections, includeNextSteps: wantNextSteps, retry_token: retryTokenIn } = JSON.parse(event.body)

    // LegalFly is private to one account. Checked before anything else
    // touches the framework — before FW_FIELDS/FW_DESC are even looked
    // up — so a rejected request never gets near assembling the LegalFly
    // methodology into a prompt. Applies to both quick and full mode.
    const authHeader = event.headers.authorization || event.headers.Authorization
    let caller
    if (framework === 'LegalFly') {
      caller = await verifyUser(authHeader)
      const callerEmail = caller && caller.email ? caller.email.toLowerCase() : null
      if (callerEmail !== LEGALFLY_ALLOWED_EMAIL.toLowerCase()) {
        return { statusCode: 403, body: JSON.stringify({ error: 'This framework is not available.' }) }
      }
    }

    // Sign-in gate. Signed-out visitors may score only the built-in demo
    // transcript; the demo path never touches the free-tier count.
    // Signed-in users keep FREE_LIMIT evaluations, then get a 402.
    //  - quick mode starts an evaluation: checked, and counted after it succeeds.
    //  - full mode (first pass) is the same evaluation: checked, never counted.
    //  - a `sections` subset is a retry of failed sections: it needs a valid
    //    retry_token (issued by an allowed full pass for this same user,
    //    transcript and framework), and is neither checked nor counted.
    // If the profile cannot be read (a Supabase hiccup) the evaluation is
    // allowed and not counted rather than blocking everyone.
    let profile = null
    const isDemo = isDemoTranscript(transcript)
    const isRetryCall = mode !== 'quick' && Array.isArray(onlySections) && onlySections.length > 0
    if (!isDemo) {
      if (caller === undefined) caller = await verifyUser(authHeader)
      if (!caller) {
        return { statusCode: 401, body: JSON.stringify({ error: 'sign_in_required' }) }
      }
      if (isRetryCall) {
        if (!verifyRetryToken(caller.id, transcript, framework, retryTokenIn)) {
          return { statusCode: 403, body: JSON.stringify({ error: 'retry_not_allowed' }) }
        }
      } else {
        profile = await readProfile(caller.id)
        if (profile.known && !profile.isPro && profile.count >= FREE_LIMIT) {
          return { statusCode: 402, body: JSON.stringify({ error: 'upgrade_required' }) }
        }
      }
    }

    const stageLine = dealStage ? 'Deal stage: ' + dealStage + ' — factor this into your coaching, e.g. "Given this is a ' + dealStage.toLowerCase() + '-stage deal, the AE should have been focused on..."' : ''

    const FW_FIELDS = {
      MEDDIC:   ['Metrics','Economic Buyer','Decision Criteria','Decision Process','Identify Pain','Champion'],
      BANT:     ['Budget','Authority','Need','Timeline'],
      SPIN:     ['Situation','Problem','Implication','Need-Payoff'],
      LegalFly: ['Metrics','Economic Buyer','Decision Criteria','Decision Process','Identify Pain','Champion','Security and Anonymisation Wedge','Competitive Positioning','ICP and Qualification Fit'],
    }
    const FW_DESC = {
      MEDDIC: 'Metrics (quantifiable ROI/impact), Economic Buyer (ultimate decision maker identified and engaged), Decision Criteria (evaluation criteria mapped), Decision Process (buying steps and timeline understood), Identify Pain (critical business pain uncovered), Champion (internal advocate identified)',
      BANT:   'Budget (confirmed budget exists), Authority (speaking with or have access to decision maker), Need (genuine business need established), Timeline (purchase timeline agreed or realistic)',
      SPIN:   'Situation (context and background gathered), Problem (core problems identified), Implication (downstream consequences explored), Need-Payoff (value of solving the problem articulated)',
      // Verbatim from the LegalFly methodology doc (context block + the
      // MEDDIC backbone's six pillars, adapted to LegalFly + the three
      // always-on LegalFly-layer sections). Long by design — full mode
      // needs the complete rubric to score and justify all nine sections.
      LegalFly: `LegalFly is MEDDIC tuned to how LegalFly sells: the six MEDDIC pillars plus a LegalFly-specific layer of three sections. Score all nine sections listed below.

Context the scorer must use:
LEGALFLY is an agentic AI workspace built specifically for in-house corporate legal, compliance and procurement teams. Law firms are inbound only, not a direct-sales target. It provides more than a dozen specialised legal agents rather than a single chat tool. The main agents: Review (single-contract redlining against the client's own playbook, inside Microsoft Word), Multi Review (the same playbook review across hundreds of contracts at once, for due diligence, procurement and compliance), Drafting (turning signed contracts into smart templates), Discovery (sourced legal research and questions against the client's own documents), Legal Radar (regulatory monitoring by jurisdiction) and Translation. Native Microsoft Word and SharePoint integration, and purchasable via Microsoft Azure credits.

Unique selling points to reward when a rep uses them well: built for in-house teams rather than law firms; the only legal AI that fully anonymises all data before processing, with an on-premise option; LLM-agnostic, always routing to the best model; a complete agentic workspace rather than a point solution; and legally-trained AI that cites its sources to reduce hallucination. Treat security certifications (ISO 27001, SOC 2 Type II, GDPR) as table stakes. Anonymisation before processing is the structural wedge.

Proof points a strong rep can reference: contract review cut from about two hours to fifteen minutes, review time reduced by 50 to 80 percent, roughly 2.5 times faster review, an hour or more saved per research query. Customer stories include Agristo, ECS, Duvel and Adeera.

ICP: corporate in-house legal, compliance and procurement teams with complex, recurring legal workloads and an appetite for AI. Priority verticals: Insurance and Banking, Technology, Manufacturing. Segment: Enterprise. Minimum size: 200+ employees with at least a three-person legal team. Direct-sales geographies: Belgium, UK, Netherlands, Germany, Luxembourg, Switzerland, Saudi Arabia and UAE, with the US handled opportunistically. LEGALFLY is industry-agnostic overall, so fit is really about pain, AI maturity and team size. Primary buyers: General Counsel, Chief Legal Officer, Head of Legal, Legal Director. Secondary: Head of Procurement. A CIO, IT or Security lead is a common gatekeeper, and operational champions are usually Senior Legal Counsel or Legal Ops. Disqualifiers: a single part-time counsel, single-jurisdiction with low volume, or a hard budget freeze.

Industry nuance to weigh when judging pain and value. In Banking, the pain is high-volume NDAs, long multi-turn contracts and multi-stakeholder approvals, and the value is scaling legal capacity without headcount; deal-cycle-time language does not resonate because banks track risk, not speed. In Manufacturing and Transportation, the pain is multi-jurisdiction operations, slim margins and mounting regulation such as CSDDD, and cost efficiency resonates strongly. In Technology, the pain is legal being a blocker on fast-moving deals (a five-day review SLA), DPAs and evolving AI and data regulation such as DORA, and reducing external-counsel spend does not resonate.

Known selling rules to reward or penalise against:
- Ask about pain, do not assert it. Asserting high contract volume at a low-volume prospect is a known failure. Reward confirmed pain, penalise assumed pain.
- Balance talk time. The best LEGALFLY calls are conversations, not monologues, and prospect attention drops after 60 to 90 seconds of uninterrupted talking. Reward consultative, open-question discovery and penalise a rep who pitches over the prospect.
- Measure AI maturity. A strong discovery finds out whether the team already uses ChatGPT or Copilot and what concerns came up, because that shapes the security and accuracy positioning.
- On competitors, acknowledge honestly, ask a question that surfaces a real gap, then bridge to a differentiator, and never bash. Competitors fall into generalist AI (Copilot, ChatGPT), CLM or CMS (Icertis, Ironclad, Docusign CLM, ContractPodAI) and specialist legal AI (Luminance, Henchman, Definely, Wordsmith). Make anonymisation part of every competitive conversation. For Copilot, the Azure-credits reframe removes budget friction. Never claim a CLM cannot review against a playbook, since many now can; the real gaps are research, regulatory monitoring and anonymisation.
- The sophisticated data-privacy rebuttal is contractual control versus technical control: an enterprise AI agreement stops training on the data, but the personal data still leaves the environment; anonymising before processing removes it from scope.

MEDDIC pillars (backbone), scored against the LegalFly context above:
Metrics: Did the rep quantify the pain in business terms LEGALFLY can move (review time, backlog or volume, hours lost, external-counsel spend, procurement cycle time)? Green: a specific figure tied to a LEGALFLY outcome. Red: no attempt to size the problem.
Economic Buyer: Did the rep identify and ideally confirm who signs (GC, CLO, Head of Legal, Legal Director) and flag the security gatekeeper where relevant? Green: named the decision maker and their role. Red: engaged someone with no buying power and never found who decides.
Decision Criteria: Did the rep surface what the prospect will judge a tool on, especially where LEGALFLY is strong (anonymisation, research depth, workflow automation, Word and SharePoint fit, playbook customisation)? Green: explicit criteria captured. Red: none uncovered.
Decision Process: Did the rep map how the decision gets made and by when (security review, procurement, pilot, timeline) and secure a next step? Green: clear process and a concrete next step. Red: no process, no next step.
Identify Pain: Did the rep surface a real, confirmed LEGALFLY-relevant pain mapped to a use case? Green: a concrete pain the prospect confirmed. Red: pain asserted not confirmed, or a clear disqualifier.
Champion: Did the rep find or start to develop an internal advocate (often Senior Legal Counsel or Legal Ops)? Green: a likely champion and an action they will take internally. Red: a single contact with no path inward.

LegalFly layer (always on, score every call regardless of backbone):
Security and Anonymisation Wedge: Did the rep position LEGALFLY's core differentiator correctly? Green: raised anonymisation before processing as an architectural fact, not a policy promise, treated certifications as parity, and, if the prospect argued their enterprise AI agreement already covers privacy, landed the contractual-versus-technical-control rebuttal. Amber: mentioned security but generically, or leaned on certifications instead of anonymisation. Red: missed the wedge with a security-conscious buyer, got into a certifications contest, or overclaimed.
Competitive Positioning: If a competitor came up, did the rep acknowledge honestly, ask a gap-revealing question, and bridge to a differentiator without bashing? Green: handled to playbook. Amber: handled but flat, or leaned on a weak or false gap. Red: attacked the competitor, claimed a false gap (for example that a CLM cannot review against a playbook), or fought on lost ground. If no competitor arose, score amber and note it as unprobed.
ICP and Qualification Fit: Did the rep qualify against the ICP and screen for disqualifiers? Green: established in-house (not a law firm), industry, geography, company and legal-team size, dedicated legal leadership, multi-jurisdiction and Microsoft signals, and either advanced a good fit or disqualified a poor one with evidence. Amber: partial qualification. Red: pursued a clear disqualifier or never established fit.

Scoring notes: Weight the chosen backbone (MEDDIC) as the core of deal health. Treat the LegalFly layer as the mark of whether the rep is selling LegalFly well rather than just following a method. A call can be strong on the backbone yet weak on the wedge, and that gap is exactly the coaching a LegalFly manager wants to see. Always cite the specific line that justifies each score, and where a section is red, give one concrete, LegalFly-specific coaching action.`,
    }

    // LegalFly's full methodology above is long by design for full mode,
    // but quick mode only needs enough context to produce an honest
    // overall score + 2-3 sentence summary — sending the entire rubric
    // there would triple that call's input tokens for no benefit and
    // work against the concurrent-call token-volume budget (see
    // postToolCall's 429 handling above). Every other framework's
    // description is already short enough to use as-is for both modes.
    const FW_DESC_QUICK = {
      LegalFly: 'LegalFly is an agentic AI workspace for in-house corporate legal, compliance and procurement teams (not law firms) — contract redlining, multi-contract review, drafting, legal research, and regulatory monitoring, native to Microsoft Word/SharePoint, purchasable via Azure credits. Its structural differentiator is full anonymisation of data before processing, not just security certifications (which are table stakes). ICP: enterprise accounts (200+ employees, 3+ person legal team), priority verticals Insurance/Banking, Technology, Manufacturing; buyers are GC/CLO/Head of Legal/Legal Director. Score this call on a MEDDIC basis (metrics, economic buyer, decision criteria, decision process, pain, champion) and on whether the rep positioned the anonymisation wedge and qualified the prospect against this ICP.',
    }

    let sections, fwDesc, fwDescQuick
    if (framework === 'Custom') {
      sections = customFields.map(f => typeof f === 'object' ? f.name : f)
      const fieldLines = customFields.map((f, i) => {
        if (typeof f === 'object') return (i+1) + '. ' + f.name + ': ' + (f.desc || f.name)
        return (i+1) + '. ' + f
      }).join('\n')
      fwDesc = 'Custom framework:\n' + fieldLines
      fwDescQuick = fwDesc
    } else {
      sections = FW_FIELDS[framework]
      fwDesc = framework + ':\n' + FW_DESC[framework]
      fwDescQuick = FW_DESC_QUICK[framework] ? (framework + ' (context): ' + FW_DESC_QUICK[framework]) : fwDesc
    }

    const quickTool = {
      name: 'submit_quick_eval',
      description: 'Submit the quick evaluation score and summary for this sales call.',
      input_schema: {
        type: 'object',
        properties: {
          overall_score: { type: 'integer', description: 'Overall deal health, scored honestly 0-100' },
          summary: { type: 'string', description: 'Honest 2-3 sentence deal assessment' },
        },
        required: ['overall_score', 'summary'],
      },
    }

    // PROMPT CACHING (env PROMPT_CACHE=on; default off, in which case every
    // request below is exactly as it always was). When on, every call for one
    // evaluation — the quick pass and each full-mode batch — carries the SAME
    // prefix: identical `tools` (both tools, section names constrained to the
    // whole framework) and an identical `system` block holding the shared
    // instructions, the full framework definition and the transcript, with the
    // cache breakpoint on that block (so it sits after the transcript).
    // Only the short user message differs per call (quick instructions, or
    // "score only these sections: ..."). tool_choice still forces the right
    // tool per call; changing tool_choice does not invalidate the cached
    // tools + system prefix. Quick mode uses the full framework text here
    // (LegalFly's shorter quick-only summary would break the identical prefix).
    const cacheOn = process.env.PROMPT_CACHE === 'on'
    const MODEL = 'claude-haiku-4-5-20251001'
    const cachedSystem = () => [{
      type: 'text',
      text: [
        'You are an expert enterprise sales coach. Analyse the call transcript below. The instruction after the transcript says which tool to call.',
        '',
        'Framework: ' + fwDesc,
        dealName ? 'Deal: ' + dealName : '',
        persona ? 'People on the call: ' + persona : '',
        stageLine,
        '',
        'Transcript:',
        transcript,
      ].filter(Boolean).join('\n'),
      cache_control: { type: 'ephemeral' },
    }]
    const cachedSectionTool = () => ({
      name: 'submit_section_eval',
      description: 'Submit the structured section-by-section evaluation for this sales call.',
      input_schema: {
        type: 'object',
        properties: {
          sections: {
            type: 'array',
            uniqueItems: true,
            description: 'MUST be a JSON array of section objects — never a string, never an object. Exactly the sections named in the instruction, no more and no fewer.',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', enum: sections, description: 'Must be exactly one of the section names assigned in the instruction' },
                score: { type: 'integer', description: '0-100' },
                status: { type: 'string', enum: ['red', 'amber', 'green'], description: 'red=0-40, amber=41-70, green=71-100' },
                covered: { type: 'string', description: 'What was discussed, or "Not addressed" if absent' },
                gaps: { type: 'string', description: 'Specific gaps or missing information' },
                coaching: { type: 'string', description: 'One actionable coaching tip, tailored to personas if provided' },
                next_step: { type: 'string', description: 'One concrete next action' },
              },
              required: ['name', 'score', 'status', 'covered', 'gaps', 'coaching', 'next_step'],
            },
          },
          next_steps: { type: 'array', items: { type: 'string' }, description: 'Three concrete next actions for the deal overall (only when the instruction asks for them)' },
        },
        required: ['sections'],
      },
    })
    const cachedTools = () => [quickTool, cachedSectionTool()]

    // QUICK MODE — just score + summary, fast response
    if (mode === 'quick') {
      const quickPrompt = [
        'You are an expert enterprise sales coach. Analyse this call transcript and call submit_quick_eval with your assessment.',
        '',
        'Framework: ' + fwDescQuick,
        dealName ? 'Deal: ' + dealName : '',
        persona ? 'People on the call: ' + persona : '',
        stageLine,
        '',
        'Transcript:',
        transcript,
        '',
        'Be direct and specific. Score 0-100 honestly.'
      ].filter(Boolean).join('\n')

      console.log('Quick mode — framework:', framework)
      const quickPayload = cacheOn ? {
        model: MODEL,
        max_tokens: 500,
        tools: cachedTools(),
        system: cachedSystem(),
        tool_choice: { type: 'tool', name: 'submit_quick_eval' },
        messages: [{ role: 'user', content: 'Call submit_quick_eval with your assessment.\n\nBe direct and specific. Score 0-100 honestly.' }],
      } : {
        model: MODEL,
        max_tokens: 500,
        tools: [quickTool],
        tool_choice: { type: 'tool', name: 'submit_quick_eval' },
        messages: [{ role: 'user', content: quickPrompt }],
      }
      const quickResult = await postToolCall(quickPayload, 'Quick mode', startTime)

      // Discard the transcript now that the API call is done — it must not
      // be held in memory any longer than the request needs it for.
      transcript = null

      if (quickResult.error) {
        return { statusCode: 502, body: JSON.stringify({ error: quickResult.error }) }
      }

      // One evaluation counted per successful quick pass (never for the demo).
      if (profile && profile.known && profile.exists) {
        const counted = await bumpEvalCount(caller.id, profile)
        if (!counted) console.error('eval_count could not be incremented for user', caller.id)
      }

      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(quickResult.result),
      }
    }

    // FULL MODE — all sections, coaching, next steps.
    //
    // Measured directly against production: a single full-mode call over a
    // ~5.2k-word transcript (all 6 MEDDIC sections + next_steps in one
    // generation, up to 8000 output tokens) took 22-29s across repeated
    // runs — already flirting with, and sometimes exceeding, the 26s
    // Netlify sync-function ceiling set in netlify.toml. That ceiling is
    // Netlify's max for a synchronous function on this plan, so it can't
    // be raised further; the fix is to shrink the slowest call instead.
    //
    // Splitting section generation into two parallel calls (each covering
    // half the sections) roughly halves each call's completion length
    // without adding wall time, since they run concurrently — total time
    // becomes ~max(callA, callB) instead of one call generating everything.
    // Tool input_schema replaces the old hand-rolled JSON-in-prompt schema
    // — Anthropic validates/structures the output itself, so section text
    // fields (covered/gaps/coaching, which routinely contain the
    // prospect's own quoted words) can't break parsing the way free-text
    // JSON could.
    // secs' name enum is the actual fix for the "same 3 sections twice"
    // bug: with only a prompt instruction ("only evaluate these sections")
    // and no structural constraint, a model under load can default to the
    // same natural-feeling subset (the first few sections in the always-
    // fully-described framework) for BOTH parallel calls — the JS slicing
    // below is provably disjoint, but nothing stopped the model itself
    // from ignoring which slice it was assigned. Constraining `name` to an
    // enum of just this call's assigned sections makes that structurally
    // impossible instead of merely discouraged.
    const sectionToolSchema = (secs, includeNextSteps) => {
      const properties = {
        sections: {
          type: 'array',
          minItems: secs.length,
          maxItems: secs.length,
          uniqueItems: true,
          description: 'MUST be a JSON array of exactly ' + secs.length + ' section object' + (secs.length === 1 ? '' : 's') + ' — never a string, never an object, never any other length. One object per section name listed below, no more and no fewer.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', enum: secs, description: 'Must be exactly one of the assigned section names for this call' },
              score: { type: 'integer', description: '0-100' },
              status: { type: 'string', enum: ['red', 'amber', 'green'], description: 'red=0-40, amber=41-70, green=71-100' },
              covered: { type: 'string', description: 'What was discussed, or "Not addressed" if absent' },
              gaps: { type: 'string', description: 'Specific gaps or missing information' },
              coaching: { type: 'string', description: 'One actionable coaching tip, tailored to personas if provided' },
              next_step: { type: 'string', description: 'One concrete next action' },
            },
            required: ['name', 'score', 'status', 'covered', 'gaps', 'coaching', 'next_step'],
          },
        },
      }
      const required = ['sections']
      if (includeNextSteps) {
        properties.next_steps = { type: 'array', items: { type: 'string' }, description: 'Three concrete next actions for the deal overall' }
        required.push('next_steps')
      }
      return { type: 'object', properties, required }
    }

    const buildPrompt = (secs, includeNextSteps) => [
      'You are an expert enterprise sales coach. Analyse this call transcript and call submit_section_eval with your assessment.',
      '',
      'Framework: ' + fwDesc,
      dealName ? 'Deal: ' + dealName : '',
      persona ? 'People on the call: ' + persona + ' — tailor coaching tips to these specific personas.' : '',
      stageLine,
      '',
      'Transcript:',
      transcript,
      '',
      sections.length > secs.length
        ? 'Only evaluate these specific sections of the framework — a separate pass covers the rest: ' + secs.join(', ')
        : 'Evaluate these sections: ' + secs.join(', '),
      'Your submit_section_eval call must include exactly ' + secs.length + ' entries in the sections array — one per section listed above, no more and no fewer. The `sections` field itself must be a real array value, the way the tool schema defines it — never a string, and never a JSON-encoded/stringified version of the array.',
      '',
      'Be specific and honest' + (includeNextSteps ? ', and include three concrete next steps for the deal overall' : '') + '. If something was not in the transcript, say so clearly.'
    ].filter(Boolean).join('\n')

    // Split into N groups of at most 3 sections each, as evenly as
    // possible, rather than always exactly 2. Real production timing on
    // LegalFly (9 sections, a much longer framework description than
    // MEDDIC/BANT/SPIN) showed why a fixed 2-way split doesn't generalise:
    // 5+4 measured 25.7s, 27.1s, and one outright 504 at 31s across three
    // runs — group A's 5-section completion plus LegalFly's ~2000-token
    // context was intermittently blowing the 26s Netlify ceiling. Capping
    // each group at 3 sections keeps every call's output length (and thus
    // the slowest call's duration) roughly constant regardless of how many
    // sections the framework has.
    //
    // This exactly reproduces every existing framework's current split —
    // MEDDIC (6) and BANT/SPIN (4) already land on groups of 3 or 2 under
    // this rule, so their behaviour is unchanged. Only frameworks with
    // more than 6 sections (LegalFly's 9) actually get a 3rd group.
    //
    // Retrying failed sections: the browser may send `sections` (a subset
    // of this framework's section names) to re-score only those, e.g. after
    // one batch of a full pass failed. Same grouping rule, same prompts,
    // same tool schema as a normal full pass — just fewer sections. A
    // subset call only asks for next_steps when `includeNextSteps` is
    // true (the retry of the batch that was meant to produce them).
    let targetSections = sections
    const isSubsetCall = Array.isArray(onlySections) && onlySections.length > 0
    if (isSubsetCall) {
      const valid = onlySections.every(n => typeof n === 'string' && sections.includes(n)) && new Set(onlySections).size === onlySections.length
      if (!valid) {
        return { statusCode: 400, body: JSON.stringify({ error: 'invalid_sections' }) }
      }
      targetSections = sections.filter(n => onlySections.includes(n))
    }
    const CHUNK_SIZE = 3
    const numGroups = Math.max(1, Math.ceil(targetSections.length / CHUNK_SIZE))
    const groupSize = Math.ceil(targetSections.length / numGroups)
    const groups = []
    for (let i = 0; i < numGroups; i++) {
      const g = targetSections.slice(i * groupSize, (i + 1) * groupSize)
      if (g.length) groups.push(g)
    }

    console.log('Full mode — framework:', framework, 'transcript length:', transcript.length, 'split:', groups.map(g => g.length).join('+'))

    const sectionTool = (secs, includeNextSteps) => ({
      name: 'submit_section_eval',
      description: 'Submit the structured section-by-section evaluation for this sales call.',
      input_schema: sectionToolSchema(secs, includeNextSteps),
    })

    // Only the last group is asked for next_steps — one "deal overall"
    // list, not one per group. max_tokens raised from 4000 to 5000: real
    // production testing on LegalFly (content-rich sections — proof
    // points, named competitors, rebuttals — genuinely need more room
    // than MEDDIC's terser style) intermittently returned a truncated/
    // empty sections array under the old ceiling. The extra headroom only
    // matters when a call actually needs it; it doesn't add latency to
    // calls that don't.
    // Mode-specific user message for a cached call (the part after the cache breakpoint).
    const cachedBatchInstruction = (secs, includeNextSteps) => [
      'Call submit_section_eval with your assessment.',
      '',
      sections.length > secs.length
        ? 'Only evaluate these specific sections of the framework — a separate pass covers the rest: ' + secs.join(', ')
        : 'Evaluate these sections: ' + secs.join(', '),
      'Your submit_section_eval call must include exactly ' + secs.length + ' entries in the sections array — one per section listed above, no more and no fewer. The `sections` field itself must be a real array value, the way the tool schema defines it — never a string, and never a JSON-encoded/stringified version of the array.',
      persona ? 'Tailor coaching tips to the specific personas on the call.' : '',
      '',
      'Be specific and honest' + (includeNextSteps ? ', and include three concrete next steps for the deal overall in next_steps' : '') + '. If something was not in the transcript, say so clearly.'
    ].filter(Boolean).join('\n')

    const runGroup = (secs, i, onStart) => {
      const includeNextSteps = i === groups.length - 1 && (!isSubsetCall || wantNextSteps === true)
      const label = 'Full mode (group ' + (i + 1) + '/' + groups.length + ')'
      if (cacheOn) {
        return postToolCall({
          model: MODEL,
          max_tokens: 5000,
          tools: cachedTools(),
          system: cachedSystem(),
          tool_choice: { type: 'tool', name: 'submit_section_eval' },
          messages: [{ role: 'user', content: cachedBatchInstruction(secs, includeNextSteps) }],
        }, label, startTime, secs.length, { onStart: onStart, expectedNames: secs })
      }
      return postToolCall({
        model: MODEL,
        max_tokens: 5000,
        tools: [sectionTool(secs, includeNextSteps)],
        tool_choice: { type: 'tool', name: 'submit_section_eval' },
        messages: [{ role: 'user', content: buildPrompt(secs, includeNextSteps) }],
      }, label, startTime, secs.length)
    }

    let results
    if (cacheOn && groups.length > 1 && transcript.length <= CACHE_STAGGER_MAX_CHARS) {
      // A cache entry only becomes readable once the request that writes it has
      // begun responding, so launch the first batch, give it up to ~1s to start
      // (or until its response begins), then launch the rest so they can read
      // the shared prefix instead of each writing their own. For very long
      // transcripts the stagger is skipped so the total stays inside the time
      // budget (accepting fewer cache hits).
      let started
      const startedP = new Promise(resolve => { started = resolve })
      const first = runGroup(groups[0], 0, started)
      await Promise.race([startedP, new Promise(resolve => setTimeout(resolve, CACHE_STAGGER_MS))])
      const rest = groups.slice(1).map((secs, k) => runGroup(secs, k + 1))
      results = await Promise.all([first].concat(rest))
    } else {
      results = await Promise.all(groups.map((secs, i) => runGroup(secs, i)))
    }

    // A full pass that was allowed gets a retry token for this exact user,
    // transcript and framework (see retry tokens above). Never for the demo.
    const retryTokenOut = (caller && !isDemo && !isRetryCall) ? issueRetryToken(caller.id, transcript, framework) : null

    // Discard the transcript now that the API calls are done — it must not
    // be held in memory any longer than the request needs it for.
    transcript = null

    const callErrors = results.map(r => r.error).filter(Boolean)

    // Merge into canonical framework order, deduping by name (first
    // occurrence wins). Never save a duplicated record: a section is either
    // present exactly once or reported as failed. A group whose `sections`
    // is not actually an array contributes nothing.
    const byName = {}
    results.forEach(r => {
      const secs = r.result && Array.isArray(r.result.sections) ? r.result.sections : []
      secs.forEach(s => {
        if (s && s.name && !byName[s.name]) byName[s.name] = s
      })
    })

    const mergedSections = targetSections.map(name => byName[name]).filter(Boolean)
    const failedNames = targetSections.filter(name => !byName[name])

    // Nothing usable at all: same 502 as before, so the browser's existing
    // retry-once-on-502 still applies.
    if (mergedSections.length === 0) {
      if (callErrors.length) {
        return { statusCode: 502, body: JSON.stringify({ error: callErrors.join(' | ') }) }
      }
      console.error('Full mode merge incomplete — missing:', failedNames.join(', '))
      return {
        statusCode: 502,
        body: JSON.stringify({ error: 'Evaluation incomplete — missing section(s): ' + failedNames.join(', ') + '. Please try again.' }),
      }
    }

    const lastResult = results[results.length - 1].result
    const lastNextSteps = lastResult ? lastResult.next_steps : undefined
    const merged = {
      sections: mergedSections,
      next_steps: Array.isArray(lastNextSteps) ? lastNextSteps : [],
    }

    // Partial result: some batches loaded, some did not. Return what loaded
    // (HTTP 200) plus which sections to retry. A complete result has exactly
    // the same fields as always.
    if (failedNames.length) {
      console.error('Full mode partial — failed section(s):', failedNames.join(', '))
      merged.failed_sections = failedNames
      merged.needs_next_steps = !lastResult
    }
    if (retryTokenOut) merged.retry_token = retryTokenOut

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(merged),
    }

  } catch (err) {
    console.error('Function error:', err.message)
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) }
  }
}