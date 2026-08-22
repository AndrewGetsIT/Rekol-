const https = require('https')

const SUPA_HOST = 'iqdnmlzamqqskfjysfzg.supabase.co'
const SUPA_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlxZG5tbHphbXFxc2tmanlzZnpnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYzNTU3NTMsImV4cCI6MjA5MTkzMTc1M30.bYFx7o_Cvr8SoLPHO_dlguOZ9x7bX9ekf_IIDUSbIYo'

function supabaseRequest(method, path, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null
    const headers = Object.assign({
      'Content-Type': 'application/json',
      'apikey': process.env.SUPABASE_SERVICE_KEY,
      'Authorization': 'Bearer ' + process.env.SUPABASE_SERVICE_KEY,
    }, extraHeaders || {})
    if (data) headers['Content-Length'] = Buffer.byteLength(data)
    const options = { hostname: SUPA_HOST, path: path, method: method, headers: headers }
    const req = https.request(options, (res) => {
      let raw = ''
      res.on('data', chunk => raw += chunk)
      res.on('end', () => resolve({ status: res.statusCode, body: raw }))
    })
    req.on('error', reject)
    if (data) req.write(data)
    req.end()
  })
}

// Verifies a Supabase access token by asking Supabase Auth who it belongs
// to. Returns the user object ({id, email, user_metadata, ...}) or null.
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

function anthropicPost(data) {
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
    req.on('error', (err) => reject(err))
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('Timeout')) })
    req.write(body)
    req.end()
  })
}

