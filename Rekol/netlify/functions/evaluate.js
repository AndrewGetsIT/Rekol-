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

// Strips markdown fences and any stray text outside the outermost {...} —
// recovers most "malformed JSON" responses without needing a re-call.
function cleanJson(text) {
  let cleaned = text.replace(/```json|```/g, '').trim()
  const firstBrace = cleaned.indexOf('{')
  const lastBrace = cleaned.lastIndexOf('}')
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    cleaned = cleaned.slice(firstBrace, lastBrace + 1)
  }
  return cleaned
}

// Calls the Anthropic API and, if the response isn't valid JSON, retries
// once more — but only if we're still well within Netlify's 10s sync
// function limit. A server-side retry re-runs a 5-8s Haiku call, so a
// second retry (or a retry started late) risks a 504 instead of fixing
// anything; in that case we fail fast so the client can retry with a
// fresh 10s window instead.
// Returns { raw } on success, or { error } otherwise.
async function postAndParse(payload, label, startTime) {
  let attempt = 0
  while (true) {
    attempt++
    const response = await post(payload)

    if (response.status !== 200) {
      console.error(label + ' Anthropic error:', response.body)
      return { error: 'AI service error' }
    }

    const data = JSON.parse(response.body)
    const raw = cleanJson(data.content[0].text)

    try {
      JSON.parse(raw)
      return { raw }
    } catch (e) {
      console.error(label + ' malformed JSON (attempt ' + attempt + '):', e.message)
      const elapsed = Date.now() - startTime
      if (attempt >= 2 || elapsed >= 4000) {
        return { error: 'parse_failed' }
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
        'You are an expert enterprise sales coach. Analyse this call transcript.',
        '',
        'Framework: ' + fwDesc,
        dealName ? 'Deal: ' + dealName : '',
        persona ? 'People on the call: ' + persona : '',
        stageLine,
        '',
        'Transcript:',
        transcript,
        '',
        'Return ONLY valid JSON, no markdown, no backticks:',
        '{"overall_score":<0-100>,"summary":"<honest 2-3 sentence deal assessment>"}',
        '',
        'Be direct and specific. Score 0-100 honestly.'
      ].filter(Boolean).join('\n')

      console.log('Quick mode — framework:', framework)
      const quickResult = await postAndParse({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 500,
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
        body: quickResult.raw,
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
    const secSchema = (secs) => secs.map(s => JSON.stringify({
      name: s,
      score: '<0-100>',
      status: '<red|amber|green>',
      covered: '<what was discussed, or Not addressed if absent>',
      gaps: '<specific gaps or missing information>',
      coaching: '<one actionable coaching tip tailored to personas if provided>',
      next_step: '<one concrete next action>'
    })).join(',\n')

    const buildPrompt = (secs, includeNextSteps) => [
      'You are an expert enterprise sales coach. Analyse this call transcript and return a structured evaluation as JSON.',
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
        : '',
      '',
      'Return ONLY valid JSON, no markdown, no backticks:',
      '{"sections":[' + secSchema(secs) + ']' + (includeNextSteps ? ',"next_steps":["<step 1>","<step 2>","<step 3>"]' : '') + '}',
      '',
      'Scoring: red=0-40, amber=41-70, green=71-100. Be specific and honest. If something was not in the transcript, say so clearly.'
    ].filter(Boolean).join('\n')

    // Only split when there's more than one section to split — a
    // single-field custom framework just runs one call as before.
    const mid = Math.ceil(sections.length / 2)
    const groupA = sections.length > 1 ? sections.slice(0, mid) : sections
    const groupB = sections.length > 1 ? sections.slice(mid) : []

    console.log('Full mode — framework:', framework, 'transcript length:', transcript.length, 'split:', groupA.length, '+', groupB.length)

    const calls = [
      postAndParse({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 4000,
        messages: [{ role: 'user', content: buildPrompt(groupA, groupB.length === 0) }],
      }, 'Full mode (A)', startTime),
    ]
    if (groupB.length) {
      calls.push(postAndParse({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 4000,
        messages: [{ role: 'user', content: buildPrompt(groupB, true) }],
      }, 'Full mode (B)', startTime))
    }
    const [resultA, resultB] = await Promise.all(calls)

    // Discard the transcript now that the API calls are done — it must not
    // be held in memory any longer than the request needs it for.
    transcript = null

    if (resultA.error || (resultB && resultB.error)) {
      return { statusCode: 502, body: JSON.stringify({ error: resultA.error || resultB.error }) }
    }

    let merged
    try {
      const parsedA = JSON.parse(resultA.raw)
      const parsedB = resultB ? JSON.parse(resultB.raw) : null
      merged = {
        sections: (parsedA.sections || []).concat(parsedB ? (parsedB.sections || []) : []),
        next_steps: (parsedB || parsedA).next_steps || [],
      }
    } catch (e) {
      console.error('Full mode merge failed:', e.message)
      return { statusCode: 502, body: JSON.stringify({ error: 'parse_failed' }) }
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