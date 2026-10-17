// 0D (browser): the score stays on screen when a batch fails, failed
// sections can be retried on their own, retries never count as a new
// evaluation, and only a failed quick pass sends the user back to the form.
const test = require('node:test')
const assert = require('node:assert')
const { createSandbox } = require('./helpers/browser-sandbox')

const MEDDIC = ['Metrics', 'Economic Buyer', 'Decision Criteria', 'Decision Process', 'Identify Pain', 'Champion']
const sec = (name, i) => ({ name, score: 40 + i, status: 'amber', covered: 'c ' + name, gaps: 'g', coaching: 'k', next_step: 'n' })
const words = new Array(80).fill('word').join(' ')
const resp = (body, status = 200) => Promise.resolve({ ok: status < 400, status, json: async () => body })

function setup({ evaluate, signedIn = true, insertResult } = {}) {
  const inserts = []
  const sb = createSandbox({
    token: 'tok', user: { id: 'u1', email: 'rep@example.com' },
    onInsert: (row) => inserts.push(row), insertResult,
    fetch: (url, init, n) => evaluate(JSON.parse(init.body), n),
  })
  sb.run("signedIn=" + signedIn + "; currentUser={id:'u1',email:'rep@example.com'}")
  sb.el('ta').value = words
  const goCalls = []
  const orig = sb.ctx.go
  sb.ctx.go = (v) => { goCalls.push(v); return orig(v) }
  return { sb, inserts, goCalls }
}

const quickOk = { overall_score: 62, summary: 'Fine.' }
const partial = { sections: MEDDIC.slice(0, 3).map(sec), next_steps: [], failed_sections: MEDDIC.slice(3), needs_next_steps: true }
const cardsText = (sb) => sb.el('sec-cards').innerHTML

