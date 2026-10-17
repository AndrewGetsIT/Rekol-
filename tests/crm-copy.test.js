// 0E: "Copy for HubSpot" builds a plain-text field block from the evaluation.
const test = require('node:test')
const assert = require('node:assert')
const { createSandbox } = require('./helpers/browser-sandbox')
const { readIndexHtml } = require('./helpers/load')

const long = (w) => new Array(60).fill(w).join(' ') + '.'
function ev(sections, extra = {}) {
  return Object.assign({ overall_score: 58, summary: 's', fw: 'MEDDIC', date: '2026-10-17T10:00:00Z', next_steps: ['Send the proposal by Thursday', 'x'], sections }, extra)
}
const sec = (name, status, extra = {}) => Object.assign({ name, score: 50, status, covered: 'Prospect said it costs £80k. ', gaps: 'No economic buyer named. Also no timeline.', coaching: 'c', next_step: 'n' }, extra)
const build = (e) => { const sb = createSandbox(); return sb.plain(sb.ctx.buildCrmBlock(e)) }

test('the button is in the output action bar', () => {
  assert.ok(/id="crm-copy-btn"[^>]*onclick="copyForCrm\(this\)">Copy for HubSpot</.test(readIndexHtml()))
})

test('one Label: value per line: sections, Next step, Risks, Score, Scored by Rekol', () => {
  const text = build(ev([sec('Metrics', 'amber'), sec('Economic Buyer', 'red'), sec('Champion', 'red')]))
  const lines = text.split('\n')
  assert.strictEqual(lines.length, 7)
  assert.ok(lines[0].startsWith('Metrics: Prospect said it costs £80k.'))
  assert.ok(lines[0].includes('Gap: No economic buyer named.'), 'first gap only')
  assert.ok(!lines[0].includes('Also no timeline'))
  assert.strictEqual(lines[3], 'Next step: Send the proposal by Thursday')
  assert.strictEqual(lines[4], 'Risks: Economic Buyer, Champion')
  assert.strictEqual(lines[5], 'Score: 58/100')
  assert.ok(/^Scored by Rekol on \d{1,2} \w{3} 2026$/.test(lines[6]))
  lines.slice(0, 6).forEach((l) => assert.ok(/^[^:]+: /.test(l), 'Label: value ' + l))
})

test('a section\'s crm_field label is used when present, otherwise the section name', () => {
  const text = build(ev([sec('Economic Buyer', 'amber', { crm_field: 'EB' }), sec('Metrics', 'amber')]))
  assert.ok(text.startsWith('EB: '))
  assert.ok(text.includes('\nMetrics: '))
})

test('no red sections: Risks says so', () => {
  assert.ok(build(ev([sec('Metrics', 'green')])).includes('Risks: None flagged'))
})

test('always under 1,500 characters, even for a nine-section LegalFly-sized evaluation with long text', () => {
  const names = ['Metrics', 'Economic Buyer', 'Decision Criteria', 'Decision Process', 'Identify Pain', 'Champion', 'Security and Anonymisation Wedge', 'Competitive Positioning', 'ICP and Qualification Fit']
  const text = build(ev(names.map((n) => sec(n, 'red', { covered: long('covered'), gaps: long('gap') }))))
  assert.ok(text.length <= 1500, 'length ' + text.length)
  assert.ok(text.includes('Score: 58/100'), 'tail lines survive the shortening')
  assert.ok(text.trimEnd().split('\n').pop().startsWith('Scored by Rekol'))
})

test('an evaluation with no sections still produces a valid block', () => {
  const lines = build(ev([], { next_steps: [] })).split('\n')
  assert.deepStrictEqual(lines.slice(0, 3), ['Next step: ', 'Risks: None flagged', 'Score: 58/100'])
})

test('clicking copies the block, shows Copied for two seconds, and makes no network call', async () => {
  const sb = createSandbox({ fetch: () => { throw new Error('no network expected') } })
  sb.ctx.curEval = sb.run('(' + JSON.stringify(ev([sec('Metrics', 'red')])) + ')')
  const btn = { textContent: 'Copy for HubSpot' }
  const timers = []
  sb.ctx.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return 1 }
  sb.ctx.copyForCrm(btn)
  await sb.settle()
  assert.strictEqual(sb.clipboard.length, 1)
  assert.ok(sb.clipboard[0].startsWith('Metrics: '))
  assert.strictEqual(btn.textContent, 'Copied')
  const timer = timers.find((t) => t.ms === 2000)
  assert.ok(timer, 'a 2s timer restores the label')
  timer.fn()
  assert.strictEqual(btn.textContent, 'Copy for HubSpot')
  assert.strictEqual(sb.fetchCalls.length, 0)
})

test('nothing from the block is sent to analytics or the server (client-only)', () => {
  const src = readIndexHtml()
  const fn = src.slice(src.indexOf('function copyForCrm'), src.indexOf('function copyEval'))
  assert.ok(!/fetch\(|supa\./.test(fn))
})
