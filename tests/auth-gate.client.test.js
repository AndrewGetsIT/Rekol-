// 0B (browser): sign-in gate, resume after sign-in, 402 prompt, demo, and the
// pending transcript living in sessionStorage only. Also: the browser never
// writes eval_count.
const test = require('node:test')
const assert = require('node:assert')
const { createSandbox } = require('./helpers/browser-sandbox')
const { demoTranscript, readIndexHtml } = require('./helpers/load')

const MEDDIC = ['Metrics', 'Economic Buyer', 'Decision Criteria', 'Decision Process', 'Identify Pain', 'Champion']
const sec = (name, i) => ({ name, score: 40 + i, status: 'amber', covered: 'c', gaps: 'g', coaching: 'k', next_step: 'n' })
const fullOk = { sections: MEDDIC.map(sec), next_steps: ['a', 'b', 'c'], retry_token: '123.abc' }
const quickOk = { overall_score: 62, summary: 'Fine.' }
const words = new Array(80).fill('word').join(' ') + ' my own call'
const resp = (body, status = 200) => Promise.resolve({ ok: status < 400, status, json: async () => body })
const PENDING = 'rekol_pending_eval'

function setup({ evaluate, signedIn = false, localStorage, sessionStorage } = {}) {
  const sb = createSandbox({
    token: signedIn ? 'tok' : null, user: { id: 'u1', email: 'rep@example.com' }, localStorage, sessionStorage,
    fetch: (url, init) => (/evaluate/.test(url) ? evaluate(JSON.parse(init.body)) : resp({ claimed: 0 })),
  })
  sb.run('signedIn=' + signedIn + (signedIn ? "; currentUser={id:'u1',email:'rep@example.com',user_metadata:{}}" : ''))
  const goCalls = []
  const orig = sb.ctx.go
  sb.ctx.go = (v) => { goCalls.push(v); return orig(v) }
  return { sb, goCalls }
}
const evalCalls = (sb) => sb.fetchCalls.filter((c) => /evaluate/.test(c.url))

test('signed out + own transcript: no request is made, the sign-in modal opens with the right line, the transcript is kept', async () => {
  const { sb, goCalls } = setup({ evaluate: () => resp(quickOk) })
  sb.el('ta').value = words
  await sb.ctx.runEval()
  assert.strictEqual(evalCalls(sb).length, 0)
  assert.ok(!goCalls.includes('loading'))
  assert.ok(sb.el('ov-signin').classList.contains('on'))
  assert.strictEqual(sb.el('signin-msg').textContent, 'Sign in to score your own call. Takes 10 seconds.')
  assert.strictEqual(sb.el('ta').value, words)
  assert.strictEqual(JSON.parse(sb.sessionStore[PENDING]).t, words)
})

test('the pending transcript is in sessionStorage and never in localStorage', async () => {
  const { sb } = setup({ evaluate: () => resp(quickOk) })
  sb.el('ta').value = words
  await sb.ctx.runEval()
  assert.ok(sb.sessionStore[PENDING])
  assert.strictEqual(sb.store[PENDING], undefined)
  assert.ok(!JSON.stringify(sb.store).includes('my own call'))
})

test('a 401 from the server (e.g. expired session) opens the modal and keeps the transcript', async () => {
  const { sb, goCalls } = setup({ signedIn: true, evaluate: () => resp({ error: 'sign_in_required' }, 401) })
  sb.el('ta').value = words
  await sb.ctx.runEval()
  assert.strictEqual(goCalls[goCalls.length - 1], 'home')
  assert.ok(sb.el('ov-signin').classList.contains('on'))
  assert.strictEqual(sb.el('signin-msg').textContent, 'Sign in to score your own call. Takes 10 seconds.')
  assert.strictEqual(sb.el('ta').value, words)
  assert.ok(sb.sessionStore[PENDING])
  assert.ok(!sb.toasts.some((t) => /Something went wrong/.test(t)))
})

test('after sign-in the evaluation re-runs automatically, with the transcript, and the stash is cleared at once', async () => {
  const { sb } = setup({ evaluate: (b) => resp(b.mode === 'quick' ? quickOk : fullOk) })
  sb.el('ta').value = words
  await sb.ctx.runEval()
  assert.strictEqual(evalCalls(sb).length, 0)
  // user signs in
  sb.run("signedIn=true; currentUser={id:'u1',email:'rep@example.com',user_metadata:{}}")
  sb.el('ta').value = ''           // as if the page had reloaded after Google sign-in
  await sb.ctx.onAuthStateChange({ id: 'u1', email: 'rep@example.com', user_metadata: {} })
  await sb.settle()
  const calls = evalCalls(sb)
  assert.deepStrictEqual(calls.map((c) => c.body.mode).sort(), ['full', 'quick'])
  calls.forEach((c) => assert.strictEqual(c.body.transcript, words))
  assert.strictEqual(sb.sessionStore[PENDING], undefined, 'cleared as soon as it is resumed')
  assert.strictEqual(sb.el('ta').value, words, 'transcript still in the box')
  assert.ok(sb.toasts.some((t) => /scoring your call now/i.test(t)))
})

test('the pending transcript is cleared when the sign-in modal is dismissed', async () => {
  const { sb } = setup({ evaluate: () => resp(quickOk) })
  sb.el('ta').value = words
  await sb.ctx.runEval()
  assert.ok(sb.sessionStore[PENDING])
  sb.ctx.dismissSignIn()
  assert.strictEqual(sb.sessionStore[PENDING], undefined)
  assert.ok(!sb.el('ov-signin').classList.contains('on'))
})

