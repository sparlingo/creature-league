'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const crypto = require('crypto');
const { PGlite } = require('@electric-sql/pglite');
const E = require('../public/engine.js');
const { createApi } = require('../netlify/lib/api.js');

const env = { SESSION_SECRET: 'sess', SEASON_SECRET: 'season', TEACHER_PASSWORD: 'pw' };
let api, T, lg;
const students = {};
const call = async (action, body, token) => (await api.handle({ action, ...body }, token));
const ok = async (action, body, token) => { const r = await call(action, body, token); assert.equal(r.status, 200, action + ': ' + JSON.stringify(r.json)); return r.json; };
const bad = async (action, body, token, status) => { const r = await call(action, body, token); assert.notEqual(r.status, 200, action + ' should fail'); if (status) assert.equal(r.status, status); return r.json; };
const seed = (w, n, c) => parseInt(crypto.createHmac('sha256', env.SEASON_SECRET).update(`${w}:${n}:${c}`).digest('hex').slice(0, 8), 16);

test.before(async () => {
  const pg = new PGlite();
  await pg.exec(fs.readFileSync(__dirname + '/../supabase/schema.sql', 'utf8'));
  const db = { q: async (s, p) => (await pg.query(s, p)).rows, tx: fn => pg.transaction(async t => fn(async (s, p) => (await t.query(s, p)).rows)) };
  api = createApi({ db, env });
  T = (await ok('tLogin', { password: 'pw' })).token;
});

test('teacher auth', async () => {
  await bad('tLogin', { password: 'nope' }, null, 401);
  await bad('tOverview', {}, null, 401);
});

test('league setup and joining', async () => {
  lg = await ok('tCreateLeague', { name: '6CK' }, T);
  await ok('tSettings', { leagueId: lg.id, rosterSize: 5, seasonWeeks: 3, movesPerWeek: 2, name: '6CK' }, T);
  for (const n of ['Fire Foxes', 'Sky Owls', 'Rock Pups', 'Wave Riders']) {
    const r = await ok('join', { code: lg.code.toLowerCase(), name: n, pin: '1234' });
    students[n] = r.token;
  }
  await bad('join', { code: lg.code, name: 'Fire Foxes', pin: '9999' }, null, 401);
  const again = await ok('join', { code: lg.code, name: 'fire foxes', pin: '1234' });
  assert.equal(again.created, false);
  await bad('join', { code: lg.code, name: 'X', pin: '12' });
  await bad('join', { code: 'NOPE', name: 'Zed Team', pin: '1234' }, null, 404);
  await bad('state', {}, T, 403);
  await bad('tOverview', {}, students['Fire Foxes'], 403);
});

test('snake draft with turn enforcement', async () => {
  await ok('tStartDraft', { leagueId: lg.id }, T);
  await bad('join', { code: lg.code, name: 'Late Team', pin: '1111' });
  let st = await ok('state', {}, students['Fire Foxes']);
  assert.equal(st.league.phase, 'draft');
  assert.equal(st.league.totalPicks, 20);
  const nameOf = id => st.teams.find(t => t.id === id).name;
  const order = st.league.draftOrder;
  const first = nameOf(order[0]), second = nameOf(order[1]);
  await bad('pick', { creature: 5 }, students[second], 409);                 // not your turn
  await ok('pick', { creature: 5 }, students[first]);
  await bad('pick', { creature: 5 }, students[second], 409);                 // already drafted
  await ok('pick', { creature: 6 }, students[second]);
  // snake: picks 3,4 go to last two teams, then order reverses
  await ok('tAutoPick', { leagueId: lg.id }, T);
  await ok('tAutoPick', { leagueId: lg.id }, T);
  st = await ok('state', {}, students[first]);
  assert.equal(st.league.pickNo, 4);
  await ok('tAutoPick', { leagueId: lg.id }, T);
  st = await ok('state', {}, students[first]);
  const p5 = st.rosters.find(r => r.pick_no === 4);
  assert.equal(p5.team_id, order[3], 'pick 5 (index 4) goes to the last team: snake reverses');
  await ok('tUndoPick', { leagueId: lg.id }, T);
  await ok('tAutoPick', { leagueId: lg.id }, T);
  st = await ok('state', {}, students[first]);
  for (let i = st.league.pickNo; i < 20; i++) await ok('tAutoPick', { leagueId: lg.id }, T);
  await bad('tStartSeason', { leagueId: '00000000-0000-0000-0000-000000000000' }, T);
  const rep = await ok('state', {}, students[first]);
  assert.equal(rep.league.pickNo, 20);
  for (const t of rep.teams) assert.equal(rep.rosters.filter(r => r.team_id === t.id).length, 5);
});

