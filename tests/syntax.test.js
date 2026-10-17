// Syntax gate: every function file parses, every inline <script> in index.html parses.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')
const { spawnSync } = require('child_process')
const { FUNCTIONS, readIndexHtml, APP } = require('./helpers/load')

function jsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name)
    if (d.isDirectory()) return jsFiles(p)
    return d.name.endsWith('.js') ? [p] : []
  })
}

for (const file of jsFiles(FUNCTIONS)) {
  test('node --check ' + path.relative(APP, file), () => {
    const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
    assert.strictEqual(r.status, 0, r.stderr)
  })
}

test('every inline <script> in index.html compiles', () => {
  const html = readIndexHtml().replace(/<!--[\s\S]*?-->/g, '') // ignore commented-out tags
  const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).filter((s) => s.trim())
  assert.ok(blocks.length >= 1, 'expected at least one inline script')
  blocks.forEach((code, i) => {
    assert.doesNotThrow(() => new vm.Script(code, { filename: 'index.html#script' + i }), 'inline script ' + i + ' failed to compile')
  })
})
