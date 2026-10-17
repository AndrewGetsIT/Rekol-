// Loads the REAL inline script from Rekol/index.html into a Node vm context
// with a tiny fake DOM, so UI logic can be tested without a browser. This is
// not a rendering test: it checks logic, state and the HTML strings produced.
const vm = require('vm')
const { readIndexHtml } = require('./load')

class El {
  constructor(key) {
    this.key = key
    this.style = {}
    this.dataset = {}
    this.children = []
    this.attrs = {}
    this.listeners = {}
    this._classes = new Set()
    this._html = ''
    this._text = ''
    this.value = ''
    this.disabled = false
    this.contentEditable = 'false'
    const self = this
    this.classList = {
      add(c) { self._classes.add(c) },
      remove(c) { self._classes.delete(c) },
      toggle(c, force) {
        const on = force === undefined ? !self._classes.has(c) : !!force
        if (on) self._classes.add(c); else self._classes.delete(c)
        return on
      },
      contains(c) { return self._classes.has(c) },
    }
  }
  get className() { return [...this._classes].join(' ') }
  set className(v) { this._classes = new Set(String(v).split(/\s+/).filter(Boolean)) }
  get innerHTML() { return this._html + this.children.map((c) => c.innerHTML + c.textContent).join('') }
  set innerHTML(v) { this._html = String(v); this.children = [] }
  get textContent() { return this._text }
  set textContent(v) { this._text = String(v); this._html = '' }
  appendChild(c) { this.children.push(c); c.parent = this; return c }
  insertBefore(c) { return this.appendChild(c) }
  remove() {}
  setAttribute(k, v) { this.attrs[k] = v }
  getAttribute(k) { return this.attrs[k] }
  addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn) }
  querySelector(sel) { return this._q(sel) }
  querySelectorAll() { return [] }
  _q(sel) { return this.parent ? this.parent._q(sel) : null }
  scrollIntoView() {}
  focus() {}
  select() {}
}

function makeStorage(initial) {
  const store = Object.assign({}, initial || {})
  return {
    store,
    api: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v) },
      removeItem: (k) => { delete store[k] },
    },
  }
}

function createSandbox(opts = {}) {
  const els = {}
  const get = (k) => (els[k] = els[k] || new El(k))
  const local = makeStorage(opts.localStorage)
  const session = makeStorage(opts.sessionStorage)
  const toasts = []
  const fetchCalls = []
  const profileWrites = []

  const document = {
    getElementById: (id) => get('#' + id),
    querySelector: (sel) => get(sel),
    querySelectorAll: () => [],
    createElement: () => new El('created'),
    createTextNode: (t) => { const e = new El('text'); e.textContent = t; return e },
    addEventListener() {},
    body: get('body'),
    title: 'Rekol',
  }
  const win = {
    addEventListener() {},
    scrollTo() {},
    location: { origin: 'https://getrekol.com', pathname: '/', hash: '', search: '' },
    scrollY: 0,
    print() {},
  }
  const supaChain = (result, table) => {
    const chain = {
      select: () => chain, eq: () => chain, in: () => chain, order: () => chain, limit: () => chain, single: () => Promise.resolve(result),
      update: (row) => { if (table === 'profiles') profileWrites.push(JSON.parse(JSON.stringify(row))); return chain },
      insert: (row) => { opts.onInsert && opts.onInsert(JSON.parse(JSON.stringify(row))); return Promise.resolve(opts.insertResult ? opts.insertResult(row) : { data: null, error: null }) },
      then: (res, rej) => Promise.resolve(result).then(res, rej),
    }
    return chain
  }
  const supa = {
    auth: {
      getSession: () => Promise.resolve({ data: { session: opts.token ? { access_token: opts.token, user: opts.user } : null } }),
      onAuthStateChange() {}, signInWithOAuth: () => Promise.resolve({}), signInWithOtp: () => Promise.resolve({}), signOut: () => Promise.resolve(),
      setSession: () => Promise.resolve({ data: {}, error: null }),
    },
    from: (table) => (opts.from ? opts.from(table, (r) => supaChain(r, table))
      : table === 'profiles' ? supaChain({ data: { eval_count: opts.profileCount === undefined ? 1 : opts.profileCount, is_pro: false }, error: null }, table)
      : supaChain({ data: [], error: null }, table)),
    rpc: (fn, args) => Promise.resolve(opts.rpc ? opts.rpc(fn, args) : { data: null, error: null }),
  }

  const sandbox = {
    document, window: win, navigator: { clipboard: { writeText: () => Promise.resolve() } },
    localStorage: local.api,
    sessionStorage: session.api,
    emailjs: { init() {}, send: () => Promise.resolve() },
    supabase: { createClient: () => supa },
    history: { replaceState() {} },
    fetch: (url, init) => {
      fetchCalls.push({ url, init, body: init && init.body ? JSON.parse(init.body) : undefined })
      return opts.fetch ? opts.fetch(url, init, fetchCalls.length) : Promise.reject(new Error('unmocked fetch ' + url))
    },
    console: { log() {}, error() {}, warn() {} },
    setTimeout: (fn) => { if (opts.runTimers) fn(); return 0 },
    clearTimeout() {},
    URLSearchParams, Date, Math, JSON, Promise, Object, Array, String, Number, parseInt, Error, Set,
    plausible: opts.plausible,
  }
  sandbox.window.document = document
  sandbox.window.plausible = opts.plausible
  sandbox.window.localStorage = sandbox.localStorage
  sandbox.window.sessionStorage = sandbox.sessionStorage
  const ctx = vm.createContext(sandbox)

  const html = readIndexHtml().replace(/<!--[\s\S]*?-->/g, '')
  const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).filter((s) => s.trim())
  blocks.forEach((code, i) => vm.runInContext(code, ctx, { filename: 'index.html#script' + i }))

  const origToast = ctx.toast
  ctx.toast = (m) => { toasts.push(String(m)); try { origToast(m) } catch (e) { /* fake dom */ } }

  return {
    ctx,
    el: (id) => get('#' + id),
    sel: (s) => get(s),
    toasts,
    fetchCalls,
    store: local.store,
    sessionStore: session.store,
    profileWrites,
    run: (code) => vm.runInContext(code, ctx),
    // objects created inside the vm have a different prototype; copy them across for deepStrictEqual
    plain: (x) => JSON.parse(JSON.stringify(x)),
    async settle(n = 20) { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)) },
  }
}

module.exports = { createSandbox, El }