test('week cycle: forecast, lineup, lock, reveal, calculate, publish', async () => {
  await ok('tStartSeason', { leagueId: lg.id }, T);
  await ok('tOpenWeek', { leagueId: lg.id, week: 1 }, T);
  await bad('tOpenWeek', { leagueId: lg.id, week: 2 }, T, 409);
  const tok = students['Fire Foxes'];
  let st = await ok('state', {}, tok);
  assert.equal(st.week.status, 'forecast');
  assert.equal(st.week.stats, undefined, 'no hidden stats before lock');
  assert.equal(st.week.weather, 'Clear Skies');
  const mine = st.rosters.filter(r => r.team_id === st.me.id).map(r => r.creature_id);
  assert.equal(mine.length, 5);
  await bad('setLineup', { starters: [mine[0], mine[1]] }, tok);                 // wrong count
  await bad('setLineup', { starters: [mine[0], mine[1], 99] }, tok);             // not on roster
  await ok('setLineup', { starters: [mine[3], mine[4], mine[0]], powerup: 'atk', target: mine[4] }, tok);
  await bad('submit', { key: 'team', value: '1' }, tok, 409);                    // not open yet
  await ok('tLockWeek', { leagueId: lg.id }, T);
  await bad('setLineup', { starters: [mine[0], mine[1], mine[2]] }, tok, 409);
  st = await ok('state', {}, tok);
  assert.equal(st.week.status, 'calc');
  assert.deepEqual(st.week.lineup.starters, [mine[3], mine[4], mine[0]]);
  assert.ok(st.week.stats[mine[0]], 'stats revealed after lock');
  for (const c of mine) { const p = E.perfFor(E.creature(c), seed(1, 0, c)); assert.deepEqual(st.week.stats[c], p); }

  // independent expected scores (clear skies, atk boost on mine[4])
  const exp = {}; let total = 0;
  for (const c of st.week.lineup.starters) {
    const bd = E.breakdown(E.creature(c), E.perfFor(E.creature(c), seed(1, 0, c)), 'Clear Skies', 'standard', c === mine[4] ? 'atk' : null);
    exp[c] = bd; total += bd.S;
  }
  const c0 = mine[4];
  let r = await ok('submit', { key: 'aw:' + c0, value: E.f3(exp[c0].AW) }, tok); assert.equal(r.ok, true);
  r = await ok('submit', { key: 's:' + c0, value: E.f2(exp[c0].S) + '0' }, tok); assert.equal(r.ok, true, 'trailing zero accepted');
  r = await ok('submit', { key: 's:' + mine[0], value: String(exp[mine[0]].S / 10) }, tok);     // decimal slip
  assert.equal(r.ok, false); assert.match(r.hint, /decimal point/);
  r = await ok('submit', { key: 's:' + mine[0], value: 'abc' }, tok); assert.match(r.hint, /number/);
  r = await ok('submit', { key: 's:' + mine[0], value: '1' }, tok); assert.match(r.hint, /Hint:/, 'method hint after 3 tries');
  assert.ok(!r.hint.includes(E.f2(exp[mine[0]].S)), 'hint never reveals the answer');
  r = await ok('submit', { key: 's:' + mine[0], value: E.f2(exp[mine[0]].S) }, tok); assert.equal(r.ok, true);
  r = await ok('submit', { key: 'team', value: E.f2(total) }, tok); assert.equal(r.ok, true);
  r = await ok('submit', { key: 'team', value: E.f2(total + 1) }, tok); assert.equal(r.ok, false);
  await bad('submit', { key: 'aw:' + mine[1], value: '5' }, tok);                  // bench creature
  st = await ok('state', {}, tok); assert.equal(st.week.answers['team'].solved, true);
  const prog = await ok('tLeague', { leagueId: lg.id }, T);
  assert.ok(prog.progress.find(p => p.teamId === st.me.id).solved >= 3);

  await ok('tPublishWeek', { leagueId: lg.id }, T);
  st = await ok('state', {}, tok);
  assert.equal(st.week.status, 'final');
  const myRes = st.results.find(x => x.team_id === st.me.id && x.week_no === 1);
  assert.equal(myRes.score, total, 'official score equals independent calculation');
  assert.equal(myRes.detail.length, 3);
  assert.ok(st.results.filter(x => x.team_id !== st.me.id).every(x => x.detail.length === 0), "other teams' breakdowns stay private");
  assert.equal(st.results.filter(x => x.week_no === 1).length, 4);
  const w = st.results.filter(x => x.week_no === 1 && x.outcome === 'W').length, l = st.results.filter(x => x.week_no === 1 && x.outcome === 'L').length;
  assert.equal(w, l);
  // powerups used
  assert.equal(st.me.powerups.atk, 1);
});

