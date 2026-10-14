'use strict';
const { createApi } = require('../lib/api');
const db = require('../lib/db');

let api;
const headers = { 'content-type': 'application/json', 'cache-control': 'no-store' };

exports.handler = async (event) => {
  const isHealth = event.httpMethod === 'GET' && event.queryStringParameters && 'health' in event.queryStringParameters;
  if (event.httpMethod !== 'POST' && !isHealth) return { statusCode: 405, headers, body: '{"error":"POST only"}' };
  const need = ['DATABASE_URL', 'SESSION_SECRET', 'SEASON_SECRET', 'TEACHER_PASSWORD'].filter(k => !process.env[k]);
  if (need.length) return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server is missing settings: ' + need.join(', ') }) };
  api = api || createApi({ db, env: process.env });
  let body = {};
  if (isHealth) body = { action: 'health' };
  else try { body = JSON.parse(event.body || '{}'); } catch (e) { return { statusCode: 400, headers, body: '{"error":"Bad JSON"}' }; }
  const auth = (event.headers.authorization || event.headers.Authorization || '').replace(/^Bearer\s+/i, '');
  const r = await api.handle(body, auth);
  return { statusCode: r.status, headers, body: JSON.stringify(r.json) };
};
