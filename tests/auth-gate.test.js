// 0B: sign-in before your own transcript, and the free tier enforced on the
// server (not the browser).
const test = require('node:test')
const assert = require('node:assert')
const { loadFunction, event, demoTranscript, SAMPLE_TRANSCRIPT, USERS } = require('./helpers/load')
const { makeWorld } = require('./helpers/backend')

// profiles table in memory: user id -> row
function profilesWorld(profiles, extra = {}) {
  const patches = []
  const w = makeWorld(Object.assign({
    users: USERS,
    rest: (rec) => {
      if (!rec.path.startsWith('/rest/v1/profiles')) return undefined
      const id = (rec.path.match(/id=eq\.([^&]+)/) || [])[1]
      if (rec.method === 'GET') {
        if (extra.readStatus) return { status: extra.readStatus, body: '{}' }
        return { status: 200, body: JSON.stringify(profiles[id] ? [Object.assign({ id }, profiles[id])] : []) }
      }
      if (rec.method === 'PATCH') {
        patches.push({ path: rec.path, body: rec.json })
        const want = Number((rec.path.match(/eval_count=eq\.(\d+)/) || [])[1])
        if (extra.conflictsFirst && patches.length === 1) { profiles[id].eval_count += 1; return { status: 200, body: '[]' } } // someone else bumped it
        if (profiles[id] && profiles[id].eval_count === want) {
          profiles[id].eval_count = rec.json.eval_count
          return { status: 200, body: JSON.stringify([Object.assign({ id }, profiles[id])]) }
        }
        return { status: 200, body: '[]' }
      }
      return undefined
    },
  }, extra.world || {}))
  return Object.assign(w, { patches, profiles })
}

const req = (mode, token, transcript = SAMPLE_TRANSCRIPT, extra = {}) =>
  event(Object.assign({ transcript, framework: 'MEDDIC', customFields: [], mode }, extra), token)

test('signed-out + own transcript: 401 sign_in_required, no model call, no database call', async () => {
  const w = profilesWorld({})
  try {
    const { handler } = loadFunction('evaluate')
    for (const mode of ['quick', 'full']) {
      const res = await handler(req(mode, undefined))
      assert.strictEqual(res.statusCode, 401)
      assert.deepStrictEqual(JSON.parse(res.body), { error: 'sign_in_required' })
    }
    assert.strictEqual(w.anthropicCalls().length, 0)
    assert.strictEqual(w.calls.length, 0)
  } finally { w.restore() }
})

test('an invalid or expired token is treated as signed out', async () => {
  const w = profilesWorld({})
  try {
    const { handler } = loadFunction('evaluate')
    const res = await handler(req('quick', 'expired-token'))
    assert.strictEqual(res.statusCode, 401)
    assert.strictEqual(w.anthropicCalls().length, 0)
  } finally { w.restore() }
})

test('signed-out + the demo transcript: allowed as often as they like, and nothing is counted', async () => {
  const w = profilesWorld({})
  try {
    const { handler } = loadFunction('evaluate')
    for (let i = 0; i < 5; i++) {
      assert.strictEqual((await handler(req('quick', undefined, demoTranscript()))).statusCode, 200)
      assert.strictEqual((await handler(req('full', undefined, demoTranscript()))).statusCode, 200)
    }
    assert.strictEqual(w.calls.filter((c) => c.path.startsWith('/rest/v1/profiles')).length, 0)
  } finally { w.restore() }
})

test('the demo transcript is recognised despite whitespace changes, but not if a word changes', async () => {
  const w = profilesWorld({})
  try {
    const { handler } = loadFunction('evaluate')
    const spaced = '  ' + demoTranscript().replace(/\n\n/g, '\r\n\r\n   ').replace(/ /g, '  ') + '\n\n'
    assert.strictEqual((await handler(req('quick', undefined, spaced))).statusCode, 200)
    const edited = demoTranscript().replace('three people', 'four people')
    assert.strictEqual((await handler(req('quick', undefined, edited))).statusCode, 401)
  } finally { w.restore() }
})

test("the server's demo hash matches the demo text in index.html", () => {
  const crypto = require('crypto')
  const src = require('fs').readFileSync(require('path').join(require('./helpers/load').FUNCTIONS, 'evaluate.js'), 'utf8')
  const hash = src.match(/DEMO_TRANSCRIPT_SHA256 = '([0-9a-f]{64})'/)[1]
  const norm = demoTranscript().replace(/\s+/g, ' ').trim()
  assert.strictEqual(crypto.createHash('sha256').update(norm).digest('hex'), hash)
})

test('signed-in quick pass is counted once, on the server, after it succeeds', async () => {
  const w = profilesWorld({ 'user-1': { eval_count: 3, is_pro: false } })
  try {
    const { handler } = loadFunction('evaluate')
    const res = await handler(req('quick', 'tok-user'))
    assert.strictEqual(res.statusCode, 200)
    assert.strictEqual(w.profiles['user-1'].eval_count, 4)
    assert.strictEqual(w.patches.length, 1)
    assert.ok(w.patches[0].path.includes('eval_count=eq.3'), 'compare-and-set on the value that was read')
  } finally { w.restore() }
})

