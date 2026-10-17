// 0D (server): a failed batch no longer throws away the batches that worked,
// and a `sections` subset re-scores only the sections asked for.
const test = require('node:test')
const assert = require('node:assert')
const { loadFunction, event, SAMPLE_TRANSCRIPT, USERS } = require('./helpers/load')
const { makeWorld } = require('./helpers/backend')

const MEDDIC = ['Metrics', 'Economic Buyer', 'Decision Criteria', 'Decision Process', 'Identify Pain', 'Champion']
const req = (extra) => event(Object.assign({ transcript: SAMPLE_TRANSCRIPT, framework: 'MEDDIC', customFields: [], mode: 'full' }, extra), 'tok-user')
const world = (anthropic) => makeWorld({
  users: USERS,
  anthropic,
  rest: (rec) => (rec.path.startsWith('/rest/v1/profiles') ? { status: 200, body: JSON.stringify([{ id: 'user-1', eval_count: 0, is_pro: false }]) } : undefined),
})

test('last batch fails: 200 with the first batch, failed_sections, and needs_next_steps', async () => {
  const w = world({ failSections: new Set(['Champion']) })
  try {
    const { handler } = loadFunction('evaluate')
    const res = await handler(req())
    assert.strictEqual(res.statusCode, 200)
    const data = JSON.parse(res.body)
    assert.deepStrictEqual(data.sections.map((s) => s.name), MEDDIC.slice(0, 3))
    assert.deepStrictEqual(data.failed_sections, MEDDIC.slice(3))
    assert.strictEqual(data.needs_next_steps, true)
    assert.deepStrictEqual(data.next_steps, [])
    assert.strictEqual(w.anthropicCalls().length, 2)
  } finally { w.restore() }
})

test('first batch fails: 200 with the later batch and its next_steps; nothing duplicated', async () => {
  const w = world({ failSections: new Set(['Metrics']) })
  try {
    const { handler } = loadFunction('evaluate')
    const data = JSON.parse((await handler(req())).body)
    assert.deepStrictEqual(data.sections.map((s) => s.name), MEDDIC.slice(3))
    assert.deepStrictEqual(data.failed_sections, MEDDIC.slice(0, 3))
    assert.strictEqual(data.needs_next_steps, false)
    assert.strictEqual(data.next_steps.length, 3)
  } finally { w.restore() }
})

test('every batch fails: still a 502 (unchanged), so the browser keeps its retry-once behaviour', async () => {
  const w = world({ respond: (body) => (body.tool_choice.name === 'submit_section_eval' ? { status: 500, body: '{}' } : undefined) })
  try {
    const { handler } = loadFunction('evaluate')
    assert.strictEqual((await handler(req())).statusCode, 502)
  } finally { w.restore() }
})

test('a subset call scores only the requested sections, in one model call', async () => {
  const w = world({})
  try {
    const { handler } = loadFunction('evaluate')
    const res = await handler(req({ sections: ['Champion', 'Decision Process', 'Identify Pain'], includeNextSteps: true }))
    assert.strictEqual(res.statusCode, 200)
    const data = JSON.parse(res.body)
    assert.deepStrictEqual(data.sections.map((s) => s.name), ['Decision Process', 'Identify Pain', 'Champion'])
    assert.strictEqual(data.next_steps.length, 3)
    assert.strictEqual(data.failed_sections, undefined)
    const calls = w.anthropicCalls()
    assert.strictEqual(calls.length, 1)
    const schema = calls[0].tools[0].input_schema.properties.sections
    assert.deepStrictEqual(schema.items.properties.name.enum, ['Decision Process', 'Identify Pain', 'Champion'])
    assert.strictEqual(schema.maxItems, 3)
    assert.ok(calls[0].messages[0].content.includes('Only evaluate these specific sections'))
  } finally { w.restore() }
})

test('a subset call does not ask for next_steps unless told to', async () => {
  const w = world({})
  try {
    const { handler } = loadFunction('evaluate')
    const data = JSON.parse((await handler(req({ sections: ['Metrics'] }))).body)
    assert.deepStrictEqual(data.next_steps, [])
    assert.ok(!w.anthropicCalls()[0].tools[0].input_schema.properties.next_steps)
  } finally { w.restore() }
})

test('a subset of more than 3 sections is still batched at most 3 per call', async () => {
  const w = world({})
  try {
    const { handler } = loadFunction('evaluate')
    assert.strictEqual((await handler(req({ sections: MEDDIC.slice(0, 5) }))).statusCode, 200)
    w.anthropicCalls().forEach((c) => assert.ok(c.tools[0].input_schema.properties.sections.maxItems <= 3))
  } finally { w.restore() }
})

test('invalid subsets are refused with 400 before any model call', async () => {
  const w = world({})
  try {
    const { handler } = loadFunction('evaluate')
    for (const bad of [['Not A Section'], ['Metrics', 'Metrics'], ['Metrics', 7]]) {
      assert.strictEqual((await handler(req({ sections: bad }))).statusCode, 400, JSON.stringify(bad))
    }
    assert.strictEqual(w.anthropicCalls().length, 0)
  } finally { w.restore() }
})
