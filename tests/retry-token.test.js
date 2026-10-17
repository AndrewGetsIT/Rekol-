// 2a: a retry (sections subset) is only possible with a token issued by an
// allowed full pass for the same user, transcript and framework.
const test = require('node:test')
const assert = require('node:assert')
const crypto = require('crypto')
const { loadFunction, event, demoTranscript, SAMPLE_TRANSCRIPT, USERS } = require('./helpers/load')
const { makeWorld } = require('./helpers/backend')

function world(profile = { eval_count: 10, is_pro: false }) {
  const patches = []
  const w = makeWorld({
    users: USERS,
    rest: (rec) => {
      if (!rec.path.startsWith('/rest/v1/profiles')) return undefined
      if (rec.method === 'PATCH') { patches.push(rec); return { status: 200, body: '[]' } }
      return { status: 200, body: JSON.stringify([Object.assign({ id: 'x' }, profile)]) }
    },
  })
  w.patches = patches
  return w
}
const body = (extra = {}, tr = SAMPLE_TRANSCRIPT, fw = 'MEDDIC') =>
  Object.assign({ transcript: tr, framework: fw, customFields: fw === 'Custom' ? [{ name: 'Metrics', desc: 'd' }] : [], mode: 'full' }, extra)

async function issue(handler, token = 'tok-user', tr = SAMPLE_TRANSCRIPT, fw = 'MEDDIC') {
  const res = await handler(event(body({}, tr, fw), token))
  assert.strictEqual(res.statusCode, 200)
  return JSON.parse(res.body).retry_token
}

// a user under the limit gets a token with the first full pass
const UNDER = { eval_count: 2, is_pro: false }

test('a full pass returns a retry_token; a valid one lets a retry through, without touching eval_count', async () => {
  const w = world(UNDER)
  try {
    const { handler } = loadFunction('evaluate')
    const tok = await issue(handler)
    assert.match(tok, /^\d+\.[0-9a-f]{64}$/)
    const res = await handler(event(body({ sections: ['Metrics'], retry_token: tok }), 'tok-user'))
    assert.strictEqual(res.statusCode, 200)
    assert.strictEqual(w.patches.length, 0)
  } finally { w.restore() }
})

test('at the free limit nothing issues a token, so a new transcript cannot be scored through the retry path', async () => {
  const w = world({ eval_count: 10, is_pro: false })
  try {
    const { handler } = loadFunction('evaluate')
    assert.strictEqual((await handler(event(body(), 'tok-user'))).statusCode, 402)
    for (const retry_token of [undefined, '', 'garbage', Date.now() + 100000 + '.' + 'a'.repeat(64)]) {
      const res = await handler(event(body({ sections: ['Metrics', 'Champion'], retry_token }), 'tok-user'))
      assert.strictEqual(res.statusCode, 403)
    }
    assert.strictEqual(w.anthropicCalls().length, 0)
  } finally { w.restore() }
})

test('a retry without a token is refused (403) before any model call', async () => {
  const w = world(UNDER)
  try {
    const { handler } = loadFunction('evaluate')
    const res = await handler(event(body({ sections: ['Metrics'] }), 'tok-user'))
    assert.strictEqual(res.statusCode, 403)
    assert.strictEqual(w.anthropicCalls().length, 0)
  } finally { w.restore() }
})

test('a token is bound to the user', async () => {
  const w = world(UNDER)
  try {
    const { handler } = loadFunction('evaluate')
    const tok = await issue(handler, 'tok-user')
    assert.strictEqual((await handler(event(body({ sections: ['Metrics'], retry_token: tok }), 'tok-other'))).statusCode, 403)
  } finally { w.restore() }
})

