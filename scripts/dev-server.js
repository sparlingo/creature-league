'use strict';
// Try the whole site on your own computer with NO accounts or setup:
//   npm install && npm run dev      then open http://localhost:8888
// Uses an in-memory Postgres (PGlite) loaded with supabase/schema.sql. Data vanishes when you stop it.
const http = require('http'), fs = require('fs'), path = require('path');
const { PGlite } = require('@electric-sql/pglite');
const { createApi } = require('../netlify/lib/api.js');
(async () => {
  const pg = new PGlite();
  await pg.exec(fs.readFileSync(path.join(__dirname, '../supabase/schema.sql'), 'utf8'));
  const db = { q: async (s, p) => (await pg.query(s, p)).rows, tx: fn => pg.transaction(async t => fn(async (s, p) => (await t.query(s, p)).rows)) };
  const env = { SESSION_SECRET: 'dev-session', SEASON_SECRET: 'dev-season', TEACHER_PASSWORD: process.env.TEACHER_PASSWORD || 'teacher' };
  const api = createApi({ db, env });
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
  http.createServer(async (req, res) => {
    if (req.url === '/api' && req.method === 'POST') {
      let b = ''; for await (const c of req) b += c;
      const r = await api.handle(JSON.parse(b || '{}'), (req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
      res.writeHead(r.status, { 'content-type': 'application/json' }); return res.end(JSON.stringify(r.json));
    }
    const f = path.join(__dirname, '../public', req.url === '/' ? 'index.html' : req.url.split('?')[0]);
    if (!f.startsWith(path.join(__dirname, '../public')) || !fs.existsSync(f)) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
  }).listen(8888, () => console.log('Creature Draft League running at http://localhost:8888  (teacher password: ' + env.TEACHER_PASSWORD + ')'));
})();
