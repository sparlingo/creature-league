'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../public/engine.js');

test('catalogue is 120 unique, valid, deterministic creatures', () => {
  const c = E.catalog();
  assert.equal(c.length, 120);
  assert.equal(new Set(c.map(x => x.name)).size, 120);
  assert.ok(c.every(x => [x.atk, x.def, x.spd, x.eng].every(v => Number.isInteger(v) && v >= 18 && v <= 98)));
  assert.equal(E.catalog()[0].name, E.catalog()[0].name);
  for (const t of E.TYPES) assert.equal(c.filter(x => x.type === t).length, 20);
});
test('worked example from the rules: (9.2 x 1.25) + 3.8 + B - P', () => {
  const c = { type: 'Fire' };
  // A 9.2, D 3.8, B 2.40, P 1.10 -> 11.5 + 3.8 + 2.4 - 1.1 = 16.60 under Heatwave challenge (Fire x1.25)
  const bd = E.breakdown(c, { a: 92, d: 38, b: 240, p: 110 }, 'Heatwave', 'challenge', null);
  assert.equal(bd.AW, 11500); assert.equal(bd.S, 1660);
});
test('integer maths: no floating point drift', () => {
  const bd = E.breakdown({ type: 'Fire' }, { a: 73, d: 51, b: 133, p: 47 }, 'Heatwave', 'challenge', null); // 7.3 x 1.25 = 9.125
  assert.equal(bd.AW, 9125); assert.equal(bd.raw, 9125 + 5100 + 1330 - 470); assert.equal(bd.S, Math.floor((bd.raw + 5) / 10));
});
test('weather multipliers and power-ups', () => {
  const nat = { type: 'Nature' }, st = { a: 80, d: 50, b: 100, p: 100 };
  assert.equal(E.multiplier('Heatwave', 'standard', 'Nature'), 80);
  assert.equal(E.multiplier('Heatwave', 'standard', 'Fire'), 120);
  assert.equal(E.multiplier('Heatwave', 'standard', 'Water'), 100);
  assert.equal(E.multiplier('Clear Skies', 'challenge', 'Fire'), 100);
  assert.equal(E.breakdown(nat, st, 'Heatwave', 'standard', 'wx').W, 100);
  assert.equal(E.breakdown(nat, st, 'Clear Skies', 'standard', 'wx').W, 100);
  assert.equal(E.breakdown(nat, st, 'Clear Skies', 'standard', 'atk').A, 95);   // 8.0 + 1.5 before the multiplier
  assert.equal(E.breakdown(nat, st, 'Clear Skies', 'standard', 'def').P, 0);
  assert.equal(E.breakdown(nat, st, 'Clear Skies', 'standard', null).S, 800 + 500 + 100 - 100);
});
test('parseTh', () => {
  assert.equal(E.parseTh('13.250'), 13250); assert.equal(E.parseTh(' 13.25 '), 13250); assert.equal(E.parseTh('13'), 13000);
  assert.equal(E.parseTh('.5'), 500); assert.equal(E.parseTh('1,000.5'), 1000500);
  assert.equal(E.parseTh('abc'), null); assert.equal(E.parseTh(''), null); assert.ok(Number.isNaN(E.parseTh('1.2345')));
  assert.equal(E.parseTh('1.2000'), 1200);
});
test('formatting', () => { assert.equal(E.f2(1660), '16.60'); assert.equal(E.f1(92), '9.2'); assert.equal(E.f3(11500), '11.5'); assert.equal(E.fmtMult(125), '1.25'); assert.equal(E.fmt(-5, 2, true), '-0.05'); });
test('snake order', () => {
  const seq = Array.from({ length: 12 }, (_, k) => E.snakeSlot(4, k));
  assert.deepEqual(seq, [0, 1, 2, 3, 3, 2, 1, 0, 0, 1, 2, 3]);
});
test('round robin: everyone plays everyone once, byes for odd', () => {
  const ids = ['a', 'b', 'c', 'd', 'e', 'f'], r = E.roundRobin(ids), seen = new Set();
  assert.equal(r.length, 5);
  r.forEach(week => { const inWeek = week.flat(); assert.equal(new Set(inWeek).size, 6); week.forEach(([x, y]) => seen.add([x, y].sort().join())); });
  assert.equal(seen.size, 15);
  const odd = E.roundRobin(['a', 'b', 'c']); assert.equal(odd.length, 3); odd.forEach(w => assert.equal(w.flat().filter(x => x === null).length, 1));
});
test('weather plan eases students in', () => {
  const p = E.defaultWeekPlan(8, 'X');
  assert.equal(p[0].weather, 'Clear Skies'); assert.equal(p[1].weather, 'Clear Skies');
  assert.ok(p.slice(2, 5).every(x => x.mode === 'standard' && x.weather !== 'Clear Skies'));
  assert.ok(p.slice(5).every(x => x.mode === 'challenge'));
});
test('weekly stats are bounded by role swing', () => {
  for (const c of E.catalog()) for (let s = 0; s < 20; s++) {
    const p = E.perfFor(c, s * 7919), v = E.ROLES[c.role].v * 10;
    assert.ok(Math.abs(p.a - c.atk) <= v + 1 || p.a === 100 || p.a === 10);
  }
});
