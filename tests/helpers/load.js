const path = require('path')
const fs = require('fs')

const REPO = path.resolve(__dirname, '..', '..')
const APP = path.join(REPO, 'Rekol')
const FUNCTIONS = path.join(APP, 'netlify', 'functions')

// Fresh copy of a function module each time, with env set for the test.
function loadFunction(name, env = {}) {
  const file = path.join(FUNCTIONS, name + '.js')
  Object.keys(require.cache).forEach((k) => { if (k.startsWith(FUNCTIONS)) delete require.cache[k] })
  Object.assign(process.env, { SUPABASE_SERVICE_KEY: 'test-service-key', ANTHROPIC_API_KEY: 'test-anthropic-key', RETRY_TOKEN_SECRET: 'test-retry-secret' }, env)
  return require(file)
}

function readIndexHtml() {
  return fs.readFileSync(path.join(APP, 'index.html'), 'utf8')
}

// The demo transcript exactly as the browser has it.
function demoTranscript() {
  const html = readIndexHtml()
  let m = html.match(/var DEMO_TRANSCRIPT='((?:[^'\\]|\\.)*)';/)
  if (!m) m = html.match(/getElementById\('ta'\)\.value='((?:[^'\\]|\\.)*)'/)
  if (!m) throw new Error('could not find the demo transcript in index.html')
  return new Function('return \'' + m[1] + '\'')()
}

function event(body, token, method = 'POST') {
  return {
    httpMethod: method,
    headers: token ? { authorization: 'Bearer ' + token } : {},
    body: body === undefined ? undefined : JSON.stringify(body),
  }
}

// ordinary call text that is NOT the demo transcript
const SAMPLE_TRANSCRIPT = ('AE: Thanks for joining. Can you walk me through how your team handles renewals today? ' +
  'Prospect: Honestly it is spreadsheets and a lot of chasing, we lose maybe five hours a week. ' +
  'AE: What would fixing that be worth? Prospect: Hard to say, perhaps twenty thousand a year. ' +
  'AE: Who else is involved in a decision like this? Prospect: Our finance director signs anything over ten thousand, and IT reviews security. ' +
  'AE: When would you want this live? Prospect: Ideally before the end of the quarter. ' +
  'AE: Great, I will send a proposal and set up a call with finance. Prospect: That works, thanks. ')

const USERS = {
  'tok-user': { id: 'user-1', email: 'rep@example.com', user_metadata: {} },
  'tok-other': { id: 'user-2', email: 'someone.else@example.com', user_metadata: {} },
  'tok-andrew': { id: 'user-andrew', email: 'andrewlennon16@gmail.com', user_metadata: {} },
}

module.exports = { REPO, APP, FUNCTIONS, loadFunction, readIndexHtml, demoTranscript, event, SAMPLE_TRANSCRIPT, USERS }
