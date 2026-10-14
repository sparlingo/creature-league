'use strict';
// Thin Postgres wrapper. q(sql, params) -> rows. tx(fn) runs fn(q) inside a transaction.
// DATABASE_URL should be the Supabase "Transaction pooler" connection string (port 6543).
const { Pool } = require('pg');
let pool;
function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 3,
      idleTimeoutMillis: 10000
    });
  }
  return pool;
}
async function q(sql, params) { return (await getPool().query(sql, params)).rows; }
async function tx(fn) {
  const c = await getPool().connect();
  try {
    await c.query('begin');
    const out = await fn(async (sql, params) => (await c.query(sql, params)).rows);
    await c.query('commit');
    return out;
  } catch (e) {
    try { await c.query('rollback'); } catch (_) {}
    throw e;
  } finally { c.release(); }
}
module.exports = { q, tx };
