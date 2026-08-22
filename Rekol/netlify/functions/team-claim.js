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

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' }

  try {
    const caller = await verifyUser(event.headers.authorization || event.headers.Authorization)
    if (!caller || !caller.email) return { statusCode: 401, body: JSON.stringify({ error: 'Not signed in' }) }

    const email = caller.email.toLowerCase()

    // Claim any pending invites for this email — set user_id/status/joined_at
    // on rows that were only ever a string until now. select=*,teams(name)
    // pulls the team name back in the same request for the toast.
    const claimRes = await supabaseRequest(
      'PATCH',
      '/rest/v1/team_members?invited_email=eq.' + encodeURIComponent(email) + '&user_id=is.null',
      { user_id: caller.id, status: 'active', joined_at: new Date().toISOString() },
      { 'Prefer': 'return=representation' }
    )

    if (claimRes.status !== 200 && claimRes.status !== 204) {
      console.error('team-claim update failed:', claimRes.status, claimRes.body)
      return { statusCode: 502, body: JSON.stringify({ error: 'Could not check team invites' }) }
    }

    const claimed = claimRes.body ? JSON.parse(claimRes.body) : []
    let teamNames = []
    if (claimed.length) {
      const teamIds = Array.from(new Set(claimed.map(r => r.team_id)))
      const teamsRes = await supabaseRequest(
        'GET',
        '/rest/v1/teams?id=in.(' + teamIds.map(encodeURIComponent).join(',') + ')&select=name',
        null
      )
      if (teamsRes.status === 200) {
        teamNames = JSON.parse(teamsRes.body).map(t => t.name)
      }
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ claimed: claimed.length, teamNames: teamNames }),
    }

  } catch (err) {
    console.error('team-claim error:', err.message)
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) }
  }
}
