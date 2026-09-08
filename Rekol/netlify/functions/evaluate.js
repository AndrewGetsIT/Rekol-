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
      MEDDIC: ['Metrics','Economic Buyer','Decision Criteria','Decision Process','Identify Pain','Champion'],
      BANT:   ['Budget','Authority','Need','Timeline'],
      SPIN:   ['Situation','Problem','Implication','Need-Payoff'],
    }
    const FW_DESC = {
      MEDDIC: 'Metrics (quantifiable ROI/impact), Economic Buyer (ultimate decision maker identified and engaged), Decision Criteria (evaluation criteria mapped), Decision Process (buying steps and timeline understood), Identify Pain (critical business pain uncovered), Champion (internal advocate identified)',
      BANT:   'Budget (confirmed budget exists), Authority (speaking with or have access to decision maker), Need (genuine business need established), Timeline (purchase timeline agreed or realistic)',
      SPIN:   'Situation (context and background gathered), Problem (core problems identified), Implication (downstream consequences explored), Need-Payoff (value of solving the problem articulated)',
    }

    let sections, fwDesc
    if (framework === 'Custom') {
      sections = customFields.map(f => typeof f === 'object' ? f.name : f)
      const fieldLines = customFields.map((f, i) => {
        if (typeof f === 'object') return (i+1) + '. ' + f.name + ': ' + (f.desc || f.name)
        return (i+1) + '. ' + f
      }).join('\n')
      fwDesc = 'Custom framework:\n' + fieldLines
    } else {
      sections = FW_FIELDS[framework]
      fwDesc = framework + ':\n' + FW_DESC[framework]
    }

    // QUICK MODE — just score + summary, fast response
    if (mode === 'quick') {
      const quickPrompt = [
        'You are an expert enterprise sales coach. Analyse this call transcript and call submit_quick_eval with your assessment.',
        '',
        'Framework: ' + fwDesc,
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

    // Only split when there's more than one section to split — a
    // single-field custom framework just runs one call as before.
    const mid = Math.ceil(sections.length / 2)
    const groupA = sections.length > 1 ? sections.slice(0, mid) : sections
    const groupB = sections.length > 1 ? sections.slice(mid) : []

    console.log('Full mode — framework:', framework, 'transcript length:', transcript.length, 'split:', groupA.length, '+', groupB.length)

    const sectionTool = (secs, includeNextSteps) => ({
      name: 'submit_section_eval',
      description: 'Submit the structured section-by-section evaluation for this sales call.',
      input_schema: sectionToolSchema(secs, includeNextSteps),
    })

    const calls = [
      postToolCall({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 4000,
        tools: [sectionTool(groupA, groupB.length === 0)],
        tool_choice: { type: 'tool', name: 'submit_section_eval' },
        messages: [{ role: 'user', content: buildPrompt(groupA, groupB.length === 0) }],
      }, 'Full mode (A)', startTime),
    ]
    if (groupB.length) {
      calls.push(postToolCall({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 4000,
        tools: [sectionTool(groupB, true)],
        tool_choice: { type: 'tool', name: 'submit_section_eval' },
        messages: [{ role: 'user', content: buildPrompt(groupB, true) }],
      }, 'Full mode (B)', startTime))
    }
    const [resultA, resultB] = await Promise.all(calls)

    // Discard the transcript now that the API calls are done — it must not
    // be held in memory any longer than the request needs it for.
    transcript = null

    if (resultA.error || (resultB && resultB.error)) {
      const errors = [resultA.error, resultB && resultB.error].filter(Boolean)
      return { statusCode: 502, body: JSON.stringify({ error: errors.join(' | ') }) }
    }

    // Merge into canonical framework order, deduping by name (first
    // occurrence wins) — this is the second half of the fix: even with the
    // schema enum above, don't trust the two halves to be well-formed.
    // Prospect B's eval returned Metrics/Economic Buyer/Decision Criteria
    // twice and silently dropped Decision Process/Identify Pain/Champion;
    // a blind concat would reproduce that. Rather than save a partial or
    // duplicated record, treat an incomplete merge as a failed eval so the
    // AE re-runs instead of getting a silently wrong one.
    const byName = {}
    const collect = (result) => {
      if (!result) return
      ;(result.sections || []).forEach(s => {
        if (s && s.name && !byName[s.name]) byName[s.name] = s
      })
    }
    collect(resultA.result)
    collect(resultB && resultB.result)

    const mergedSections = sections.map(name => byName[name]).filter(Boolean)

    if (mergedSections.length !== sections.length) {
      const missing = sections.filter(name => !byName[name])
      console.error('Full mode merge incomplete — missing:', missing.join(', '))
      return {
        statusCode: 502,
        body: JSON.stringify({ error: 'Evaluation incomplete — missing section(s): ' + missing.join(', ') + '. Please try again.' }),
      }
    }

    const merged = {
      sections: mergedSections,
      next_steps: (resultB ? resultB.result : resultA.result).next_steps || [],
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