test('a failed quick pass is not counted', async () => {
  const w = profilesWorld({ 'user-1': { eval_count: 3, is_pro: false } }, { world: { anthropic: { respond: () => ({ status: 500, body: '{}' }) } } })
  try {
    const { handler } = loadFunction('evaluate')
    assert.strictEqual((await handler(req('quick', 'tok-user'))).statusCode, 502)
    assert.strictEqual(w.profiles['user-1'].eval_count, 3)
  } finally { w.restore() }
})

test('full mode never counts; a retry never counts or even reads the profile', async () => {
  const w = profilesWorld({ 'user-1': { eval_count: 3, is_pro: false } })
  try {
    const { handler } = loadFunction('evaluate')
    const full = await handler(req('full', 'tok-user'))
    assert.strictEqual(full.statusCode, 200)
    assert.strictEqual(w.patches.length, 0)
    const before = w.calls.filter((c) => c.path.startsWith('/rest/v1/profiles')).length
    const retry = await handler(req('full', 'tok-user', SAMPLE_TRANSCRIPT, { sections: ['Metrics', 'Champion'], retry_token: JSON.parse(full.body).retry_token }))
    assert.strictEqual(retry.statusCode, 200)
    assert.strictEqual(w.calls.filter((c) => c.path.startsWith('/rest/v1/profiles')).length, before)
    assert.strictEqual(w.profiles['user-1'].eval_count, 3)
  } finally { w.restore() }
})

test('at the free limit a non-pro user gets 402 upgrade_required before any model call (quick and full)', async () => {
  const w = profilesWorld({ 'user-1': { eval_count: 10, is_pro: false } })
  try {
    const { handler } = loadFunction('evaluate')
    for (const mode of ['quick', 'full']) {
      const res = await handler(req(mode, 'tok-user'))
      assert.strictEqual(res.statusCode, 402)
      assert.deepStrictEqual(JSON.parse(res.body), { error: 'upgrade_required' })
    }
    assert.strictEqual(w.anthropicCalls().length, 0)
    assert.strictEqual(w.profiles['user-1'].eval_count, 10)
  } finally { w.restore() }
})

test('at 9 the next evaluation is allowed and takes the count to exactly 10', async () => {
  const w = profilesWorld({ 'user-1': { eval_count: 9, is_pro: false } })
  try {
    const { handler } = loadFunction('evaluate')
    assert.strictEqual((await handler(req('quick', 'tok-user'))).statusCode, 200)
    assert.strictEqual(w.profiles['user-1'].eval_count, 10)
    assert.strictEqual((await handler(req('quick', 'tok-user'))).statusCode, 402)
  } finally { w.restore() }
})

test('a pro user is never limited', async () => {
  const w = profilesWorld({ 'user-1': { eval_count: 250, is_pro: true } })
  try {
    const { handler } = loadFunction('evaluate')
    assert.strictEqual((await handler(req('quick', 'tok-user'))).statusCode, 200)
    assert.strictEqual((await handler(req('full', 'tok-user'))).statusCode, 200)
  } finally { w.restore() }
})

test('the demo transcript is never blocked or counted, even for a signed-in user at the limit', async () => {
  const w = profilesWorld({ 'user-1': { eval_count: 10, is_pro: false } })
  try {
    const { handler } = loadFunction('evaluate')
    assert.strictEqual((await handler(req('quick', 'tok-user', demoTranscript()))).statusCode, 200)
    assert.strictEqual(w.patches.length, 0)
    assert.strictEqual(w.profiles['user-1'].eval_count, 10)
  } finally { w.restore() }
})

test('two evaluations finishing at once cannot lose a count (compare-and-set retries on conflict)', async () => {
  const w = profilesWorld({ 'user-1': { eval_count: 4, is_pro: false } }, { conflictsFirst: true })
  try {
    const { handler } = loadFunction('evaluate')
    assert.strictEqual((await handler(req('quick', 'tok-user'))).statusCode, 200)
    assert.strictEqual(w.profiles['user-1'].eval_count, 6)
  } finally { w.restore() }
})

test('if the profile cannot be read the evaluation still runs (and is not counted)', async () => {
  const w = profilesWorld({ 'user-1': { eval_count: 10, is_pro: false } }, { readStatus: 500 })
  try {
    const { handler } = loadFunction('evaluate')
    assert.strictEqual((await handler(req('quick', 'tok-user'))).statusCode, 200)
    assert.strictEqual(w.patches.length, 0)
  } finally { w.restore() }
})

test('the LegalFly gate still comes first: signed-out LegalFly is 403, not 401', async () => {
  const w = profilesWorld({})
  try {
    const { handler } = loadFunction('evaluate')
    const res = await handler(event({ transcript: SAMPLE_TRANSCRIPT, framework: 'LegalFly', customFields: [], mode: 'quick' }))
    assert.strictEqual(res.statusCode, 403)
  } finally { w.restore() }
})
