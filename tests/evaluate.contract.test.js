// Contract tests for netlify/functions/evaluate.js (baseline: written against
// the unmodified code, and must keep passing unchanged). No network: https is
// mocked. These pin the things scoring must never change: status codes,
// response shapes, section names/order, batching (max 3 sections per call),
// the model, and the LegalFly gate.
const test = require('node:test')
const assert = require('node:assert')
const { loadFunction, event, demoTranscript, SAMPLE_TRANSCRIPT, USERS } = require('./helpers/load')
const { makeWorld, SECTION_KEYS } = require('./helpers/backend')

const MODEL = 'claude-haiku-4-5-20251001'

const FRAMEWORKS = {
  MEDDIC: { sections: ['Metrics', 'Economic Buyer', 'Decision Criteria', 'Decision Process', 'Identify Pain', 'Champion'], split: [3, 3] },
  BANT: { sections: ['Budget', 'Authority', 'Need', 'Timeline'], split: [2, 2] },
  SPIN: { sections: ['Situation', 'Problem', 'Implication', 'Need-Payoff'], split: [2, 2] },
  Custom: { sections: ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon'], split: [3, 2], customFields: [
    { name: 'Alpha', desc: 'first thing' }, { name: 'Beta', desc: 'second thing' }, { name: 'Gamma', desc: 'third thing' },
    { name: 'Delta', desc: 'fourth thing' }, { name: 'Epsilon', desc: 'fifth thing' }] },
  LegalFly: { sections: ['Metrics', 'Economic Buyer', 'Decision Criteria', 'Decision Process', 'Identify Pain', 'Champion',
    'Security and Anonymisation Wedge', 'Competitive Positioning', 'ICP and Qualification Fit'], split: [3, 3, 3], token: 'tok-andrew' },
}

function world(extra = {}) {
  return makeWorld(Object.assign({
    users: USERS,
    rest: (rec) => (rec.path.startsWith('/rest/v1/profiles') && rec.method === 'GET'
      ? { status: 200, body: JSON.stringify([{ id: 'user-1', eval_count: 0, is_pro: false }]) } : undefined),
  }, extra))
}

function body(framework, mode, transcript = SAMPLE_TRANSCRIPT) {
  const f = FRAMEWORKS[framework]
  return { transcript, framework, customFields: f.customFields || [], dealName: 'Acme', persona: 'Sam (buyer)', mode, dealStage: '' }
}

for (const fwName of Object.keys(FRAMEWORKS)) {
  const f = FRAMEWORKS[fwName]
  const token = f.token || 'tok-user'

  test(fwName + ' quick mode: 200, exact response shape, one model call', async () => {
    const w = world()
    try {
      const { handler } = loadFunction('evaluate')
      const res = await handler(event(body(fwName, 'quick'), token))
      assert.strictEqual(res.statusCode, 200)
      const data = JSON.parse(res.body)
      assert.deepStrictEqual(Object.keys(data).sort(), ['overall_score', 'summary'])
      assert.ok(Number.isInteger(data.overall_score))
      assert.strictEqual(typeof data.summary, 'string')
      const calls = w.anthropicCalls()
      assert.strictEqual(calls.length, 1)
      assert.strictEqual(calls[0].model, MODEL)
      assert.strictEqual(calls[0].tool_choice.name, 'submit_quick_eval')
    } finally { w.restore() }
  })

  test(fwName + ' full mode: 200, sections in framework order, next_steps, at most 3 sections per call', async () => {
    const w = world()
    try {
      const { handler } = loadFunction('evaluate')
      const res = await handler(event(body(fwName, 'full'), token))
      assert.strictEqual(res.statusCode, 200)
      const data = JSON.parse(res.body)
      // retry_token (added after the baseline) is the only extra field permitted
      assert.deepStrictEqual(Object.keys(data).filter((k) => k !== 'retry_token').sort(), ['next_steps', 'sections'])
      assert.deepStrictEqual(data.sections.map((s) => s.name), f.sections, 'section names/order')
      data.sections.forEach((s) => assert.deepStrictEqual(Object.keys(s).sort(), SECTION_KEYS.slice().sort()))
      assert.ok(Array.isArray(data.next_steps) && data.next_steps.length === 3)
      const calls = w.anthropicCalls()
      assert.strictEqual(calls.length, f.split.length, 'number of model calls')
      const sizes = calls.map((c) => c.tools[0].input_schema.properties.sections.maxItems)
      assert.deepStrictEqual(sizes, f.split, 'sections per call')
      sizes.forEach((n) => assert.ok(n <= 3, 'never more than 3 sections per call'))
      calls.forEach((c) => {
        assert.strictEqual(c.model, MODEL)
        assert.strictEqual(c.max_tokens, 5000)
        assert.strictEqual(c.tool_choice.name, 'submit_section_eval')
      })
      assert.deepStrictEqual(calls.map((c) => !!c.tools[0].input_schema.properties.next_steps), f.split.map((_, i) => i === f.split.length - 1))
    } finally { w.restore() }
  })
}

