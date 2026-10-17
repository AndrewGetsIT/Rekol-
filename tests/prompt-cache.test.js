// 0A: prompt caching behind PROMPT_CACHE (default off).
const test = require('node:test')
const assert = require('node:assert')
const { loadFunction, event, SAMPLE_TRANSCRIPT, USERS } = require('./helpers/load')
const { makeWorld, SECTION_KEYS } = require('./helpers/backend')

const profile = (rec) => (rec.path.startsWith('/rest/v1/profiles') ? { status: 200, body: JSON.stringify([{ id: 'x', eval_count: 0, is_pro: false }]) } : undefined)
const mk = (anthropic = {}) => makeWorld({ users: USERS, anthropic, rest: profile })
const body = (mode, fw = 'MEDDIC', extra = {}) => Object.assign({
  transcript: SAMPLE_TRANSCRIPT, framework: fw, customFields: [], dealName: 'Acme', persona: 'Sam (buyer)', mode, dealStage: 'Demo' }, extra)
const tokenFor = (fw) => (fw === 'LegalFly' ? 'tok-andrew' : 'tok-user')

async function runBoth(env, fw = 'MEDDIC', anthropic = {}) {
  const w = mk(anthropic)
  const { handler } = loadFunction('evaluate', env)
  const q = await handler(event(body('quick', fw), tokenFor(fw)))
  const f = await handler(event(body('full', fw), tokenFor(fw)))
  const calls = w.anthropicCalls()
  w.restore()
  return { q, f, calls, w }
}
const prefix = (c) => JSON.stringify({ tools: c.tools, system: c.system })

test('flag off (default): requests are exactly the old shape, no system block, no cache_control', async () => {
  delete process.env.PROMPT_CACHE
  const { calls } = await runBoth({ PROMPT_CACHE: '' })
  assert.strictEqual(calls.length, 3)
  calls.forEach((c) => {
    assert.strictEqual(c.system, undefined)
    assert.ok(!JSON.stringify(c).includes('cache_control'))
    assert.strictEqual(c.tools.length, 1)
  })
  assert.ok(calls[0].messages[0].content.includes('Transcript:'), 'transcript still in the user message')
})

test('flag on: the prefix (tools + system) is byte-identical across the quick call and every batch', async () => {
  const { calls } = await runBoth({ PROMPT_CACHE: 'on' })
  assert.strictEqual(calls.length, 3) // quick + 2 batches
  const ref = prefix(calls[0])
  calls.forEach((c) => assert.strictEqual(prefix(c), ref))
  // but the forced tool and the instruction differ per call
  assert.deepStrictEqual(calls.map((c) => c.tool_choice.name), ['submit_quick_eval', 'submit_section_eval', 'submit_section_eval'])
  assert.notStrictEqual(calls[1].messages[0].content, calls[2].messages[0].content)
})

test('flag on: the cache breakpoint is on the last system block, after the transcript; nothing varying precedes it', async () => {
  const { calls } = await runBoth({ PROMPT_CACHE: 'on' })
  calls.forEach((c) => {
    assert.strictEqual(c.system.length, 1)
    assert.deepStrictEqual(c.system[0].cache_control, { type: 'ephemeral' })
    assert.ok(c.system[0].text.trimEnd().endsWith(SAMPLE_TRANSCRIPT.trimEnd()), 'system block ends with the transcript')
    assert.ok(c.system[0].text.includes('Economic Buyer (ultimate decision maker identified and engaged)'), 'full framework definition is in the prefix')
    assert.ok(!c.messages[0].content.includes(SAMPLE_TRANSCRIPT.slice(0, 60)), 'transcript is not repeated after the breakpoint')
    assert.ok(!JSON.stringify(c.tools).includes('cache_control') && !JSON.stringify(c.messages).includes('cache_control'))
  })
  // mode-specific text is after the breakpoint only
  const [q, b1, b2] = calls
  assert.ok(q.messages[0].content.startsWith('Call submit_quick_eval'))
  assert.ok(b1.messages[0].content.includes('Metrics, Economic Buyer, Decision Criteria'))
  assert.ok(b2.messages[0].content.includes('Decision Process, Identify Pain, Champion'))
  assert.ok(!calls[0].system[0].text.includes('Evaluate these sections') && !calls[0].system[0].text.includes('Only evaluate'))
})

test('flag on: output, section names/order, batching and the model are unchanged', async () => {
  const { q, f, calls } = await runBoth({ PROMPT_CACHE: 'on' })
  assert.deepStrictEqual(Object.keys(JSON.parse(q.body)).sort(), ['overall_score', 'summary'])
  const data = JSON.parse(f.body)
  assert.deepStrictEqual(data.sections.map((s) => s.name), ['Metrics', 'Economic Buyer', 'Decision Criteria', 'Decision Process', 'Identify Pain', 'Champion'])
  data.sections.forEach((s) => assert.deepStrictEqual(Object.keys(s).sort(), SECTION_KEYS.slice().sort()))
  assert.strictEqual(data.next_steps.length, 3)
  calls.forEach((c) => assert.strictEqual(c.model, 'claude-haiku-4-5-20251001'))
  assert.deepStrictEqual(calls.slice(1).map((c) => c.messages[0].content.match(/exactly (\d+) entries/)[1]), ['3', '3'])
})

