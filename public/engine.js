/* Creature Draft League: shared game engine (browser + Netlify function).
   All maths uses integers so decimals never suffer floating-point drift:
   ratings and performance in TENTHS, multipliers in HUNDREDTHS, bonuses/penalties in HUNDREDTHS,
   a creature's raw score in THOUSANDTHS, official scores in HUNDREDTHS. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Engine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hash32(s) {
    let h = 2166136261;
    for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  // Fisher-Yates: identical order in every browser engine (Array.sort with a random comparator is not)
  function shuffle(arr, rng) { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

  /* ---------- types, roles, weather ---------- */
  const TYPES = ['Fire', 'Water', 'Nature', 'Electric', 'Earth', 'Air'];
  const TYPE_ICON = { Fire: '🔥', Water: '💧', Nature: '🌿', Electric: '⚡', Earth: '⛰️', Air: '🌬️' };
  // tenths offsets applied to ATK/DEF/SPD/ENG, and v = weekly swing (in points) for that role
  const ROLES = {
    Striker:  { atk: 19, def: -14, spd: 0,  eng: 0,   v: 2.0, blurb: 'Hits hard, thin defence' },
    Guardian: { atk: -14, def: 14, spd: 0,  eng: 3,   v: 1.6, blurb: 'Sturdy, lower attack' },
    Sprinter: { atk: -3, def: 0,   spd: 35, eng: -10, v: 2.6, blurb: 'Fast, less consistent' },
    Balanced: { atk: 0,  def: 0,   spd: 0,  eng: 5,   v: 1.2, blurb: 'Steady, lower ceiling' },
    Wildcard: { atk: 13, def: -5,  spd: 6,  eng: -10, v: 3.5, blurb: 'Big upside, big swings' }
  };

  const TYPE_BIAS = {
    Fire:     { atk: 4, def: 0, spd: 0, eng: 0, roles: { Striker: 4, Wildcard: 2, Balanced: 1, Guardian: 1, Sprinter: 1 } },
    Water:    { atk: 1, def: 2, spd: 0, eng: 2, roles: { Balanced: 3, Guardian: 2, Striker: 1, Sprinter: 1, Wildcard: 1 } },
    Nature:   { atk: 0, def: 1, spd: 0, eng: 8, roles: { Balanced: 3, Guardian: 3, Striker: 1, Sprinter: 1, Wildcard: 1 } },
    Electric: { atk: 2, def: 0, spd: 8, eng: 0, roles: { Sprinter: 3, Wildcard: 3, Striker: 2, Balanced: 1, Guardian: 1 } },
    Earth:    { atk: 0, def: 4, spd: -3, eng: 2, roles: { Guardian: 4, Balanced: 2, Striker: 2, Sprinter: 1, Wildcard: 1 } },
    Air:      { atk: 2, def: 0, spd: 8, eng: 0, roles: { Sprinter: 4, Wildcard: 2, Balanced: 2, Striker: 1, Guardian: 1 } }
  };

  const WEATHER = {
    'Clear Skies':  { icon: '☀️', up: null,       down: null },
    'Heatwave':     { icon: '🌡️', up: 'Fire',     down: 'Nature' },
    'Rainstorm':    { icon: '🌧️', up: 'Water',    down: 'Fire' },
    'Thunderstorm': { icon: '⛈️', up: 'Electric', down: 'Water' },
    'Strong Winds': { icon: '💨', up: 'Air',      down: 'Earth' },
    'Earthquake':   { icon: '🌋', up: 'Earth',    down: 'Electric' },
    'Spring Bloom': { icon: '🌸', up: 'Nature',   down: 'Air' }
  };
  const WEATHER_NAMES = Object.keys(WEATHER);
  const MODES = { standard: { up: 120, down: 80 }, challenge: { up: 125, down: 75 } }; // hundredths
  const POWERUPS = {
    atk: { name: 'Attack Boost', icon: '💥', uses: 2, text: 'Adds 1.5 to one starter\u2019s Attack, before the weather multiplier.' },
    def: { name: 'Energy Shield', icon: '🛡️', uses: 2, text: 'Wipes out one starter\u2019s whole Energy Penalty (P becomes 0).' },
    wx:  { name: 'Weather Ward', icon: '☂️', uses: 1, text: 'If the weather weakens one starter, its multiplier becomes 1.00.' }
  };


  /* ---------- creature catalogue (deterministic, identical in every league) ---------- */
  const PREFIX = {
    Fire: ['Ember', 'Blaze', 'Cinder', 'Flare', 'Scorch', 'Magma', 'Ash', 'Spark', 'Pyro', 'Torch'],
    Water: ['Tide', 'Wave', 'Splash', 'Brook', 'Coral', 'Misty', 'Drip', 'Reef', 'Bubble', 'Surf'],
    Nature: ['Moss', 'Fern', 'Thorn', 'Leaf', 'Bloom', 'Vine', 'Acorn', 'Clover', 'Bark', 'Petal'],
    Electric: ['Volt', 'Zap', 'Static', 'Bolt', 'Arc', 'Jolt', 'Flux', 'Surge', 'Amp', 'Thunder'],
    Earth: ['Pebble', 'Rock', 'Dune', 'Clay', 'Gravel', 'Boulder', 'Quartz', 'Cliff', 'Granite', 'Mud'],
    Air: ['Cloud', 'Breeze', 'Gust', 'Zephyr', 'Feather', 'Sky', 'Gale', 'Wisp', 'Puff', 'Drift']
  };
  const SUFFIX = [['fox', '🦊'], ['pup', '🐶'], ['cub', '🐻'], ['drake', '🐉'], ['wing', '🦅'], ['tail', '🐿️'], ['hog', '🐗'], ['claw', '🦀'],
    ['fin', '🐟'], ['hop', '🐸'], ['gecko', '🦎'], ['owl', '🦉'], ['bun', '🐰'], ['kit', '🐱'], ['shell', '🐢'], ['bug', '🐞'], ['moth', '🦋'], ['horn', '🦏']];
  // 20 per type: strength tiers (base level in tenths)
  const TIERS = [['Elite', 2, 70], ['Strong', 4, 64], ['Average', 8, 58], ['Developing', 4, 52], ['Risky', 2, 58]];
  const CATALOG_SEED = 61021;

  function weightedPick(rng, weights) {
    const entries = Object.entries(weights), tot = entries.reduce((a, e) => a + e[1], 0);
    let r = rng() * tot;
    for (const [k, w] of entries) { if ((r -= w) < 0) return k; }
    return entries[0][0];
  }
  function riskLabel(v) { return v <= 1.5 ? 'Low' : v <= 2.5 ? 'Medium' : 'High'; }

  let _catalog = null;
  function catalog() {
    if (_catalog) return _catalog;
    const rng = mulberry32(CATALOG_SEED), out = [], used = new Set();
    const norm = () => (rng() + rng() + rng() - 1.5) * 2; // roughly -3..3, bell-shaped
    TYPES.forEach(type => {
      const tb = TYPE_BIAS[type];
      const pre = shuffle(PREFIX[type], rng);
      let pi = 0;
      TIERS.forEach(([tier, count, level]) => {
        for (let i = 0; i < count; i++) {
          let role = tier === 'Risky' ? (rng() < 0.6 ? 'Wildcard' : 'Sprinter') : weightedPick(rng, tb.roles);
          const rb = ROLES[role];
          // find unused name
          let name, emoji, tries = 0;
          do {
            const p = pre[(pi++) % pre.length], s = SUFFIX[Math.floor(rng() * SUFFIX.length)];
            name = p + s[0]; emoji = s[1]; tries++;
          } while (used.has(name) && tries < 200);
          used.add(name);
          const lvl = level + Math.round(norm() * 1.6);
          const mk = (b, r, n) => clamp(lvl + b + r + Math.round(norm() * 4 * n), 18, 98);
          const spread = tier === 'Risky' ? 1.5 : 1;
          out.push({
            id: out.length + 1, name: name[0].toUpperCase() + name.slice(1), emoji, type, role, tier,
            atk: mk(tb.atk, rb.atk, spread), def: mk(tb.def, rb.def, spread),
            spd: mk(tb.spd, rb.spd, spread), eng: mk(tb.eng, rb.eng, spread),
            risk: riskLabel(rb.v)
          });
        }
      });
    });
    _catalog = out;
    return out;
  }
  const creature = id => catalog()[id - 1];

  /* ---------- weekly performance (tenths) ---------- */
  // Returns the weekly stat package students are given: A, D in tenths; B, P in hundredths.
  function perfFor(c, seed) {
    const rng = mulberry32(seed >>> 0), v = ROLES[c.role].v;
    const swing = () => Math.round((rng() + rng() - 1) * v * 10); // tenths, bounded by +/- v
    const a = clamp(c.atk + swing(), 10, 100), d = clamp(c.def + swing(), 10, 100);
    const s = clamp(c.spd + swing(), 10, 100), e = clamp(c.eng + swing(), 10, 100);
    return { a, d, b: 2 * s, p: 2 * (100 - e) };
  }
  function baseStats(c) { return { a: c.atk, d: c.def, b: 2 * c.spd, p: 2 * (100 - c.eng) }; }

  /* ---------- scoring ---------- */
  function multiplier(weather, mode, type) {
    const w = WEATHER[weather]; if (!w || !w.up) return 100;
    const m = MODES[mode] || MODES.standard;
    return type === w.up ? m.up : type === w.down ? m.down : 100;
  }
  // S = (A x W) + D + B - P, with an optional power-up applied to this creature.
  function breakdown(c, stats, weather, mode, powerup) {
    let A = stats.a, W = multiplier(weather, mode, c.type), P = stats.p;
    if (powerup === 'atk') A += 15;
    if (powerup === 'wx' && W < 100) W = 100;
    if (powerup === 'def') P = 0;
    const AW = A * W;                                  // thousandths
    const raw = AW + stats.d * 100 + stats.b * 10 - P * 10; // thousandths
    const S = Math.floor((raw + 5) / 10);              // hundredths, rounded half up
    return { A, W, D: stats.d, B: stats.b, P, AW, raw, S };
  }
  const projection = (c, weather, mode) => breakdown(c, baseStats(c), weather, mode, null).S;
  const baseline = c => projection(c, 'Clear Skies', 'standard');

  /* ---------- formatting & parsing ---------- */
  function fmt(v, sc, fixed) {
    const neg = v < 0; v = Math.abs(v);
    const s = String(v).padStart(sc + 1, '0'), i = s.slice(0, -sc);
    let f = s.slice(-sc);
    if (!fixed) f = f.replace(/0+$/, '');
    return (neg ? '-' : '') + i + (f ? '.' + f : '');
  }
  const f1 = v => fmt(v, 1, true), f2 = v => fmt(v, 2, true), f3 = v => fmt(v, 3, false);
  const fmtMult = w => fmt(w, 2, true);
  // text -> thousandths, null if not a number, NaN if more than 3 decimals
  function parseTh(s) {
    s = String(s == null ? '' : s).trim().replace(/,/g, '');
    if (!/^\d*\.?\d*$/.test(s) || s === '' || s === '.') return null;
    const [i, f = ''] = s.split('.');
    if (/[1-9]/.test(f.slice(3))) return NaN;
    return parseInt(i || '0', 10) * 1000 + parseInt((f + '000').slice(0, 3), 10);
  }

  /* ---------- league mechanics ---------- */
  function snakeSlot(n, pickNo) { const r = Math.floor(pickNo / n), i = pickNo % n; return r % 2 ? n - 1 - i : i; }
  function roundRobin(ids) {
    let t = ids.slice(); if (t.length % 2) t.push(null);
    const m = t.length, rounds = [];
    for (let r = 0; r < m - 1; r++) {
      const p = []; for (let i = 0; i < m / 2; i++) p.push([t[i], t[m - 1 - i]]);
      rounds.push(p); t = [t[0], t[m - 1], ...t.slice(1, m - 1)];
    }
    return rounds;
  }
  // Default weather plan: weeks 1-2 clear (add/subtract only), 3-5 standard multipliers, 6+ challenge.
  function defaultWeekPlan(weeks, seed) {
    const rng = mulberry32(hash32(seed));
    let pool = WEATHER_NAMES.filter(w => w !== 'Clear Skies');
    pool = shuffle(pool, rng);
    const plan = [];
    for (let w = 1; w <= weeks; w++) {
      if (w <= 2) plan.push({ weather: 'Clear Skies', mode: 'standard' });
      else plan.push({ weather: pool[(w - 3) % pool.length], mode: w <= 5 ? 'standard' : 'challenge' });
    }
    return plan;
  }
  const CHALLENGES = ['proj', 'range', 'margin'];
  const challengeFor = w => CHALLENGES[(w - 1) % CHALLENGES.length];
  const CHALLENGE_TEXT = {
    proj: 'Your team’s projected total was shown on the Lineup page. By how many points did your actual total differ from the projection?',
    range: 'How many points separate your best starter from your lowest starter?',
    margin: 'By how many points did the winning team beat the losing team? (Use the official totals.)'
  };

  return { mulberry32, hash32, clamp, shuffle, TYPES, TYPE_ICON, ROLES, WEATHER, WEATHER_NAMES, MODES, POWERUPS, catalog, creature, perfFor, baseStats,
    multiplier, breakdown, projection, baseline, fmt, f1, f2, f3, fmtMult, parseTh, snakeSlot, roundRobin, defaultWeekPlan,
    challengeFor, CHALLENGE_TEXT };
});
