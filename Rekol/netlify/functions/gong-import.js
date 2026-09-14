const https = require('https')

const SUPA_HOST = 'iqdnmlzamqqskfjysfzg.supabase.co'
const SUPA_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlxZG5tbHphbXFxc2tmanlzZnpnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYzNTU3NTMsImV4cCI6MjA5MTkzMTc1M30.bYFx7o_Cvr8SoLPHO_dlguOZ9x7bX9ekf_IIDUSbIYo'

// Verifies a Supabase access token by asking Supabase Auth who it belongs
// to. Same pattern used across team-invite.js/team-dashboard.js/
// ae-drilldown.js/evaluate.js. Returns the user object or null.
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

// Gong's REST API v2 uses HTTP Basic Auth: the access key as username,
// the access key secret as password. Both come from the request body on
// every call — this function never reads them from an env var, a
// database row, or anywhere persistent. They exist only for the
// lifetime of this one invocation's call to Gong, and are never written
// to console.log/console.error (only non-secret context — status codes,
// call IDs — is logged) or to any storage.
function gongRequest(method, path, accessKey, accessKeySecret, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null
    const authValue = Buffer.from(accessKey + ':' + accessKeySecret).toString('base64')
    const headers = {
      'Authorization': 'Basic ' + authValue,
      'Content-Type': 'application/json',
    }
    if (data) headers['Content-Length'] = Buffer.byteLength(data)
    const options = { hostname: 'api.gong.io', path: path, method: method, headers: headers }
    const req = https.request(options, (res) => {
      let raw = ''
      res.on('data', chunk => raw += chunk)
      res.on('end', () => resolve({ status: res.statusCode, body: raw }))
    })
    req.on('error', reject)
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout contacting Gong')) })
    if (data) req.write(data)
    req.end()
  })
}

// Turns a Gong transcript response into plain "Speaker: sentence text"
// lines matching the format Rekol's transcript field already expects
// (the same shape as a manually pasted Gong/Chorus/Otter transcript).
//
// UNVERIFIED AGAINST A LIVE GONG TENANT — this parsing follows Gong's
// generally-documented v2 transcript shape (an array of monologues, each
// with a speakerId and a list of sentences with text), but the exact
// field names can only be confirmed against a real response. If this
// breaks against a real tenant, the fix is almost certainly here: adjust
// the field names below to match what Gong actually returns.
function formatGongTranscript(parsed) {
  const callTranscripts = parsed.callTranscripts || (parsed.transcript ? [{ transcript: parsed.transcript }] : [])
  if (!callTranscripts.length || !callTranscripts[0].transcript) {
    throw new Error('Unrecognised transcript response shape from Gong')
  }
  const monologues = callTranscripts[0].transcript
  const speakerLabel = (speakerId, i) => 'Speaker ' + (typeof speakerId === 'string' ? speakerId.slice(-4) : i + 1)
  const lines = monologues.map((m, i) => {
    const text = (m.sentences || []).map(s => s.text).filter(Boolean).join(' ')
    return text ? speakerLabel(m.speakerId, i) + ': ' + text : null
  }).filter(Boolean)
  if (!lines.length) throw new Error('Transcript came back empty')
  return lines.join('\n\n')
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' }

  try {
    // Any signed-in user can import their own transcript — this is a
    // personal tool, not team/manager-gated like the dashboard endpoints.
    const caller = await verifyUser(event.headers.authorization || event.headers.Authorization)
    if (!caller) return { statusCode: 401, body: JSON.stringify({ error: 'Not signed in' }) }

    const { action, gongAccessKey, gongAccessKeySecret, callId } = JSON.parse(event.body || '{}')
    if (!gongAccessKey || !gongAccessKeySecret) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing Gong access key or secret' }) }
    }

    if (action === 'list') {
      // POST /v2/calls filtered by date, per brief. Defaults to the last
      // 30 days — recent enough to be useful, short enough that the call
      // list stays manageable to scroll through and pick from.
      const toDateTime = new Date().toISOString()
      const fromDateTime = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()

      const res = await gongRequest('POST', '/v2/calls', gongAccessKey, gongAccessKeySecret, {
        filter: { fromDateTime: fromDateTime, toDateTime: toDateTime },
      })

      if (res.status === 401 || res.status === 403) {
        return { statusCode: 401, body: JSON.stringify({ error: 'Gong rejected that access key/secret.' }) }
      }
      if (res.status !== 200) {
        console.error('Gong list-calls error', res.status)
        return { statusCode: 502, body: JSON.stringify({ error: 'Gong error ' + res.status + ' — could not list calls.' }) }
      }

      let parsed
      try { parsed = JSON.parse(res.body) } catch (e) {
        return { statusCode: 502, body: JSON.stringify({ error: 'Unexpected response from Gong (not JSON).' }) }
      }

      // UNVERIFIED FIELD NAMES — see formatGongTranscript's comment above;
      // same caveat applies here (calls[].id / .title / .started /
      // .scheduled are Gong's generally-documented field names, not
      // confirmed against a live response).
      const calls = (parsed.calls || []).map(c => ({
        id: c.id,
        title: c.title || null,
        started: c.started || c.scheduled || null,
      })).filter(c => c.id)

      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ calls: calls }) }
    }

    if (action === 'transcript') {
      if (!callId) return { statusCode: 400, body: JSON.stringify({ error: 'Missing callId' }) }

      // GET /v2/calls/{id}/transcript, per brief.
      const res = await gongRequest('GET', '/v2/calls/' + encodeURIComponent(callId) + '/transcript', gongAccessKey, gongAccessKeySecret, null)

      if (res.status === 401 || res.status === 403) {
        return { statusCode: 401, body: JSON.stringify({ error: 'Gong rejected that access key/secret.' }) }
      }
      if (res.status !== 200) {
        console.error('Gong get-transcript error', res.status, 'for call', callId)
        return { statusCode: 502, body: JSON.stringify({ error: 'Gong error ' + res.status + ' — could not fetch transcript.' }) }
      }

      let parsed
      try { parsed = JSON.parse(res.body) } catch (e) {
        return { statusCode: 502, body: JSON.stringify({ error: 'Unexpected response from Gong (not JSON).' }) }
      }

      let transcript
      try {
        transcript = formatGongTranscript(parsed)
      } catch (e) {
        console.error('Gong transcript parse failed:', e.message)
        return { statusCode: 502, body: JSON.stringify({ error: 'Could not read that transcript — ' + e.message }) }
      }

      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ transcript: transcript }) }
    }

    return { statusCode: 400, body: JSON.stringify({ error: 'Unknown action' }) }

  } catch (err) {
    console.error('gong-import error:', err.message)
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) }
  }
}