test('transcript reaches the model unchanged (and the framework description comes with it)', async () => {
  const w = world()
  try {
    const { handler } = loadFunction('evaluate')
    await handler(event(body('MEDDIC', 'quick', SAMPLE_TRANSCRIPT), 'tok-user'))
    const text = JSON.stringify(w.anthropicCalls()[0].messages)
    assert.ok(text.includes(JSON.stringify(SAMPLE_TRANSCRIPT).slice(1, -1)))
    assert.ok(text.includes('Economic Buyer (ultimate decision maker identified and engaged)'))
  } finally { w.restore() }
})

test('the built-in demo transcript works for a signed-out visitor (quick + full)', async () => {
  const w = world()
  try {
    const { handler } = loadFunction('evaluate')
    const q = await handler(event(body('MEDDIC', 'quick', demoTranscript())))
    const f = await handler(event(body('MEDDIC', 'full', demoTranscript())))
    assert.strictEqual(q.statusCode, 200)
    assert.strictEqual(f.statusCode, 200)
  } finally { w.restore() }
})

test('non-POST is rejected with 405', async () => {
  const w = world()
  try {
    const { handler } = loadFunction('evaluate')
    const res = await handler({ httpMethod: 'GET', headers: {} })
    assert.strictEqual(res.statusCode, 405)
  } finally { w.restore() }
})

test('LegalFly is rejected for a signed-out visitor, before any model call or prompt assembly', async () => {
  const w = world()
  try {
    const { handler } = loadFunction('evaluate')
    for (const mode of ['quick', 'full']) {
      const res = await handler(event(body('LegalFly', mode)))
      assert.strictEqual(res.statusCode, 403)
    }
    assert.strictEqual(w.anthropicCalls().length, 0)
    assert.ok(!JSON.stringify(w.calls).includes('anonymisation'))
  } finally { w.restore() }
})

test('LegalFly is rejected for a different signed-in user', async () => {
  const w = world()
  try {
    const { handler } = loadFunction('evaluate')
    for (const mode of ['quick', 'full']) {
      const res = await handler(event(body('LegalFly', mode), 'tok-other'))
      assert.strictEqual(res.statusCode, 403)
    }
    assert.strictEqual(w.anthropicCalls().length, 0)
  } finally { w.restore() }
})

test('LegalFly is rejected for an invalid token', async () => {
  const w = world()
  try {
    const { handler } = loadFunction('evaluate')
    const res = await handler(event(body('LegalFly', 'quick'), 'not-a-real-token'))
    assert.strictEqual(res.statusCode, 403)
    assert.strictEqual(w.anthropicCalls().length, 0)
  } finally { w.restore() }
})

test('LegalFly full mode for the authorised user carries the full nine-section rubric', async () => {
  const w = world()
  try {
    const { handler } = loadFunction('evaluate')
    const res = await handler(event(body('LegalFly', 'full'), 'tok-andrew'))
    assert.strictEqual(res.statusCode, 200)
    const prompts = w.anthropicCalls().map((c) => JSON.stringify(c.messages))
    prompts.forEach((p) => assert.ok(p.includes('Security and Anonymisation Wedge')))
  } finally { w.restore() }
})

test('a failing model call surfaces as 502 and never leaks a partial 200 (baseline behaviour)', async () => {
  const w = world({ anthropic: { respond: () => ({ status: 500, body: '{"error":"x"}' }) } })
  try {
    const { handler } = loadFunction('evaluate')
    const res = await handler(event(body('MEDDIC', 'quick'), 'tok-user'))
    assert.strictEqual(res.statusCode, 502)
  } finally { w.restore() }
})