test('add/drop and weekly limits', async () => {
  const tok = students['Fire Foxes'];
  let st = await ok('state', {}, tok);
  const owned = new Set(st.rosters.map(r => r.creature_id));
  const free = E.catalog().filter(c => !owned.has(c.id)).map(c => c.id);
  const mine = st.rosters.filter(r => r.team_id === st.me.id).map(r => r.creature_id);
  const someoneElses = st.rosters.find(r => r.team_id !== st.me.id).creature_id;
  await bad('addDrop', { drop: mine[0], add: someoneElses }, tok, 409);
  await bad('addDrop', { drop: someoneElses, add: free[0] }, tok);
  await ok('addDrop', { drop: mine[0], add: free[0] }, tok);
  await ok('addDrop', { drop: mine[1], add: free[1] }, tok);
  await bad('addDrop', { drop: mine[2], add: free[2] }, tok, 409);             // limit of 2
  st = await ok('state', {}, tok); assert.equal(st.me.movesUsed, 2);
  await ok('tOpenWeek', { leagueId: lg.id, week: 2 }, T);
  st = await ok('state', {}, tok); assert.equal(st.me.movesUsed, 2, 'waiver-window moves count toward the week they lead into');
  await bad('addDrop', { drop: mine[2], add: free[2] }, tok, 409);
  // lineup defaults carry over, minus dropped creatures
  assert.equal(st.week.lineup.starters.length, 3);
  assert.ok(st.week.lineup.starters.every(c => st.rosters.some(r => r.team_id === st.me.id && r.creature_id === c)));
  // power-up limits: Weather Ward only once
  const s = st.rosters.filter(r => r.team_id === st.me.id).map(r => r.creature_id).slice(0, 3);
  await ok('setLineup', { starters: s, powerup: 'wx', target: s[0] }, tok);
});

test('full season ends the league and standings add up', async () => {
  await ok('tLockWeek', { leagueId: lg.id }, T); await ok('tPublishWeek', { leagueId: lg.id }, T);
  await ok('tOpenWeek', { leagueId: lg.id, week: 3 }, T);
  await ok('tLockWeek', { leagueId: lg.id }, T); await ok('tPublishWeek', { leagueId: lg.id }, T);
  const st = await ok('state', {}, students['Sky Owls']);
  assert.equal(st.league.phase, 'done');
  const games = st.results.filter(r => r.outcome !== 'bye');
  assert.equal(games.length, 12);
  for (const t of st.teams) assert.equal(st.results.filter(r => r.team_id === t.id).length, 3);
});

test('teacher tools', async () => {
  await ok('tResetPin', { teamId: (await ok('state', {}, students['Sky Owls'])).me.id, pin: '4321' }, T);
  await ok('join', { code: lg.code, name: 'Sky Owls', pin: '4321' });
  await bad('join', { code: lg.code, name: 'Sky Owls', pin: '1234' }, null, 401);
  const rv = await ok('tReveal', { leagueId: lg.id, teamId: (await ok('state', {}, students['Sky Owls'])).me.id, week: 1 }, T);
  assert.equal(rv.rows.length, 3);
});
