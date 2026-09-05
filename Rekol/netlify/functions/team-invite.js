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

function emailjsSend(templateParams) {
  return new Promise((resolve, reject) => {
    if (!process.env.EMAILJS_INVITE_TEMPLATE_ID) {
      return reject(new Error('EMAILJS_INVITE_TEMPLATE_ID is not set — cannot send invite email'))
    }
    const body = JSON.stringify({
      service_id: 'service_occ3ghx',
      template_id: process.env.EMAILJS_INVITE_TEMPLATE_ID,
      user_id: 'JmqwTxpBaW1V6uGaG',
      accessToken: process.env.EMAILJS_PRIVATE_KEY,
      template_params: templateParams
    })
    const options = {
      hostname: 'api.emailjs.com',
      path: '/api/v1.0/email/send',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }
    const req = https.request(options, (res) => {
      let raw = ''
      res.on('data', chunk => raw += chunk)
      res.on('end', () => {
        // EmailJS returns a non-2xx status (e.g. bad template_id, bad
        // accessToken) as a normal HTTP response, not a connection error —
        // treat that as a failure too, otherwise it resolves "successfully"
        // and the caller's .catch() never fires, silently swallowing it.
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ status: res.statusCode, body: raw })
        } else {
          reject(new Error('EmailJS ' + res.statusCode + ': ' + raw))
        }
      })
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' }

  try {
    const caller = await verifyUser(event.headers.authorization || event.headers.Authorization)
    if (!caller) return { statusCode: 401, body: JSON.stringify({ error: 'Not signed in' }) }

    const { teamName, teamId, emails } = JSON.parse(event.body || '{}')

    if (!Array.isArray(emails) || !emails.length) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Provide at least one email' }) }
    }

    let team
    if (teamId) {
      const teamRes = await supabaseRequest('GET', '/rest/v1/teams?id=eq.' + encodeURIComponent(teamId) + '&select=id,name,owner_id', null)
      if (teamRes.status !== 200) return { statusCode: 502, body: JSON.stringify({ error: 'Could not look up team' }) }
      const rows = JSON.parse(teamRes.body)
      if (!rows.length || rows[0].owner_id !== caller.id) {
        return { statusCode: 403, body: JSON.stringify({ error: 'You do not own this team' }) }
      }
      team = rows[0]
    } else {
      if (!teamName || !teamName.trim()) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Provide a team name' }) }
      }
      const createRes = await supabaseRequest(
        'POST',
        '/rest/v1/teams',
        { owner_id: caller.id, name: teamName.trim() },
        { 'Prefer': 'return=representation' }
      )
      if (createRes.status !== 201) {
        console.error('Team create failed:', createRes.status, createRes.body)
        return { statusCode: 502, body: JSON.stringify({ error: 'Could not create team' }) }
      }
      team = JSON.parse(createRes.body)[0]
    }

    // Lowercase + de-dupe the incoming email list
    const cleanEmails = Array.from(new Set(
      emails.map(e => String(e || '').trim().toLowerCase()).filter(e => e && e.includes('@'))
    ))
    if (!cleanEmails.length) {
      return { statusCode: 400, body: JSON.stringify({ error: 'No valid emails provided' }) }
    }

    // Bulk upsert — ignore-duplicates means rows already invited to this
    // team are silently skipped; only newly-created rows come back, which
    // tells us exactly who to send an invite email to.
    const insertRes = await supabaseRequest(
      'POST',
      '/rest/v1/team_members?on_conflict=team_id,invited_email',
      cleanEmails.map(email => ({ team_id: team.id, invited_email: email, status: 'invited' })),
      { 'Prefer': 'resolution=ignore-duplicates,return=representation' }
    )
    if (insertRes.status !== 201 && insertRes.status !== 200) {
      console.error('Member insert failed:', insertRes.status, insertRes.body)
      return { statusCode: 502, body: JSON.stringify({ error: 'Could not invite members' }) }
    }
    const newlyInvited = JSON.parse(insertRes.body)

    const managerName = (caller.user_metadata && caller.user_metadata.full_name) || caller.email

    const emailResults = await Promise.all(newlyInvited.map(m =>
      emailjsSend({
        to_email: m.invited_email,
        manager_name: managerName,
        team_name: team.name,
        link: 'https://getrekol.com'
      }).then(() => ({ email: m.invited_email, sent: true }))
        .catch(err => {
          console.error('Invite email failed for', m.invited_email, err.message)
          return { email: m.invited_email, sent: false, error: err.message }
        })
    ))
    const emailsSent = emailResults.filter(r => r.sent).length
    const emailFailures = emailResults.filter(r => !r.sent).map(r => r.email)

    const membersRes = await supabaseRequest(
      'GET',
      '/rest/v1/team_members?team_id=eq.' + encodeURIComponent(team.id) + '&select=id,invited_email,status,joined_at,created_at&order=created_at.asc',
      null
    )
    const members = membersRes.status === 200 ? JSON.parse(membersRes.body) : []

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ team: { id: team.id, name: team.name }, members: members, invited: newlyInvited.length, emailsSent: emailsSent, emailFailures: emailFailures }),
    }

  } catch (err) {
    console.error('team-invite error:', err.message)
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) }
  }
}