test('a failed batch keeps the score and loaded sections on screen and offers retry', async () => {
  const { sb, goCalls, inserts } = setup({ evaluate: (b) => resp(b.mode === 'quick' ? quickOk : partial) })
  await sb.ctx.runEval()
  assert.ok(!goCalls.includes('home'), 'must not bounce to the form')
  assert.ok(goCalls.includes('output'))
  assert.strictEqual(sb.ctx.curEval.overall_score, 62)
  assert.strictEqual(sb.el('score-n').textContent, '62')
  const html = cardsText(sb)
  assert.strictEqual((html.match(/Couldn't score this section/g) || []).length, 3)
  MEDDIC.slice(0, 3).forEach((n) => assert.ok(html.includes(n + '</div><div class="sec-sc">')))
  assert.ok(html.includes('Retry'))
  assert.strictEqual(sb.el('out-h').textContent, 'Evaluation partly complete')
  assert.strictEqual(inserts.length, 0, 'held until the user leaves or everything loads')
})

test('leaving with failed sections saves what exists, with section_status', async () => {
  const { sb, inserts } = setup({ evaluate: (b) => resp(b.mode === 'quick' ? quickOk : partial) })
  await sb.ctx.runEval()
  sb.ctx.go('home')
  await sb.settle()
  assert.strictEqual(inserts.length, 1)
  assert.strictEqual(inserts[0].sections.length, 3)
  assert.deepStrictEqual(inserts[0].section_status, { Metrics: 'done', 'Economic Buyer': 'done', 'Decision Criteria': 'done', 'Decision Process': 'failed', 'Identify Pain': 'failed', Champion: 'failed' })
  assert.strictEqual(JSON.parse(sb.store.rekol_hist).length, 1)
})

test('section_status falls back cleanly when the column does not exist yet (migration not applied)', async () => {
  const { sb, inserts } = setup({
    evaluate: (b) => resp(b.mode === 'quick' ? quickOk : partial),
    insertResult: (row) => (row.section_status ? { error: { message: 'column section_status does not exist' } } : { error: null }),
  })
  await sb.ctx.runEval()
  sb.ctx.go('home')
  await sb.settle()
  assert.strictEqual(inserts.length, 2)
  assert.ok(inserts[0].section_status)
  assert.strictEqual(inserts[1].section_status, undefined)
  assert.strictEqual(inserts[1].sections.length, 3)
})

test('retry sends only the failed sections, does not run quick again, and does not count as a new evaluation', async () => {
  const seen = []
  const { sb, inserts } = setup({
    evaluate: (b) => {
      seen.push(b)
      if (b.mode === 'quick') return resp(quickOk)
      if (b.sections) return resp({ sections: MEDDIC.slice(3).map((n, i) => sec(n, i + 3)), next_steps: ['a', 'b', 'c'] })
      return resp(partial)
    },
  })
  await sb.ctx.runEval()
  assert.strictEqual(sb.ctx.evalCount, 1)
  await sb.ctx.retryFailedSections()
  const retry = seen[seen.length - 1]
  assert.strictEqual(retry.mode, 'full')
  assert.deepStrictEqual(retry.sections, MEDDIC.slice(3))
  assert.strictEqual(retry.includeNextSteps, true)
  assert.strictEqual(seen.filter((b) => b.mode === 'quick').length, 1)
  assert.strictEqual(sb.ctx.evalCount, 1, 'retry must not count against the free tier')
  assert.strictEqual(sb.ctx.curEval.sections.length, 6)
  assert.deepStrictEqual(sb.plain(sb.ctx.curEval.sections.map((s) => s.name)), MEDDIC, 'merged in framework order')
  assert.strictEqual(sb.ctx.curEval.next_steps.length, 3)
  assert.strictEqual(sb.el('out-h').textContent, 'Evaluation complete')
  assert.ok(!cardsText(sb).includes("Couldn't score"))
  await sb.settle()
  assert.strictEqual(inserts.length, 1, 'saved once, complete')
  assert.strictEqual(inserts[0].section_status, undefined)
  assert.strictEqual(inserts[0].sections.length, 6)
  assert.strictEqual(JSON.parse(sb.store.rekol_hist).length, 1)
})

test('a retry that fails again leaves the failed sections in place and the save pending', async () => {
  const { sb, inserts } = setup({
    evaluate: (b) => (b.mode === 'quick' ? resp(quickOk) : b.sections ? resp({ error: 'x' }, 502) : resp(partial)),
  })
  await sb.ctx.runEval()
  await sb.ctx.retryFailedSections()
  assert.strictEqual((cardsText(sb).match(/Couldn't score this section/g) || []).length, 3)
  assert.ok(sb.toasts.some((t) => /try again/i.test(t)))
  assert.strictEqual(inserts.length, 0)
  assert.strictEqual(sb.ctx.evalCount, 1)
})

test('if the whole full pass fails, the score stays and every section offers a retry', async () => {
  const { sb, goCalls } = setup({ evaluate: (b) => (b.mode === 'quick' ? resp(quickOk) : Promise.reject(new Error('network down'))) })
  await sb.ctx.runEval()
  assert.ok(!goCalls.includes('home'))
  assert.strictEqual(sb.el('score-n').textContent, '62')
  assert.strictEqual((cardsText(sb).match(/Couldn't score this section/g) || []).length, 6)
})

test('only a failed quick pass returns to the form, and the transcript is still in the box', async () => {
  const { sb, goCalls } = setup({ evaluate: (b) => (b.mode === 'quick' ? resp({ error: 'x' }, 500) : resp(partial)) })
  await sb.ctx.runEval()
  assert.strictEqual(goCalls[goCalls.length - 1], 'home')
  assert.strictEqual(sb.el('ta').value, words)
  assert.ok(sb.toasts.some((t) => /transcript is still there/i.test(t)))
})

test('a fully successful run is saved once, with no section_status', async () => {
  const full = { sections: MEDDIC.map(sec), next_steps: ['a', 'b', 'c'] }
  const { sb, inserts } = setup({ evaluate: (b) => resp(b.mode === 'quick' ? quickOk : full) })
  await sb.ctx.runEval()
  await sb.settle()
  assert.strictEqual(inserts.length, 1)
  assert.strictEqual(inserts[0].section_status, undefined)
  assert.strictEqual(JSON.parse(sb.store.rekol_hist).length, 1, 'no duplicate local history entry')
  assert.strictEqual(sb.el('out-h').textContent, 'Evaluation complete')
})