test('a token is bound to the transcript (whitespace-insensitive, but any other change fails)', async () => {
  const w = world(UNDER)
  try {
    const { handler } = loadFunction('evaluate')
    const tok = await issue(handler)
    const same = await handler(event(body({ sections: ['Metrics'], retry_token: tok }, '  ' + SAMPLE_TRANSCRIPT.replace(/ /g, '  ')), 'tok-user'))
    assert.strictEqual(same.statusCode, 200)
    const other = await handler(event(body({ sections: ['Metrics'], retry_token: tok }, SAMPLE_TRANSCRIPT + ' extra words'), 'tok-user'))
    assert.strictEqual(other.statusCode, 403)
  } finally { w.restore() }
})

test('a token is bound to the framework', async () => {
  const w = world(UNDER)
  try {
    const { handler } = loadFunction('evaluate')
    const tok = await issue(handler, 'tok-user', SAMPLE_TRANSCRIPT, 'MEDDIC')
    assert.strictEqual((await handler(event(body({ sections: ['Budget'], retry_token: tok }, SAMPLE_TRANSCRIPT, 'BANT'), 'tok-user'))).statusCode, 403)
  } finally { w.restore() }
})

test('an expired token is refused', async () => {
  const w = world(UNDER)
  const realNow = Date.now
  try {
    const { handler } = loadFunction('evaluate')
    const tok = await issue(handler)
    Date.now = () => realNow() + 31 * 60 * 1000
    assert.strictEqual((await handler(event(body({ sections: ['Metrics'], retry_token: tok }), 'tok-user'))).statusCode, 403)
    Date.now = () => realNow() + 20 * 60 * 1000
    assert.strictEqual((await handler(event(body({ sections: ['Metrics'], retry_token: tok }), 'tok-user'))).statusCode, 200)
  } finally { Date.now = realNow; w.restore() }
})

test('a tampered token (changed expiry or signature, or signed with another secret) is refused', async () => {
  const w = world(UNDER)
  try {
    const { handler } = loadFunction('evaluate')
    const tok = await issue(handler)
    const [exp, sig] = tok.split('.')
    const longer = Number(exp) + 3600000 + '.' + sig
    const flipped = exp + '.' + (sig[0] === 'a' ? 'b' : 'a') + sig.slice(1)
    const wrongSecret = exp + '.' + crypto.createHmac('sha256', 'not-the-secret').update('x').digest('hex')
    for (const retry_token of [longer, flipped, wrongSecret, exp + '.short', 7, null]) {
      assert.strictEqual((await handler(event(body({ sections: ['Metrics'], retry_token }), 'tok-user'))).statusCode, 403, String(retry_token))
    }
  } finally { w.restore() }
})

test('without RETRY_TOKEN_SECRET retries fail closed and the reason is logged', async () => {
  const w = world(UNDER)
  const logs = []
  const orig = console.error
  console.error = (...a) => logs.push(a.join(' '))
  try {
    const { handler } = loadFunction('evaluate')
    const tok = await issue(handler)
    delete process.env.RETRY_TOKEN_SECRET
    assert.strictEqual(tok === undefined || typeof tok === 'string', true)
    const noSecret = loadFunction('evaluate', { RETRY_TOKEN_SECRET: '' })
    const res = await noSecret.handler(event(body({ sections: ['Metrics'], retry_token: tok }), 'tok-user'))
    assert.strictEqual(res.statusCode, 403)
    assert.ok(logs.some((l) => l.includes('RETRY_TOKEN_SECRET not set')))
    const full = JSON.parse((await noSecret.handler(event(body(), 'tok-user'))).body)
    assert.strictEqual(full.retry_token, undefined)
  } finally { console.error = orig; process.env.RETRY_TOKEN_SECRET = 'test-retry-secret'; w.restore() }
})

test('the demo transcript needs no token and never gets one', async () => {
  const w = world(UNDER)
  try {
    const { handler } = loadFunction('evaluate')
    const full = JSON.parse((await handler(event(body({}, demoTranscript()), undefined))).body)
    assert.strictEqual(full.retry_token, undefined)
    const retry = await handler(event(body({ sections: ['Metrics'] }, demoTranscript()), undefined))
    assert.strictEqual(retry.statusCode, 200)
  } finally { w.restore() }
})
