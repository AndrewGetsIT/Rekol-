const https = require('https')

function supabaseRequest(method, path, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null
    const headers = Object.assign({
      'Content-Type': 'application/json',
      'apikey': process.env.SUPABASE_SERVICE_KEY,
      'Authorization': 'Bearer ' + process.env.SUPABASE_SERVICE_KEY,
    }, extraHeaders || {})
    if (data) headers['Content-Length'] = Buffer.byteLength(data)
    const options = {
      hostname: 'iqdnmlzamqqskfjysfzg.supabase.co',
      path: path,
      method: method,
      headers: headers,
    }
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

exports.handler = async function (event) {
  try {
    if (event.httpMethod === 'POST') {
      const { evalJson, teamCode, aeName } = JSON.parse(event.body || '{}')
      if (!evalJson) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Missing evalJson' }) }
      }

      const insertRes = await supabaseRequest(
        'POST',
        '/rest/v1/shared_evals',
        { eval_json: evalJson, team_code: teamCode || null, ae_name: aeName || null },
        { 'Prefer': 'return=representation' }
      )

      if (insertRes.status !== 201) {
        console.error('Share insert failed:', insertRes.status, insertRes.body)
        return { statusCode: 502, body: JSON.stringify({ error: 'Could not save shared evaluation' }) }
      }

      const rows = JSON.parse(insertRes.body)
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: rows[0].id }),
      }
    }

    if (event.httpMethod === 'GET') {
      const params = event.queryStringParameters || {}

      if (params.id) {
        const res = await supabaseRequest(
          'GET',
          '/rest/v1/shared_evals?id=eq.' + encodeURIComponent(params.id) + '&select=id,eval_json,ae_name,team_code,created_at',
          null
        )
        if (res.status !== 200) {
          return { statusCode: 502, body: JSON.stringify({ error: 'Lookup failed' }) }
        }
        const rows = JSON.parse(res.body)
        if (!rows.length) {
          return { statusCode: 404, body: JSON.stringify({ error: 'Not found' }) }
        }
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(rows[0]),
        }
      }

      if (params.teamCode) {
        const res = await supabaseRequest(
          'GET',
          '/rest/v1/shared_evals?team_code=eq.' + encodeURIComponent(params.teamCode) + '&select=id,eval_json,ae_name,team_code,created_at&order=created_at.desc',
          null
        )
        if (res.status !== 200) {
          return { statusCode: 502, body: JSON.stringify({ error: 'Lookup failed' }) }
        }
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: res.body,
        }
      }

      return { statusCode: 400, body: JSON.stringify({ error: 'Provide id or teamCode' }) }
    }

    return { statusCode: 405, body: 'Method not allowed' }

  } catch (err) {
    console.error('Share function error:', err.message)
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) }
  }
}
