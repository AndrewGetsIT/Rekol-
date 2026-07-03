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
    const { dealName, persona, fw, sections, next_steps } = JSON.parse(event.body)

    if (!sections || !sections.length) {
      return { statusCode: 400, body: JSON.stringify({ error: 'No evaluation sections provided' }) }
    }

    const gapLines = sections
      .slice()
      .sort((a, b) => a.score - b.score)
      .slice(0, 3)
      .map((s, i) => (i + 1) + '. ' + s.name + ' (scored ' + s.score + '/100) — Gaps: ' + (s.gaps || 'Not addressed') + '. Coaching tip: ' + (s.coaching || ''))
      .join('\n')

    const prompt = [
      'You are an expert enterprise sales coach helping an AE turn a call evaluation into concrete next actions.',
      '',
      'Framework: ' + fw,
      dealName ? 'Deal: ' + dealName : '',
      persona ? 'People on the call: ' + persona : '',
      '',
      'Top gaps identified from the evaluation:',
      gapLines,
      '',
      next_steps && next_steps.length ? 'Suggested next steps from the evaluation:\n' + next_steps.map(s => '- ' + s).join('\n') : '',
      '',
      'Generate two things:',
      '1. A follow-up email draft from the AE to the buyer(s), personalised to the deal name and personas if given, that addresses the top 2-3 gaps above without sounding like a checklist — natural, concise, sales-appropriate tone.',
      '2. A next-call script: 3-5 open-ended opening questions the AE should ask on the next call to close the specific gaps identified above.',
      '',
      'Return ONLY valid JSON, no markdown, no backticks:',
      '{"email":"<full email draft with line breaks as \\n, including a subject line>","script":"<3-5 numbered questions with line breaks as \\n, each with a one-line note on why it closes the gap>"}'
    ].filter(Boolean).join('\n')

    console.log('Practice mode — framework:', fw)
    const response = await post({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }],
    })

    if (response.status !== 200) {
      console.error('Anthropic practice error:', response.body)
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
