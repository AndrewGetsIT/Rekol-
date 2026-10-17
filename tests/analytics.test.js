// 0C: cookieless analytics. Only a fixed list of events; the only properties
// ever sent are a built-in framework name and a mode.
const test = require('node:test')
const assert = require('node:assert')
const { createSandbox } = require('./helpers/browser-sandbox')
const { readIndexHtml, demoTranscript } = require('./helpers/load')

const EVENTS = ['demo_run', 'eval_started', 'eval_completed', 'eval_failed', 'signin_prompted', 'signin_completed', 'paywall_shown', 'share_created', 'team_created', 'crm_copied']
const MEDDIC = ['Metrics', 'Economic Buyer', 'Decision Criteria', 'Decision Process', 'Identify Pain', 'Champion']
const sec = (name, i) => ({ name, score: 40 + i, status: 'amber', covered: 'c', gaps: 'g', coaching: 'k', next_step: 'n' })
const resp = (body, status = 200) => Promise.resolve({ ok: status < 400, status, json: async () => body })
const words = new Array(80).fill('secretword').join(' ') + ' my own call'

function setup(evaluate, signedIn = false) {
  const events = []
  const sb = createSandbox({
    plausible: (name, opts) => events.push({ name, props: opts && opts.props }),
    fetch: (url, init) => (/evaluate/.test(url) ? evaluate(JSON.parse(init.body)) : /share/.test(url) ? resp({ id: 'abc' }) : resp({ claimed: 0 })),
  })
  sb.run('signedIn=' + signedIn + (signedIn ? ",currentUser={id:'u1',email:'a@b.c',user_metadata:{}}" : ''))
  return { sb, events }
}
const ok = (b) => resp(b.mode === 'quick' ? { overall_score: 62, summary: 'Fine' } : { sections: MEDDIC.map(sec), next_steps: ['a', 'b', 'c'] })

