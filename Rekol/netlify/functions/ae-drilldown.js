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

// Same coercion as team-dashboard.js — scores live inside a jsonb column
// (untyped per-key), so a historical record can carry a numeric string
// instead of a number. See team-dashboard.js for the full story.
function cleanScore(raw) {
  const n = parseInt(raw, 10)
  if (!Number.isFinite(n)) return null
  return Math.max(0, Math.min(100, n))
}

function dedupeSections(sections) {
  const seen = {}
  const out = []
  ;(sections || []).forEach(s => {
    if (s && s.name && !seen[s.name]) { seen[s.name] = true; out.push(s) }
  })
  return out
}

// Rules-based deal-health band — no AI, no extra cost. Weights the MEDDIC
// sections that most predict a deal actually progressing rather than
// stalling: an economic buyer who's engaged, a champion pushing
// internally, a mapped decision process, and quantified metrics. Only
// meaningful for MEDDIC evals; other frameworks don't have these section
// names at all, so this returns null for them — callers should render
// that as "not applicable", not as a missing/zero score.
const HEALTH_WEIGHTS = { 'Economic Buyer': 0.30, 'Champion': 0.25, 'Decision Process': 0.25, 'Metrics': 0.20 }
function dealHealth(fw, sections) {
  if (fw !== 'MEDDIC') return null
  const byName = {}
  sections.forEach(s => { if (s.score !== null) byName[s.name] = s.score })
  let totalWeight = 0, weightedSum = 0
  Object.keys(HEALTH_WEIGHTS).forEach(name => {
    if (byName[name] !== undefined) {
      weightedSum += byName[name] * HEALTH_WEIGHTS[name]
      totalWeight += HEALTH_WEIGHTS[name]
    }
  })
  if (totalWeight === 0) return null
  const score = Math.round(weightedSum / totalWeight)
  const band = score >= 65 ? 'Healthy' : score >= 40 ? 'At risk' : 'Stalled'
  return { score: score, band: band }
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' }

  try {
    const caller = await verifyUser(event.headers.authorization || event.headers.Authorization)
    if (!caller) return { statusCode: 401, body: JSON.stringify({ error: 'Not signed in' }) }

    const { teamId, aeUserId } = JSON.parse(event.body || '{}')
    if (!teamId || !aeUserId) return { statusCode: 400, body: JSON.stringify({ error: 'Missing teamId or aeUserId' }) }

    // Ownership check — same security boundary as team-dashboard.js: this
    // gate is what matters, since everything below reads via the service
    // key and bypasses RLS entirely.
    const teamRes = await supabaseRequest('GET', '/rest/v1/teams?id=eq.' + encodeURIComponent(teamId) + '&select=id,owner_id', null)
    if (teamRes.status !== 200) return { statusCode: 502, body: JSON.stringify({ error: 'Could not look up team' }) }
    const teamRows = JSON.parse(teamRes.body)
    if (!teamRows.length || teamRows[0].owner_id !== caller.id) {
      return { statusCode: 403, body: JSON.stringify({ error: 'You do not own this team' }) }
    }

    // The AE being drilled into must actually be an active member of this
    // team — otherwise a manager could pass any userId and read a
    // stranger's full eval history (covered/gaps/coaching text included).
    const memberRes = await supabaseRequest(
      'GET',
      '/rest/v1/team_members?team_id=eq.' + encodeURIComponent(teamId) + '&user_id=eq.' + encodeURIComponent(aeUserId) + '&status=eq.active&select=user_id',
      null
    )
    if (memberRes.status !== 200 || !JSON.parse(memberRes.body).length) {
      return { statusCode: 403, body: JSON.stringify({ error: 'Not an active member of this team' }) }
    }

    const profileRes = await supabaseRequest('GET', '/rest/v1/profiles?id=eq.' + encodeURIComponent(aeUserId) + '&select=name,email', null)
    const profileRows = profileRes.status === 200 ? JSON.parse(profileRes.body) : []
    const repName = (profileRows[0] && (profileRows[0].name || profileRows[0].email)) || 'Unknown'

    // Full history, no date window — this is a coaching profile, not a
    // rolling KPI, so it should reflect the rep's whole track record.
    // Capped at 200 to keep the payload sane for a very long-tenured rep.
    const evalsRes = await supabaseRequest(
      'GET',
      '/rest/v1/evaluations?user_id=eq.' + encodeURIComponent(aeUserId) +
        '&select=id,fw,overall_score,summary,deal_name,persona,sections,next_steps,created_at&order=created_at.desc&limit=200',
      null
    )
    if (evalsRes.status !== 200) return { statusCode: 502, body: JSON.stringify({ error: 'Could not load evaluations' }) }
    const rawEvals = JSON.parse(evalsRes.body)

    if (!rawEvals.length) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rep: { userId: aeUserId, name: repName, evalCount: 0, avgScore: null, trend: [], trendDelta: null, frameworksUsed: [] },
          strengths: [], developAreas: [], evalHistory: [], coachingSummary: null,
        }),
      }
    }

    const evals = rawEvals.map(e => ({
      id: e.id,
      fw: e.fw || 'Unknown',
      overallScore: cleanScore(e.overall_score),
      summary: e.summary || '',
      dealName: e.deal_name || 'Untitled deal',
      persona: e.persona || '',
      sections: dedupeSections(e.sections).map(s => Object.assign({}, s, { score: cleanScore(s.score) })),
      nextSteps: e.next_steps || [],
      createdAt: e.created_at,
    }))

    // 1. Rep header
    const evalCount = evals.length
    const scored = evals.filter(e => e.overallScore !== null)
    const avgScore = scored.length ? Math.round(scored.reduce((sum, e) => sum + e.overallScore, 0) / scored.length) : null
    const chronological = evals.slice().sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
    const firstScore = chronological[0].overallScore
    const latestScore = chronological[chronological.length - 1].overallScore
    const trendDelta = (firstScore !== null && latestScore !== null) ? latestScore - firstScore : null
    const trend = chronological.map(e => ({ date: e.createdAt, score: e.overallScore }))
    const frameworksUsed = Array.from(new Set(evals.map(e => e.fw)))

    // 2. Strengths & development areas — flat across all their sections
    // regardless of framework (this is one rep's own profile, not a
    // cross-framework team rollup, so pooling their own sections together
    // is fine even if they've used more than one framework).
    const sectionAgg = {}
    evals.forEach(e => e.sections.forEach(s => {
      if (!s.name || s.score === null) return
      sectionAgg[s.name] = sectionAgg[s.name] || { sum: 0, count: 0 }
      sectionAgg[s.name].sum += s.score
      sectionAgg[s.name].count++
    }))
    const sectionAverages = Object.keys(sectionAgg).map(name => ({
      name: name,
      avgScore: Math.round(sectionAgg[name].sum / sectionAgg[name].count),
    }))
    const strengths = sectionAverages.slice().sort((a, b) => b.avgScore - a.avgScore).slice(0, 2)
    const strongNames = strengths.map(s => s.name)
    const developAreas = sectionAverages
      .filter(s => strongNames.indexOf(s.name) === -1)
      .sort((a, b) => a.avgScore - b.avgScore)
      .slice(0, 2)

    // 3 + 5. Evaluation history, each carrying its full section detail
    // (for click-through to the full eval renderer) and its rules-based
    // deal-health band. Next-steps-by-deal (item 4) is derived from this
    // same array client-side rather than duplicated in the payload.
    const evalHistory = evals
      .slice()
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .map(e => Object.assign({}, e, { dealHealth: dealHealth(e.fw, e.sections) }))

    // 6. Coaching summary — one AI call, cached in ae_coaching_cache keyed
    // on (team, rep). Regenerated only when this rep's eval count has
    // changed since the cached version, so opening the same profile
    // repeatedly costs nothing after the first time.
    let coachingSummary = null
    try {
      const cacheRes = await supabaseRequest(
        'GET',
        '/rest/v1/ae_coaching_cache?team_id=eq.' + encodeURIComponent(teamId) + '&user_id=eq.' + encodeURIComponent(aeUserId) + '&select=summary,eval_count_at_generation',
        null
      )
      const cacheRows = cacheRes.status === 200 ? JSON.parse(cacheRes.body) : []
      const cached = cacheRows[0]

      if (cached && cached.eval_count_at_generation === evalCount) {
        coachingSummary = cached.summary
      } else {
        const lines = sectionAverages
          .slice()
          .sort((a, b) => a.avgScore - b.avgScore)
          .map(s => s.name + ': avg ' + s.avgScore + '/100')
          .join('\n')

        const prompt = [
          'You are a sales enablement lead preparing a manager for a 1:1 with one of their reps, ' + repName + '.',
          'Their average scores per section, aggregated across ' + evalCount + ' evaluations (lowest first):',
          '',
          lines,
          '',
          'Write a 3-4 sentence coaching summary: what to focus on in the next 1:1 with ' + repName + '. Be direct and specific, framed constructively. Do not use markdown, headings, or bullet points — plain prose only.'
        ].join('\n')

        const response = await anthropicPost({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 220,
          messages: [{ role: 'user', content: prompt }],
        })

        if (response.status === 200) {
          const data = JSON.parse(response.body)
          coachingSummary = data.content[0].text.trim()
          await supabaseRequest(
            'POST',
            '/rest/v1/ae_coaching_cache?on_conflict=team_id,user_id',
            { team_id: teamId, user_id: aeUserId, summary: coachingSummary, eval_count_at_generation: evalCount, generated_at: new Date().toISOString() },
            { 'Prefer': 'resolution=merge-duplicates' }
          )
        } else {
          console.error('Coaching summary Anthropic error:', response.status, response.body)
        }
      }
    } catch (e) {
      console.error('Coaching summary failed (non-fatal):', e.message)
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        rep: { userId: aeUserId, name: repName, evalCount: evalCount, avgScore: avgScore, trend: trend, trendDelta: trendDelta, frameworksUsed: frameworksUsed },
        strengths: strengths,
        developAreas: developAreas,
        evalHistory: evalHistory,
        coachingSummary: coachingSummary,
      }),
    }

  } catch (err) {
    console.error('ae-drilldown error:', err.message)
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) }
  }
}
