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

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' }

  try {
    const { transcript, framework, customFields, dealName, persona, mode } = JSON.parse(event.body)

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
      const response = await post({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        messages: [{ role: 'user', content: quickPrompt }],
      })

      if (response.status !== 200) {
        console.error('Anthropic quick error:', response.body)
        return { statusCode: 502, body: JSON.stringify({ error: 'AI service error' }) }
      }

      const data = JSON.parse(response.body)
      const raw = data.content[0].text.replace(/```json|```/g, '').trim()
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: raw,
      }
    }

    // FULL MODE — all sections, coaching, next steps
    const secSchema = sections.map(s => JSON.stringify({
      name: s,
      score: '<0-100>',
      status: '<red|amber|green>',
      covered: '<what was discussed, or Not addressed if absent>',
      gaps: '<specific gaps or missing information>',
      coaching: '<one actionable coaching tip tailored to personas if provided>',
      next_step: '<one concrete next action>'
    })).join(',\n')

    const fullPrompt = [
      'You are an expert enterprise sales coach. Analyse this call transcript and return a structured evaluation as JSON.',
      '',
      'Framework: ' + fwDesc,
      dealName ? 'Deal: ' + dealName : '',
      persona ? 'People on the call: ' + persona + ' — tailor coaching tips to these specific personas.' : '',
      '',
      'Transcript:',
      transcript,
      '',
      'Return ONLY valid JSON, no markdown, no backticks:',
      '{"sections":[' + secSchema + '],"next_steps":["<step 1>","<step 2>","<step 3>"]}',
      '',
      'Scoring: red=0-40, amber=41-70, green=71-100. Be specific and honest. If something was not in the transcript, say so clearly.'
    ].filter(Boolean).join('\n')

    console.log('Full mode — framework:', framework, 'transcript length:', transcript.length)
    const response = await post({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4000,
      messages: [{ role: 'user', content: fullPrompt }],
    })

    console.log('Response status:', response.status)
    if (response.status !== 200) {
      console.error('Anthropic full error:', response.body)
      return { statusCode: 502, body: JSON.stringify({ error: 'AI service error' }) }
    }

    const data = JSON.parse(response.body)
    const raw = data.content[0].text.replace(/```json|```/g, '').trim()
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: raw,
    }

  } catch (err) {
    console.error('Function error:', err.message)
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) }
  }
}