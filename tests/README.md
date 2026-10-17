# Tests

Dev-only. Nothing here is deployed (Netlify builds from the `Rekol/` folder). No npm dependencies: the Node tests use the built-in `node:test`.

```bash
npm test            # syntax gate + contract tests + feature tests (Node 20+)
npm run test:db     # DB isolation suite on a throwaway local Postgres 16 (brew install postgresql@16)
```

- `syntax.test.js`: every function passes `node --check`; every inline `<script>` in `Rekol/index.html` compiles.
- `evaluate.contract.test.js`: baseline, written against the unmodified code. Shapes, section names/order, model calls, max 3 sections per call, LegalFly gate. Must keep passing unchanged. (One allowance added later: a full-mode response may also carry `retry_token`.)
- other `*.test.js`: one file per feature.
- `helpers/`: `mock-https.js` (no network), `backend.js` (fake Supabase + Anthropic), `browser-sandbox.js` (real `index.html` script in a fake DOM), `load.js`.
- The functions use Node's `https`, so tests mock `https.request`, not `fetch`.
