// A fake Supabase (auth + a tiny REST surface) and a fake Anthropic, wired
// onto the mocked https layer. Tests pass in what the "world" looks like.
const { install } = require('./mock-https')

const SUPA_HOST = 'iqdnmlzamqqskfjysfzg.supabase.co'

const SECTION_KEYS = ['name', 'score', 'status', 'covered', 'gaps', 'coaching', 'next_step']

function textOf(body) {
  // everything the model would read: system blocks + message content
  const parts = []
  const sys = body.system
  if (typeof sys === 'string') parts.push(sys)
  else if (Array.isArray(sys)) sys.forEach((b) => parts.push(b.text || ''))
  ;(body.messages || []).forEach((m) => {
    if (typeof m.content === 'string') parts.push(m.content)
    else if (Array.isArray(m.content)) m.content.forEach((b) => parts.push(b.text || ''))
  })
  return parts.join('\n')
}

// Which sections was this call asked to score? Works for both the current
// per-call tool schema (enum + maxItems) and a shared-schema layout (read it
// from the instruction line instead).
function assignedSections(body) {
  const tool = (body.tools || []).find((t) => t.name === 'submit_section_eval')
  if (!tool) return []
  const sec = tool.input_schema.properties.sections
  if (sec && sec.maxItems && sec.items.properties.name.enum) return sec.items.properties.name.enum.slice(0, sec.maxItems)
  const text = textOf(body)
  const m = text.match(/(?:Evaluate these sections|a separate pass covers the rest): ([^\n]+)/)
  return m ? m[1].split(', ').map((s) => s.trim()) : []
}

function fakeAnthropic(body, opts, state) {
  state.n = (state.n || 0) + 1
  if (opts.respond) {
    const custom = opts.respond(body, state.n)
    if (custom) return custom
  }
  const usage = Object.assign({ input_tokens: 1200, output_tokens: 300, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, opts.usage || {})
  const choice = body.tool_choice && body.tool_choice.name
  if (choice === 'submit_quick_eval') {
    return { status: 200, body: JSON.stringify({ content: [{ type: 'tool_use', name: choice, input: { overall_score: 62, summary: 'Decent discovery, weak close.' } }], stop_reason: 'tool_use', usage }) }
  }
  if (choice === 'submit_section_eval') {
    const names = assignedSections(body)
    if (opts.failSections && names.some((n) => opts.failSections.has(n))) {
      return { status: 500, body: '{"error":"boom"}' }
    }
    const tool = body.tools.find((t) => t.name === 'submit_section_eval')
    const props = tool.input_schema.properties
    const wantsNext = props.next_steps && ((tool.input_schema.required || []).includes('next_steps') || /three concrete next steps/.test(textOf(body)))
    const input = {
      sections: names.map((name, i) => ({
        name,
        score: 40 + i * 10,
        status: i === 0 ? 'red' : 'amber',
        covered: 'Covered: ' + name,
        gaps: 'Gap: ' + name,
        coaching: 'Coach: ' + name,
        next_step: 'Next: ' + name,
      })),
    }
    if (wantsNext) input.next_steps = ['Send proposal', 'Book security review', 'Meet the economic buyer']
    return { status: 200, body: JSON.stringify({ content: [{ type: 'tool_use', name: choice, input }], stop_reason: 'tool_use', usage }) }
  }
  return { status: 200, body: JSON.stringify({ content: [{ type: 'text', text: opts.text || 'Plain narrative.' }], stop_reason: 'end_turn', usage }) }
}

// world = {
//   users:     { '<token>': { id, email, user_metadata } },
//   anthropic: { respond?, failSections?, usage?, text? },
//   rest:      (rec) => ({status, body}) | undefined      // Supabase REST (/rest/v1/...)
//   rpc:       { <fn>: (args, rec) => value }              // Supabase RPC (/rest/v1/rpc/<fn>)
// }
function makeWorld(world = {}) {
  const anthropicState = {}
  const handler = (rec) => {
    if (rec.hostname === SUPA_HOST && rec.path === '/auth/v1/user') {
      const token = String(rec.headers.Authorization || rec.headers.authorization || '').replace(/^Bearer\s+/i, '')
      const user = (world.users || {})[token]
      return user ? { status: 200, body: JSON.stringify(user) } : { status: 401, body: '{"msg":"invalid"}' }
    }
    if (rec.hostname === 'api.anthropic.com' && rec.path === '/v1/messages') {
      const r = fakeAnthropic(rec.json, world.anthropic || {}, anthropicState)
      const d = world.anthropic && world.anthropic.delay ? world.anthropic.delay(rec.json) : 0
      return d ? new Promise((resolve) => setTimeout(() => resolve(r), d)) : r
    }
    if (rec.hostname === SUPA_HOST && rec.path.startsWith('/rest/v1/rpc/')) {
      const fn = rec.path.slice('/rest/v1/rpc/'.length).split('?')[0]
      const impl = (world.rpc || {})[fn]
      if (impl) return { status: 200, body: JSON.stringify(impl(rec.json || {}, rec)) }
    }
    if (rec.hostname === SUPA_HOST && rec.path.startsWith('/rest/v1/')) {
      if (world.rest) {
        const r = world.rest(rec)
        if (r) return r
      }
      return { status: rec.method === 'GET' ? 200 : 201, body: '[]' }
    }
    return undefined // anything else is an unmocked network call -> test fails loudly
  }
  const net = install(handler)
  return {
    calls: net.calls,
    anthropicCalls: () => net.calls.filter((c) => c.hostname === 'api.anthropic.com').map((c) => c.json),
    restore: net.restore,
  }
}

module.exports = { makeWorld, assignedSections, textOf, SECTION_KEYS, SUPA_HOST }
