// Replaces https.request so no test can touch the network. Every request is
// recorded and answered by a handler function. Unhandled hosts fail loudly.
const https = require('https')
const { EventEmitter } = require('events')

function install(handler) {
  const original = https.request
  const calls = []

  https.request = function fakeRequest(options, cb) {
    const req = new EventEmitter()
    const chunks = []
    req.write = (c) => { chunks.push(Buffer.from(c)); return true }
    req.setTimeout = () => req
    req.destroy = () => {}
    if (cb) req.once('response', cb)
    req.end = () => {
      const bodyText = Buffer.concat(chunks).toString()
      let json = null
      try { json = bodyText ? JSON.parse(bodyText) : null } catch (e) { /* not json */ }
      const rec = {
        hostname: options.hostname,
        path: options.path,
        method: options.method || 'GET',
        headers: options.headers || {},
        bodyText,
        json,
        at: Date.now(),
      }
      calls.push(rec)
      Promise.resolve()
        .then(() => handler(rec))
        .then((r) => {
          if (!r) throw new Error('unmocked request: ' + rec.method + ' ' + rec.hostname + rec.path)
          const res = new EventEmitter()
          res.statusCode = r.status
          res.headers = r.headers || {}
          req.emit('response', res)
          setImmediate(() => {
            if (r.body !== undefined && r.body !== null && r.body !== '') res.emit('data', Buffer.from(r.body))
            res.emit('end')
          })
        })
        .catch((err) => setImmediate(() => req.emit('error', err)))
    }
    return req
  }

  return {
    calls,
    restore() { https.request = original },
  }
}

module.exports = { install }