// One tight Haiku call: aggregate section averages in, a short coaching
// paragraph out. Never fed raw transcripts, quotes, or per-eval text —
// only {name, avgScore} pairs. Failure here should never break the
// dashboard, so callers should treat a thrown error as "no brief".
async function generateCoachingBrief(sectionAggregates) {
  const lines = sectionAggregates
    .slice()
    .sort((a, b) => a.avgScore - b.avgScore)
    .map(s => s.name + ': avg ' + s.avgScore + '/100, red in ' + s.redCount + ' of ' + s.totalCount + ' evaluations')
    .join('\n')

  const prompt = [
    'You are a sales enablement lead preparing a short brief for a sales manager ahead of their next team meeting.',
    'Below are this team\'s average scores per framework section, aggregated across all their recent call evaluations (lowest first):',
    '',
    lines,
    '',
    'Write a 3-4 sentence brief naming the weakest area(s) and a concrete focus for the next team meeting. Be direct and specific. Do not use markdown, headings, or bullet points — plain prose only.'
  ].join('\n')

  const response = await anthropicPost({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 220,
    messages: [{ role: 'user', content: prompt }],
  })

  if (response.status !== 200) throw new Error('Anthropic error: ' + response.body)
  const data = JSON.parse(response.body)
  return data.content[0].text.trim()
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' }

  try {
    const caller = await verifyUser(event.headers.authorization || event.headers.Authorization)
    if (!caller) return { statusCode: 401, body: JSON.stringify({ error: 'Not signed in' }) }

    const { teamId, rangeDays } = JSON.parse(event.body || '{}')
    const range = Number(rangeDays) > 0 ? Number(rangeDays) : 30
    if (!teamId) return { statusCode: 400, body: JSON.stringify({ error: 'Missing teamId' }) }

    // Ownership check — the only gate that matters here. Everything below
    // reads via the service key, which bypasses evaluations' RLS entirely,
    // so this check IS the security boundary for this endpoint.
    const teamRes = await supabaseRequest('GET', '/rest/v1/teams?id=eq.' + encodeURIComponent(teamId) + '&select=id,name,owner_id', null)
    if (teamRes.status !== 200) return { statusCode: 502, body: JSON.stringify({ error: 'Could not look up team' }) }
    const teamRows = JSON.parse(teamRes.body)
    if (!teamRows.length || teamRows[0].owner_id !== caller.id) {
      return { statusCode: 403, body: JSON.stringify({ error: 'You do not own this team' }) }
    }
    const team = teamRows[0]

    const membersRes = await supabaseRequest(
      'GET',
      '/rest/v1/team_members?team_id=eq.' + encodeURIComponent(teamId) + '&status=eq.active&select=user_id,joined_at',
      null
    )
    if (membersRes.status !== 200) return { statusCode: 502, body: JSON.stringify({ error: 'Could not load team members' }) }
    const activeMembers = JSON.parse(membersRes.body)

    const emptyPayload = {
      team: { id: team.id, name: team.name },
      rangeDays: range,
      memberCount: activeMembers.length,
      teamStats: { evalCount: 0, avgScore: null, trend: [] },
      sectionAggregates: [],
      aeSummaries: [],
      coachingBrief: null,
    }

    if (!activeMembers.length) {
      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(emptyPayload) }
    }

    const userIds = activeMembers.map(m => m.user_id)
    const profilesRes = await supabaseRequest(
      'GET',
      '/rest/v1/profiles?id=in.(' + userIds.map(encodeURIComponent).join(',') + ')&select=id,name,email',
      null
    )
    const profiles = profilesRes.status === 200 ? JSON.parse(profilesRes.body) : []
    const nameById = {}
    profiles.forEach(p => { nameById[p.id] = p.name || p.email })

    const cutoff = new Date(Date.now() - range * 24 * 60 * 60 * 1000).toISOString()
    const evalsRes = await supabaseRequest(
      'GET',
      '/rest/v1/evaluations?user_id=in.(' + userIds.map(encodeURIComponent).join(',') +
        ')&created_at=gte.' + encodeURIComponent(cutoff) +
        '&select=user_id,fw,overall_score,sections,created_at&order=created_at.asc',
      null
    )
    if (evalsRes.status !== 200) return { statusCode: 502, body: JSON.stringify({ error: 'Could not load evaluations' }) }
    const evals = JSON.parse(evalsRes.body)

    if (!evals.length) {
      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(emptyPayload) }
    }

    // Strip each eval's sections down to name/score/status only — no
    // covered/gaps/coaching/next_step, and there is no transcript field
    // to strip in the first place (never stored).
    const strippedEvals = evals.map(e => ({
      user_id: e.user_id,
      fw: e.fw,
      overall_score: e.overall_score,
      created_at: e.created_at,
      sections: (e.sections || []).map(s => ({ name: s.name, score: s.score, status: s.status })),
    }))

    // Team-level stats
    const evalCount = strippedEvals.length
    const avgScore = Math.round(strippedEvals.reduce((sum, e) => sum + (e.overall_score || 0), 0) / evalCount)
    const trend = strippedEvals.map(e => ({ date: e.created_at, score: e.overall_score, userId: e.user_id }))

    // Per-section aggregate across the whole team
    const sectionAgg = {}
    strippedEvals.forEach(e => {
      e.sections.forEach(s => {
        if (!s.name) return
        sectionAgg[s.name] = sectionAgg[s.name] || { sum: 0, count: 0, red: 0 }
        sectionAgg[s.name].sum += s.score || 0
        sectionAgg[s.name].count++
        if (s.status === 'red') sectionAgg[s.name].red++
      })
    })
    const sectionAggregates = Object.keys(sectionAgg).map(name => ({
      name: name,
      avgScore: Math.round(sectionAgg[name].sum / sectionAgg[name].count),
      redCount: sectionAgg[name].red,
      totalCount: sectionAgg[name].count,
    })).sort((a, b) => a.avgScore - b.avgScore)

    // Per-AE summary
    const byAe = {}
    strippedEvals.forEach(e => {
      byAe[e.user_id] = byAe[e.user_id] || { evalCount: 0, scoreSum: 0, sections: {} }
      const a = byAe[e.user_id]
      a.evalCount++
      a.scoreSum += e.overall_score || 0
      e.sections.forEach(s => {
        if (!s.name) return
        a.sections[s.name] = a.sections[s.name] || { sum: 0, count: 0 }
        a.sections[s.name].sum += s.score || 0
        a.sections[s.name].count++
      })
    })
    const aeSummaries = Object.keys(byAe).map(userId => {
      const a = byAe[userId]
      const sectionAverages = Object.keys(a.sections).map(name => ({
        name: name,
        avgScore: Math.round(a.sections[name].sum / a.sections[name].count),
      })).sort((x, y) => x.avgScore - y.avgScore)
      return {
        userId: userId,
        name: nameById[userId] || 'Unknown',
        evalCount: a.evalCount,
        avgScore: Math.round(a.scoreSum / a.evalCount),
        weakestSection: sectionAverages[0] || null,
        sectionAverages: sectionAverages,
      }
    }).sort((x, y) => x.avgScore - y.avgScore)

    let coachingBrief = null
    try {
      coachingBrief = await generateCoachingBrief(sectionAggregates)
    } catch (e) {
      console.error('Coaching brief failed (non-fatal):', e.message)
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team: { id: team.id, name: team.name },
        rangeDays: range,
        memberCount: activeMembers.length,
        teamStats: { evalCount: evalCount, avgScore: avgScore, trend: trend },
        sectionAggregates: sectionAggregates,
        aeSummaries: aeSummaries,
        coachingBrief: coachingBrief,
      }),
    }

  } catch (err) {
    console.error('team-dashboard error:', err.message)
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) }
  }
}
