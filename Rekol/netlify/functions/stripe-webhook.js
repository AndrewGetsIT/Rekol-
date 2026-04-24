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

function verifyStripeSignature(payload, signature, secret) {
  const crypto = require('crypto')
  const parts = signature.split(',')
  const timestamp = parts.find(p => p.startsWith('t=')).slice(2)
  const sig = parts.find(p => p.startsWith('v1=')).slice(3)
  const signed = timestamp + '.' + payload
  const expected = crypto.createHmac('sha256', secret).update(signed).digest('hex')
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
}

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' }

  try {
    const signature = event.headers['stripe-signature']
    const secret = process.env.STRIPE_WEBHOOK_SECRET

    if (!verifyStripeSignature(event.body, signature, secret)) {
      console.error('Invalid Stripe signature')
      return { statusCode: 400, body: 'Invalid signature' }
    }

    const stripeEvent = JSON.parse(event.body)
    console.log('Stripe event:', stripeEvent.type)

    if (stripeEvent.type === 'checkout.session.completed') {
      const session = stripeEvent.data.object
      const email = session.customer_details?.email || session.customer_email

      if (!email) {
        console.error('No email in session')
        return { statusCode: 200, body: 'OK' }
      }

      console.log('Upgrading user:', email)

      // Find user by email and set is_pro = true
      const res = await supabaseRequest('PATCH', '/rest/v1/profiles?email=eq.' + encodeURIComponent(email), {
        is_pro: true
      })

      console.log('Supabase update status:', res.status)
    }

    return { statusCode: 200, body: 'OK' }

  } catch (err) {
    console.error('Webhook error:', err.message)
    return { statusCode: 500, body: err.message }
  }
}