test('the Plausible script is present for getrekol.com and the commented-out GA tag is gone', () => {
  const html = readIndexHtml()
  assert.ok(/<script defer data-domain="getrekol.com" src="https:\/\/plausible.io\/js\/script.js"><\/script>/.test(html))
  assert.ok(!/googletagmanager|gtag\(|G-XXXXXXXXXX/.test(html))
})

test('track() drops unknown events and strips everything except framework and mode', () => {
  const { sb, events } = setup(ok)
  sb.ctx.track('not_an_event', { framework: 'MEDDIC' })
  sb.ctx.track('demo_run', { framework: 'MEDDIC', mode: 'full', email: 'a@b.c', transcript: 'secret', score: 80, dealName: 'Acme' })
  sb.ctx.track('demo_run', { framework: 'My Secret Custom Framework', mode: 'weird' })
  sb.ctx.track('crm_copied')
  assert.deepStrictEqual(sb.plain(events), [
    { name: 'demo_run', props: { framework: 'MEDDIC', mode: 'full' } },
    { name: 'demo_run' },
    { name: 'crm_copied' },
  ])
})

test('a demo run signed out sends demo_run, eval_started and eval_completed with only the framework', async () => {
  const { sb, events } = setup(ok)
  sb.el('ta').value = demoTranscript()
  await sb.ctx.runEval()
  await sb.settle()
  assert.deepStrictEqual(sb.plain(events.map((e) => e.name)), ['eval_started', 'demo_run', 'eval_completed'])
  events.forEach((e) => assert.deepStrictEqual(sb.plain(e.props), { framework: 'MEDDIC' }))
})

test('a signed-in run sends eval_started and eval_completed but not demo_run', async () => {
  const { sb, events } = setup(ok, true)
  sb.el('ta').value = words
  await sb.ctx.runEval()
  await sb.settle()
  assert.deepStrictEqual(sb.plain(events.map((e) => e.name)), ['eval_started', 'eval_completed'])
})

test('a failed quick pass sends eval_failed (mode quick); a total full failure sends eval_failed (mode full)', async () => {
  let { sb, events } = setup((b) => (b.mode === 'quick' ? resp({}, 500) : ok(b)), true)
  sb.el('ta').value = words
  await sb.ctx.runEval()
  assert.deepStrictEqual(sb.plain(events.filter((e) => e.name === 'eval_failed').map((e) => e.props)), [{ framework: 'MEDDIC', mode: 'quick' }])
  ;({ sb, events } = setup((b) => (b.mode === 'quick' ? ok(b) : Promise.reject(new Error('x'))), true))
  sb.el('ta').value = words
  await sb.ctx.runEval()
  assert.deepStrictEqual(sb.plain(events.filter((e) => e.name === 'eval_failed').map((e) => e.props)), [{ framework: 'MEDDIC', mode: 'full' }])
  assert.ok(!events.some((e) => e.name === 'eval_completed'))
})

test('signing-in prompt, sign-in completion (only after a prompt), and the paywall', async () => {
  const { sb, events } = setup(ok)
  sb.el('ta').value = words
  await sb.ctx.runEval() // signed out + own transcript -> prompt
  assert.deepStrictEqual(sb.plain(events.map((e) => e.name)), ['signin_prompted'])
  sb.run("signedIn=true; currentUser={id:'u1',email:'a@b.c',user_metadata:{}}")
  await sb.ctx.onAuthStateChange({ id: 'u1', email: 'a@b.c', user_metadata: {} })
  await sb.settle()
  assert.strictEqual(events.filter((e) => e.name === 'signin_completed').length, 1)
  await sb.ctx.onAuthStateChange({ id: 'u1', email: 'a@b.c', user_metadata: {} }) // returning session: no new event
  assert.strictEqual(events.filter((e) => e.name === 'signin_completed').length, 1)
  sb.run('evalCount=10')
  sb.el('ta').value = words
  await sb.ctx.runEval()
  assert.ok(events.some((e) => e.name === 'paywall_shown'))
})

test('share_created and crm_copied carry only the framework', async () => {
  const { sb, events } = setup(ok, true)
  sb.ctx.curEval = sb.run("({fw:'BANT',overall_score:50,summary:'s',sections:[],next_steps:[],date:'2026-10-17'})")
  sb.ctx.copyForCrm(null)
  await sb.settle()
  await sb.ctx.generateShareLink({ disabled: false, textContent: '' })
  assert.deepStrictEqual(sb.plain(events), [{ name: 'crm_copied', props: { framework: 'BANT' } }, { name: 'share_created', props: { framework: 'BANT' } }])
})

test('nothing sensitive ever reaches analytics: every event sent in a full flow is on the list, with no transcript text', async () => {
  const { sb, events } = setup(ok, true)
  sb.el('ta').value = words
  sb.el('deal-name').value = 'Secret Deal Acme'
  sb.el('persona').value = 'Jane Doe jane@acme.com'
  await sb.ctx.runEval()
  await sb.settle()
  const sent = JSON.stringify(events)
  events.forEach((e) => assert.ok(EVENTS.includes(e.name)))
  for (const secret of ['secretword', 'Secret Deal', 'Jane', 'acme.com', '62', 'overall']) assert.ok(!sent.includes(secret), secret)
})

test('static check: every track() call in index.html uses a listed event and only framework/mode props', () => {
  const src = readIndexHtml()
  const calls = [...src.matchAll(/track\('([a-z_]+)'(?:,(\{[^}]*\}))?\)/g)]
  assert.ok(calls.length >= 10)
  calls.forEach(([, name, props]) => {
    assert.ok(EVENTS.includes(name), 'unlisted event ' + name)
    if (props) assert.ok(/^\{(framework|mode):[^,}]+(,(framework|mode):[^,}]+)?\}$/.test(props), 'props ' + props)
  })
  EVENTS.forEach((e) => assert.ok(src.includes("track('" + e + "'"), 'event never fired: ' + e))
})
