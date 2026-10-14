'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApi } = require('../netlify/lib/api.js');
const env = { SESSION_SECRET: 's', SEASON_SECRET: 'x', TEACHER_PASSWORD: 'pw' };
const failing = code => ({ q: async () => { const e = new Error('boom'); e.code = code; throw e; }, tx: async () => { throw Object.assign(new Error('boom'), { code }); } });

test('database failures give an actionable message', async () => {
  const cases = [['28P01', /password/i], ['ENOTFOUND', /host/i], ['ECONNREFUSED', /pooler/i], ['42P01', /schema\.sql/]];
  for (const [code, re] of cases) {
    const api = createApi({ db: failing(code), env });
    const { json: { token } } = await api.handle({ action: 'tLogin', password: 'pw' });
    const r = await api.handle({ action: 'tOverview' }, token);
    assert.equal(r.status, 500); assert.match(r.json.error, re); assert.ok(!/postgres:\/\//.test(r.json.error));
    const h = await api.handle({ action: 'health' });
    assert.equal(h.status, 500); assert.match(h.json.error, re);
  }
});
test('teacher login works even when the database is down (so the page must show the DB error)', async () => {
  const api = createApi({ db: failing('ECONNREFUSED'), env });
  assert.equal((await api.handle({ action: 'tLogin', password: 'pw' })).status, 200);
});
