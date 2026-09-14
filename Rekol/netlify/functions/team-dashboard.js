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
      weakestSection: null,
      activity: { evalsThisWeek: 0, repsThisWeek: 0, byRep: [] },
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

    // Scores can be strings in older records — evals saved before the
    // evaluate.js tool-use fix stored `score` as whatever JSON.parse gave
    // back from free-text model output, which was sometimes a numeric
    // string ("55") rather than a number. `sum += "55"` on a number
    // silently becomes string concatenation from that point on (0 + "55"
    // = "055", then "055" + "41" = "05541"...), producing exactly the
    // impossible-looking totals ("84512") seen on the dashboard. Coerce
    // and clamp every score before it ever reaches an accumulator.
    function cleanScore(raw) {
      const n = parseInt(raw, 10)
      if (!Number.isFinite(n)) return null
      return Math.max(0, Math.min(100, n))
    }

    // De-dupe a single eval's sections by name (keep first occurrence)
    // before folding into any aggregate. A corrupted historical record —
    // e.g. from the split-mode merge bug now fixed at the source in
    // evaluate.js — can have the same section name twice and others
    // missing; double-counting the duplicate would inflate both that
    // section's average and its "N of N evaluations" count relative to
    // every other section in the same framework.
    function dedupeSections(sections) {
      const seen = {}
      const out = []
      ;(sections || []).forEach(s => {
        if (s && s.name && !seen[s.name]) { seen[s.name] = true; out.push(s) }
      })
      return out
    }

    // Strip each eval's sections down to name/score/status/covered — no
    // gaps/coaching/next_step, and there is no transcript field to strip
    // in the first place (never stored). `covered` is kept (unlike
    // before) so the dashboard can show one representative evidence
    // quote per section — see exampleQuote below — without exposing a
    // rep's full eval-by-eval coaching detail at the team level.
    const strippedEvals = evals.map(e => ({
      user_id: e.user_id,
      fw: e.fw || 'Unknown',
      overall_score: cleanScore(e.overall_score),
      created_at: e.created_at,
      sections: dedupeSections((e.sections || []).map(s => ({ name: s.name, score: cleanScore(s.score), status: s.status, covered: s.covered }))),
    }))

    // Trims a section's `covered` text down to a short example quote for
    // the dashboard — the model is instructed to cite specific lines in
    // covered, so this is real evidence, not a fabricated summary.
    function excerptQuote(text) {
      if (!text) return null
      const trimmed = String(text).trim()
      if (trimmed.length <= 220) return trimmed
      return trimmed.slice(0, 220).replace(/\s+\S*$/, '') + '…'
    }

    // Team-level stats — only average evals with a usable overall_score,
    // same reasoning as cleanScore() above.
    const scoredEvals = strippedEvals.filter(e => e.overall_score !== null)
    const evalCount = strippedEvals.length
    const avgScore = scoredEvals.length ? Math.round(scoredEvals.reduce((sum, e) => sum + e.overall_score, 0) / scoredEvals.length) : null
    const trend = strippedEvals.map(e => ({ date: e.created_at, score: e.overall_score, userId: e.user_id }))

    // Activity stat — real counts only, never a fabricated coverage
    // percentage against an unknown total-calls denominator. Rekol has no
    // way to know how many calls a rep actually took, only how many they
    // evaluated, so a "coverage %" here would be a made-up number against
    // a made-up total. "This week" is a fixed 7-day window, independent
    // of whichever range tab (7d/30d/90d) is selected, so the stat means
    // the same thing regardless of that toggle. If a real total-calls
    // figure ever becomes available (e.g. a Gong import), a true
    // coverage % can be computed against it then — not before.
    const weekAgoMs = Date.now() - 7 * 24 * 60 * 60 * 1000
    const evalsThisWeek = strippedEvals.filter(e => new Date(e.created_at).getTime() >= weekAgoMs)
    const countByUserThisWeek = {}
    evalsThisWeek.forEach(e => { countByUserThisWeek[e.user_id] = (countByUserThisWeek[e.user_id] || 0) + 1 })
    const activity = {
      evalsThisWeek: evalsThisWeek.length,
      repsThisWeek: new Set(evalsThisWeek.map(e => e.user_id)).size,
      byRep: activeMembers.map(m => ({
        userId: m.user_id,
        name: nameById[m.user_id] || 'Unknown',
        evalsThisWeek: countByUserThisWeek[m.user_id] || 0,
      })).sort((a, b) => b.evalsThisWeek - a.evalsThisWeek),
    }

    // Per-section aggregate, grouped by framework — MEDDIC/BANT/SPIN (and
    // any custom framework) each get their own bucket so sections are
    // never pooled together. A flat name-only key previously mixed them:
    // no standard-framework names collide today, but a custom field can
    // be named anything, including something that collides with a
    // standard section name and means something completely different.
    // Section-level trend, team-wide: bucket the selected range into up
    // to 6 equal-width windows and average the team's score per section
    // within each. Unlike the AE drilldown's raw per-eval trend, this is
    // many reps' individual evals interleaved — a raw chronological line
    // would just be noise from whoever happened to submit when, not a
    // real signal of whether the team is improving. Bucketing smooths
    // that into "was this section better or worse earlier in the period".
    const TREND_BUCKETS = 6
    const bucketSpanMs = Math.max(1, Math.ceil(range / TREND_BUCKETS)) * 24 * 60 * 60 * 1000
    const rangeStartMs = Date.now() - range * 24 * 60 * 60 * 1000
    function bucketIndexFor(dateStr) {
      const idx = Math.floor((new Date(dateStr).getTime() - rangeStartMs) / bucketSpanMs)
      return Math.max(0, Math.min(TREND_BUCKETS - 1, idx))
    }

    const sectionAggByFw = {}
    strippedEvals.forEach(e => {
      sectionAggByFw[e.fw] = sectionAggByFw[e.fw] || { evalCount: 0, sections: {} }
      sectionAggByFw[e.fw].evalCount++
      const bIdx = bucketIndexFor(e.created_at)
      e.sections.forEach(s => {
        if (!s.name || s.score === null) return
        const bucket = sectionAggByFw[e.fw].sections
        bucket[s.name] = bucket[s.name] || { sum: 0, count: 0, red: 0, exampleQuote: null, trendBuckets: Array.from({ length: TREND_BUCKETS }, () => ({ sum: 0, count: 0 })) }
        bucket[s.name].sum += s.score
        bucket[s.name].count++
        if (s.status === 'red') bucket[s.name].red++
        bucket[s.name].trendBuckets[bIdx].sum += s.score
        bucket[s.name].trendBuckets[bIdx].count++
        // strippedEvals is already ordered oldest-to-newest (the Supabase
        // query is order=created_at.asc), so overwriting on every match
        // naturally leaves the MOST RECENT eval's quote here by the time
        // the loop finishes.
        const quote = excerptQuote(s.covered)
        if (quote) bucket[s.name].exampleQuote = quote
      })
    })
    const sectionAggregates = Object.keys(sectionAggByFw).map(fw => ({
      framework: fw,
      evalCount: sectionAggByFw[fw].evalCount,
      sections: Object.keys(sectionAggByFw[fw].sections).map(name => {
        const agg = sectionAggByFw[fw].sections[name]
        const trend = agg.trendBuckets
          .map(b => b.count ? Math.round(b.sum / b.count) : null)
          .filter(v => v !== null)
        return {
          name: name,
          avgScore: Math.round(agg.sum / agg.count),
          redCount: agg.red,
          totalCount: agg.count,
          exampleQuote: agg.exampleQuote,
          trend: trend,
        }
      }).sort((a, b) => a.avgScore - b.avgScore),
    })).sort((a, b) => b.evalCount - a.evalCount)

    // Flat view (all frameworks' sections, sorted by score) — used both
    // for the coaching-brief prompt below (which just wants "what's
    // weakest" and doesn't need the per-framework structure) and as the
    // source for the team's single weakest-section callout (rules-based,
    // no AI — just the lowest avgScore across every section the team has
    // any data for).
    const flatSectionsForBrief = sectionAggregates
      .flatMap(g => g.sections.map(s => Object.assign({}, s, { framework: g.framework })))
      .sort((a, b) => a.avgScore - b.avgScore)
    const weakestSection = flatSectionsForBrief[0] || null

    // Per-AE summary — same framework-grouping and coercion fixes as the
    // team-wide aggregate above, in case one AE's own history spans more
    // than one framework.
    const byAe = {}
    strippedEvals.forEach(e => {
      byAe[e.user_id] = byAe[e.user_id] || { evalCount: 0, scoreSum: 0, scoredCount: 0, sectionsByFw: {} }
      const a = byAe[e.user_id]
      a.evalCount++
      if (e.overall_score !== null) { a.scoreSum += e.overall_score; a.scoredCount++ }
      a.sectionsByFw[e.fw] = a.sectionsByFw[e.fw] || {}
      e.sections.forEach(s => {
        if (!s.name || s.score === null) return
        const bucket = a.sectionsByFw[e.fw]
        bucket[s.name] = bucket[s.name] || { sum: 0, count: 0 }
        bucket[s.name].sum += s.score
        bucket[s.name].count++
      })
    })
    const aeSummaries = Object.keys(byAe).map(userId => {
      const a = byAe[userId]
      const sectionsByFw = Object.keys(a.sectionsByFw).map(fw => ({
        framework: fw,
        sections: Object.keys(a.sectionsByFw[fw]).map(name => ({
          name: name,
          avgScore: Math.round(a.sectionsByFw[fw][name].sum / a.sectionsByFw[fw][name].count),
        })).sort((x, y) => x.avgScore - y.avgScore),
      }))
      // Flat, sorted view for "weakest section" / the drilldown bar list —
      // still framework-grouped in sectionsByFw for anything that needs it.
      const sectionAverages = sectionsByFw.flatMap(g => g.sections).sort((x, y) => x.avgScore - y.avgScore)
      return {
        userId: userId,
        name: nameById[userId] || 'Unknown',
        evalCount: a.evalCount,
        avgScore: a.scoredCount ? Math.round(a.scoreSum / a.scoredCount) : null,
        weakestSection: sectionAverages[0] || null,
        sectionAverages: sectionAverages,
        sectionsByFw: sectionsByFw,
      }
    }).sort((x, y) => (x.avgScore === null ? 999 : x.avgScore) - (y.avgScore === null ? 999 : y.avgScore))

    let coachingBrief = null
    try {
      coachingBrief = await generateCoachingBrief(flatSectionsForBrief)
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
        weakestSection: weakestSection,
        activity: activity,
      }),
    }

  } catch (err) {
    console.error('team-dashboard error:', err.message)
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) }
  }
}