test('flag on, LegalFly: nine sections in three batches of three, same prefix as quick, full rubric in the prefix', async () => {
  const { f, calls } = await runBoth({ PROMPT_CACHE: 'on' }, 'LegalFly')
  assert.strictEqual(calls.length, 4)
  const ref = prefix(calls[0])
  calls.forEach((c) => assert.strictEqual(prefix(c), ref))
  assert.ok(calls[0].system[0].text.includes('Security and Anonymisation Wedge: Did the rep position'))
  assert.strictEqual(JSON.parse(f.body).sections.length, 9)
  assert.deepStrictEqual(calls.slice(1).map((c) => c.messages[0].content.match(/exactly (\d+) entries/)[1]), ['3', '3', '3'])
})

test('flag on, Custom: the shared tool schema lists the custom section names', async () => {
  const w = mk()
  try {
    const { handler } = loadFunction('evaluate', { PROMPT_CACHE: 'on' })
    const res = await handler(event(body('full', 'Custom', { customFields: [{ name: 'Alpha', desc: 'a' }, { name: 'Beta', desc: 'b' }, { name: 'Gamma', desc: 'c' }, { name: 'Delta', desc: 'd' }] }), 'tok-user'))
    assert.strictEqual(res.statusCode, 200)
    const t = w.anthropicCalls()[0].tools.find((x) => x.name === 'submit_section_eval')
    assert.deepStrictEqual(t.input_schema.properties.sections.items.properties.name.enum, ['Alpha', 'Beta', 'Gamma', 'Delta'])
  } finally { w.restore() }
})

test('flag on: a batch that returns sections it was not assigned is rejected (the per-call enum is gone, so this is checked server-side)', async () => {
  const w = mk({
    respond: (b) => (b.tool_choice.name === 'submit_section_eval' && /Decision Process/.test(b.messages[0].content)
      ? { status: 200, body: JSON.stringify({ content: [{ type: 'tool_use', name: 'submit_section_eval', input: { sections: ['Metrics', 'Economic Buyer', 'Decision Criteria'].map((name) => ({ name, score: 50, status: 'amber', covered: 'c', gaps: 'g', coaching: 'k', next_step: 'n' })), next_steps: [] } }], usage: {} }) }
      : undefined),
  })
  try {
    const { handler } = loadFunction('evaluate', { PROMPT_CACHE: 'on' })
    const res = await handler(event(body('full'), 'tok-user'))
    const data = JSON.parse(res.body)
    assert.strictEqual(res.statusCode, 200)
    assert.deepStrictEqual(data.failed_sections, ['Decision Process', 'Identify Pain', 'Champion'])
    assert.strictEqual(data.sections.length, 3)
  } finally { w.restore() }
})

test('flag on: the first batch gets ~1s head start before the others launch; flag off launches together', async () => {
  const gap = async (env) => {
    const w = mk({ delay: (b) => (b.tool_choice.name === 'submit_section_eval' ? 1500 : 0) })
    try {
      const { handler } = loadFunction('evaluate', env)
      await handler(event(body('full'), 'tok-user'))
      const t = w.calls.filter((c) => c.hostname === 'api.anthropic.com').map((c) => c.at).sort((a, b) => a - b)
      return t[1] - t[0]
    } finally { w.restore() }
  }
  const staggered = await gap({ PROMPT_CACHE: 'on' })
  assert.ok(staggered >= 900 && staggered < 1400, 'stagger ' + staggered)
  const together = await gap({ PROMPT_CACHE: '' })
  assert.ok(together < 200, 'no stagger when off: ' + together)
})

test('flag on: very long transcripts skip the stagger to protect the time budget', async () => {
  const w = mk({ delay: () => 1200 })
  try {
    const { handler } = loadFunction('evaluate', { PROMPT_CACHE: 'on' })
    const long = 'word '.repeat(13000) // > 60,000 characters
    await handler(event(body('full', 'MEDDIC', { transcript: long }), 'tok-user'))
    const t = w.calls.filter((c) => c.hostname === 'api.anthropic.com').map((c) => c.at).sort((a, b) => a - b)
    assert.ok(t[1] - t[0] < 200, 'launched together: ' + (t[1] - t[0]))
  } finally { w.restore() }
})

test('cache usage is logged for every call, as numbers only (no transcript or model text)', async () => {
  const logs = []
  const orig = console.log
  console.log = (...a) => logs.push(a.join(' '))
  try {
    await runBoth({ PROMPT_CACHE: 'on' }, 'MEDDIC', { usage: { cache_creation_input_tokens: 4200, cache_read_input_tokens: 0 } })
  } finally { console.log = orig }
  const usage = logs.filter((l) => l.includes('usage —'))
  assert.strictEqual(usage.length, 3)
  usage.forEach((l) => assert.match(l, /cache_write: 4200 cache_read: 0/))
  assert.ok(!logs.join('\n').includes('renewals'), 'no transcript text in logs')
})

test('the shared cached prefix does not depend on the mode or batch (no per-call values before the breakpoint)', async () => {
  const w = mk()
  try {
    const { handler } = loadFunction('evaluate', { PROMPT_CACHE: 'on' })
    await handler(event(body('full', 'SPIN'), 'tok-user'))
    await handler(event(body('full', 'SPIN'), 'tok-user'))
    const c = w.anthropicCalls()
    assert.strictEqual(new Set(c.map(prefix)).size, 1, 'same evaluation, same prefix, across repeated requests too')
  } finally { w.restore() }
})
