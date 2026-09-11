const https = require('https')

function post(data) {
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
// Returns { result } on success (already a parsed object — no further
// parsing needed by the caller), or { error, status } otherwise — error is
// a human-readable string that includes Anthropic's real status/body so
// failures are visible in the response itself, not just in server logs we
// have no way to read from here.
async function postToolCall(payload, label, startTime) {
  let attempt = 0
  while (true) {
    attempt++
    let response
    try {
      response = await post(payload)
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
      const toolUse = (data.content || []).find(c => c.type === 'tool_use')
      if (!toolUse || typeof toolUse.input !== 'object' || toolUse.input === null) {
        throw new Error('No tool_use result in response (stop_reason: ' + data.stop_reason + ')')
      }
      return { result: toolUse.input }
    } catch (e) {
      console.error(label + ' malformed tool response (attempt ' + attempt + '):', e.message)
      const elapsed = Date.now() - startTime
      if (attempt >= 2 || elapsed >= 4000) {
        return { error: label + ' — returned no valid structured result: ' + e.message, status: response.status }
      }
      // one retry allowed — still within the time budget, loop again
    }
  }
}

exports.handler = async function (event) {
  const startTime = Date.now()
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' }

  try {
    let { transcript, framework, customFields, dealName, persona, mode, dealStage } = JSON.parse(event.body)
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

      console.log('Quick mode — framework:', framework)
      const quickResult = await postToolCall({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 500,
        tools: [quickTool],
        tool_choice: { type: 'tool', name: 'submit_quick_eval' },
        messages: [{ role: 'user', content: quickPrompt }],
      }, 'Quick mode', startTime)

      // Discard the transcript now that the API call is done — it must not
      // be held in memory any longer than the request needs it for.
      transcript = null

      if (quickResult.error) {
        return { statusCode: 502, body: JSON.stringify({ error: quickResult.error }) }
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
    const CHUNK_SIZE = 3
    const numGroups = Math.max(1, Math.ceil(sections.length / CHUNK_SIZE))
    const groupSize = Math.ceil(sections.length / numGroups)
    const groups = []
    for (let i = 0; i < numGroups; i++) {
      const g = sections.slice(i * groupSize, (i + 1) * groupSize)
      if (g.length) groups.push(g)
    }

    console.log('Full mode — framework:', framework, 'transcript length:', transcript.length, 'split:', groups.map(g => g.length).join('+'))

    const sectionTool = (secs, includeNextSteps) => ({
      name: 'submit_section_eval',
      description: 'Submit the structured section-by-section evaluation for this sales call.',
      input_schema: sectionToolSchema(secs, includeNextSteps),
    })

    // Only the last group is asked for next_steps — one "deal overall"
    // list, not one per group.
    const calls = groups.map((secs, i) => {
      const includeNextSteps = i === groups.length - 1
      return postToolCall({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 4000,
        tools: [sectionTool(secs, includeNextSteps)],
        tool_choice: { type: 'tool', name: 'submit_section_eval' },
        messages: [{ role: 'user', content: buildPrompt(secs, includeNextSteps) }],
      }, 'Full mode (group ' + (i + 1) + '/' + groups.length + ')', startTime)
    })
    const results = await Promise.all(calls)

    // Discard the transcript now that the API calls are done — it must not
    // be held in memory any longer than the request needs it for.
    transcript = null

    const callErrors = results.map(r => r.error).filter(Boolean)
    if (callErrors.length) {
      return { statusCode: 502, body: JSON.stringify({ error: callErrors.join(' | ') }) }
    }

    // Merge into canonical framework order, deduping by name (first
    // occurrence wins) — this is the second half of the fix: even with the
    // schema enum above, don't trust every group to be well-formed.
    // Prospect B's eval once returned Metrics/Economic Buyer/Decision
    // Criteria twice and silently dropped the rest; a blind concat would
    // reproduce that. Rather than save a partial or duplicated record,
    // treat an incomplete merge as a failed eval so the AE re-runs instead
    // of getting a silently wrong one.
    // Defensive: the tool schema declares `sections` as an array, but that
    // describes intent, not a runtime guarantee — a malformed generation
    // could still hand back something else (null, a string, an object).
    // Treat anything that isn't actually an array as "this group
    // contributed nothing" rather than crashing .forEach on it; the
    // completeness guard below then does its job and surfaces a clear
    // "missing section(s)" 502 instead of an opaque 500.
    const byName = {}
    results.forEach(r => {
      const secs = r.result && Array.isArray(r.result.sections) ? r.result.sections : []
      secs.forEach(s => {
        if (s && s.name && !byName[s.name]) byName[s.name] = s
      })
    })

    const mergedSections = sections.map(name => byName[name]).filter(Boolean)

    if (mergedSections.length !== sections.length) {
      const missing = sections.filter(name => !byName[name])
      console.error('Full mode merge incomplete — missing:', missing.join(', '))
      return {
        statusCode: 502,
        body: JSON.stringify({ error: 'Evaluation incomplete — missing section(s): ' + missing.join(', ') + '. Please try again.' }),
      }
    }

    const lastNextSteps = results[results.length - 1].result.next_steps
    const merged = {
      sections: mergedSections,
      next_steps: Array.isArray(lastNextSteps) ? lastNextSteps : [],
    }

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