test('a pending transcript older than 30 minutes is not resumed and is removed', async () => {
  const stale = JSON.stringify({ t: words, deal: '', persona: '', fw: 'MEDDIC', stage: '', at: Date.now() - 31 * 60 * 1000 })
  const { sb } = setup({ evaluate: () => resp(quickOk), sessionStorage: { [PENDING]: stale } })
  sb.run("signedIn=true; currentUser={id:'u1',email:'rep@example.com',user_metadata:{}}")
  const resumed = sb.ctx.resumePendingEval()
  assert.strictEqual(resumed, false)
  assert.strictEqual(sb.sessionStore[PENDING], undefined)
  assert.strictEqual(evalCalls(sb).length, 0)
})

test('the 30-minute expiry is also scheduled when the transcript is stashed', async () => {
  let scheduled = null
  const { sb } = setup({ evaluate: () => resp(quickOk) })
  sb.ctx.setTimeout = (fn, ms) => { scheduled = { fn, ms }; return 1 }
  sb.el('ta').value = words
  await sb.ctx.runEval()
  assert.strictEqual(scheduled.ms, 30 * 60 * 1000)
  scheduled.fn()
  assert.strictEqual(sb.sessionStore[PENDING], undefined)
})

test('page load removes any transcript left in localStorage by an earlier version', async () => {
  const { sb } = setup({ evaluate: () => resp(quickOk), localStorage: { [PENDING]: JSON.stringify({ t: 'old secret call' }) } })
  assert.ok(sb.store[PENDING])
  sb.fireDomReady()
  assert.strictEqual(sb.store[PENDING], undefined)
})

test('a 402 shows the upgrade prompt (not a generic error) and keeps the transcript', async () => {
  const { sb, goCalls } = setup({ signedIn: true, evaluate: () => resp({ error: 'upgrade_required' }, 402) })
  sb.el('ta').value = words
  await sb.ctx.runEval()
  assert.ok(sb.el('ov-upgrade').classList.contains('on'))
  assert.strictEqual(goCalls[goCalls.length - 1], 'home')
  assert.ok(!sb.toasts.some((t) => /Something went wrong/.test(t)))
  assert.strictEqual(sb.el('ta').value, words)
})

test('signed in at the local limit, a real transcript shows the upgrade prompt without calling the server', async () => {
  const { sb } = setup({ signedIn: true, evaluate: () => resp(quickOk) })
  sb.run('evalCount=10')
  sb.el('ta').value = words
  await sb.ctx.runEval()
  assert.ok(sb.el('ov-upgrade').classList.contains('on'))
  assert.strictEqual(evalCalls(sb).length, 0)
})

test('the demo transcript runs signed out and never touches the counter', async () => {
  const { sb } = setup({ evaluate: (b) => resp(b.mode === 'quick' ? quickOk : fullOk) })
  sb.el('ta').value = demoTranscript()
  sb.run('evalCount=3')
  await sb.ctx.runEval()
  await sb.settle()
  assert.strictEqual(evalCalls(sb).length, 2)
  assert.strictEqual(sb.ctx.evalCount, 3)
  assert.ok(!sb.el('ov-signin').classList.contains('on'))
  assert.strictEqual(sb.sessionStore[PENDING], undefined)
  assert.strictEqual(sb.profileWrites.length, 0)
})

test('the demo transcript is free even for a signed-in user at the limit', async () => {
  const { sb } = setup({ signedIn: true, evaluate: (b) => resp(b.mode === 'quick' ? quickOk : fullOk) })
  sb.run('evalCount=10')
  sb.el('ta').value = demoTranscript()
  await sb.ctx.runEval()
  assert.strictEqual(evalCalls(sb).length, 2)
  assert.ok(!sb.el('ov-upgrade').classList.contains('on'))
})

test('the retry token from the full pass is sent with a retry', async () => {
  const partial = { sections: MEDDIC.slice(0, 3).map(sec), next_steps: [], failed_sections: MEDDIC.slice(3), needs_next_steps: true, retry_token: 'tok.123' }
  const { sb } = setup({ signedIn: true, evaluate: (b) => resp(b.mode === 'quick' ? quickOk : b.sections ? { sections: [], next_steps: [] } : partial) })
  sb.el('ta').value = words
  await sb.ctx.runEval()
  await sb.ctx.retryFailedSections()
  const retry = evalCalls(sb).pop().body
  assert.strictEqual(retry.retry_token, 'tok.123')
})

test('the browser never writes eval_count to Supabase: nothing in the code, nothing at runtime', async () => {
  const src = readIndexHtml()
  assert.ok(!/syncEvalCount/.test(src))
  assert.ok(!/\.update\(\s*\{[^}]*eval_count/.test(src), 'no profiles update touching eval_count')
  assert.ok(!/eval_count\s*:/.test(src.replace(/res\.data\.eval_count/g, '')), 'no eval_count being sent anywhere')
  const { sb } = setup({ signedIn: true, evaluate: (b) => resp(b.mode === 'quick' ? quickOk : fullOk) })
  sb.el('ta').value = words
  await sb.ctx.runEval()
  await sb.settle()
  assert.ok(!sb.profileWrites.some((w) => 'eval_count' in w))
})
