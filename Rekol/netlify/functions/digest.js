const https = require('https')

function supabaseRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null
    const options = {
      hostname: 'iqdnmlzamqqskfjysfzg.supabase.co',
      path: path,
      method: method,
      headers: {
        'Content-Type': 'application/json',
        'apikey': process.env.SUPABASE_SERVICE_KEY,
        'Authorization': 'Bearer ' + process.env.SUPABASE_SERVICE_KEY,
        'Prefer': 'return=minimal'
      }
    }
    if (data) options.headers['Content-Length'] = Buffer.byteLength(data)
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

function emailjsSend(templateParams) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      service_id: 'service_occ3ghx',
      template_id: process.env.EMAILJS_DIGEST_TEMPLATE_ID,
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
      res.on('end', () => resolve({ status: res.statusCode, body: raw }))
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

// Scheduled via netlify.toml — runs every Monday 08:00 UTC
exports.handler = async function () {
  try {
    const profilesRes = await supabaseRequest('GET', '/rest/v1/profiles?digest_enabled=eq.true&select=id,email,name', null)
    if (profilesRes.status !== 200) {
      console.error('Failed to fetch digest profiles:', profilesRes.status, profilesRes.body)
      return { statusCode: 502, body: 'Failed to fetch profiles' }
    }
    const profiles = JSON.parse(profilesRes.body)
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

    let sent = 0
    for (const profile of profiles) {
      const evalsRes = await supabaseRequest(
        'GET',
        '/rest/v1/evaluations?user_id=eq.' + profile.id +
          '&created_at=gte.' + encodeURIComponent(sevenDaysAgo) +
          '&select=overall_score,sections,fw,created_at&order=created_at.desc',
        null
      )
      if (evalsRes.status !== 200) {
        console.error('Failed to fetch evaluations for', profile.id, evalsRes.status, evalsRes.body)
        continue
      }
      const evals = JSON.parse(evalsRes.body)
      if (!evals.length) continue // no evals this week — skip, don't send an empty digest

      const avgScore = Math.round(evals.reduce((sum, e) => sum + (e.overall_score || 0), 0) / evals.length)

      let lowest = null
      evals.forEach(e => {
        (e.sections || []).forEach(sec => {
          if (typeof sec.score === 'number' && (!lowest || sec.score < lowest.score)) lowest = sec
        })
      })

      const result = await emailjsSend({
        to_email: profile.email,
        to_name: profile.name || profile.email.split('@')[0],
        eval_count: evals.length,
        avg_score: avgScore,
        lowest_section: lowest ? lowest.name : 'N/A',
        coaching_tip: lowest ? (lowest.coaching || '') : '',
        link: 'https://getrekol.com'
      })

      if (result.status >= 200 && result.status < 300) {
        sent++
        await supabaseRequest('PATCH', '/rest/v1/profiles?id=eq.' + profile.id, { last_digest_sent: new Date().toISOString() })
      } else {
        console.error('EmailJS send failed for', profile.email, result.status, result.body)
      }
    }

    console.log('Digest run complete —', sent, '/', profiles.length, 'sent')
    return { statusCode: 200, body: JSON.stringify({ sent: sent, checked: profiles.length }) }

  } catch (err) {
    console.error('Digest error:', err.message)
    return { statusCode: 500, body: err.message }
  }
}
