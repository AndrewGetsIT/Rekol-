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
    req.on('error', (err) => {
      console.error('HTTPS request error:', err)
      reject(err)
    })
    req.setTimeout(25000, () => {
      console.error('Request timed out')
      req.destroy()
      reject(new Error('Request timed out'))
    })
    req.write(body)
    req.end()
  })
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' }
  }

  try {
    console.log('Function started')
    console.log('API key present:', !!process.env.ANTHROPIC_API_KEY)
    console.log('API key prefix:', process.env.ANTHROPIC_API_KEY ? process.env.ANTHROPIC_API_KEY.substring(0, 10) : 'MISSING')

    const { transcript, framework, customFields, dealName, persona } = JSON.parse(event.body)
    console.log('Framework:', framework)
    console.log('Transcript length:', transcript ? transcript.length : 0)

    const FW_FIELDS = {
      MEDDIC: ['Metrics', 'Economic Buyer', 'Decision Criteria', 'Decision Process', 'Identify Pain', 'Champion'],
      BANT:   ['Budget', 'Authority', 'Need', 'Timeline'],
      SPIN:   ['Situation', 'Problem', 'Implication', 'Need-Payoff'],
    }

    const FW_DESC = {
      MEDDIC: 'Metrics (quantifiable ROI/impact), Economic Buyer (ultimate decision maker identified and engaged), Decision Criteria (evaluation criteria mapped), Decision Process (buying steps and timeline understood), Identify Pain (critical business pain uncovered), Champion (internal advocate identified)',
      BANT:   'Budget (confirmed budget exists), Authority (speaking with or have access to decision maker), Need (genuine business need established), Timeline (purchase timeline agreed or realistic)',
      SPIN:   'Situation (context and background gathered), Problem (core problems identified), Implication (downstream consequences explored), Need-Payoff (value of solving the problem articulated)',
    }

    const sections = framework === 'Custom' ? customFields : FW_FIELDS[framework]
    const fwDesc = framework === 'Custom'
      ? `Custom framework:\n${customFields.map((f, i) => `${i + 1}. ${f}`).join('\n')}`
      : `${framework}:\n${FW_DESC[framework]}`

    const secSchema = sections.map(s => `{
  "name": "${s}",
  "score": <0-100>,
  "status": "<red|amber|green>",
  "covered": "<what was discussed, or Not addressed if absent>",
  "gaps": "<specific gaps or missing information>",
  "coaching": "<one actionable coaching tip>",
  "next_step": "<one concrete next action>"
}`).join(',\n')

    const prompt = `You are an expert enterprise sales coach. Analyse this call transcript and return a structured evaluation as JSON.

Framework: ${fwDesc}
${dealName ? `Deal: ${dealName}` : ''}
${persona ? `People on the call: ${persona}` : ''}

Transcript:
${transcript}

Return ONLY valid JSON, no markdown, no backticks:
{
  "overall_score": <0-100>,
  "summary": "<honest 2-3 sentence deal assessment>",
  "sections": [${secSchema}],
  "next_steps": ["<step 1>", "<step 2>", "<step 3>"]
}

Scoring: red = 0-40, amber = 41-70, green = 71-100. Be specific and honest.`

    console.log('Calling Anthropic API...')
    const response = await post({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }],
    })

    console.log('Anthropic response status:', response.status)
    console.log('Anthropic response body:', response.body.substring(0, 200))

    if (response.status !== 200) {
      console.error('Anthropic error:', response.body)
      return { statusCode: 502, body: JSON.stringify({ error: 'AI service error: ' + response.body }) }
    }

    const data = JSON.parse(response.body)
    const raw = data.content[0].text.replace(/```json|```/g, '').trim()
    const result = JSON.parse(raw)

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(result),
    }

  } catch (err) {
    console.error('Function error:', err.message)
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    }
  }
}
