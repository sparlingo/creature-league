'use strict';
/* Creature Draft League API. One POST endpoint, {action, ...}. All rules are enforced here;
   the browser only displays state. Hidden weekly stats and correct answers never leave the server
   until the teacher releases them. */
const crypto = require('crypto');
const E = require('../../public/engine.js');
const A = require('./auth');

class ApiError extends Error { constructor(msg, status = 400) { super(msg); this.status = status; } }
const fail = (m, s) => { throw new ApiError(m, s); };
const DAY = 24 * 3600 * 1000;


// Turn low-level database failures into an actionable message (never includes secrets).
function dbHint(e) {
  const code = (e && (e.code || '')) + '', msg = ((e && e.message) || '') + '';
  if (code === '28P01' || /password authentication failed/i.test(msg)) return 'The database password in DATABASE_URL is wrong. Reset it in Supabase and update the variable.';
  if (/tenant or user not found/i.test(msg)) return 'Supabase did not recognise the user or project in DATABASE_URL. Copy the Transaction pooler string again (the user looks like postgres.yourprojectref).';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'The database host in DATABASE_URL could not be found. Copy the connection string again.';
  if (['ECONNREFUSED', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH'].includes(code)) return 'Netlify could not reach the database. Use the Transaction pooler string (port 6543), not the Direct connection.';
  if (code === 'ERR_INVALID_URL' || /invalid url|invalid connection/i.test(msg)) return 'DATABASE_URL is not a valid connection string. If your password has symbols like @ or #, replace them with their % codes (@ is %40, # is %23).';
  if (code === '42P01') return 'The database tables are missing. Run supabase/schema.sql in the Supabase SQL editor.';
  if (/SSL|self.signed|certificate/i.test(msg)) return 'The secure connection to the database failed (' + msg.slice(0, 80) + ').';
  return null;
}

function createApi({ db, env }) {
  const SESSION = env.SESSION_SECRET, SEASON = env.SEASON_SECRET;

  /* ---------- helpers ---------- */
  const perfSeed = (weekNo, nonce, cid) =>
    parseInt(crypto.createHmac('sha256', SEASON).update(`${weekNo}:${nonce}:${cid}`).digest('hex').slice(0, 8), 16);
  const perf = (wk, cid) => E.perfFor(E.creature(cid), perfSeed(wk.week_no, wk.nonce, cid));
  const bump = (q, leagueId) => q('update cdl_leagues set version = version + 1 where id = $1', [leagueId]);
  const totalPicks = (lg, nTeams) => nTeams * lg.roster_size;

  async function rosterIds(q, teamId) {
    return (await q('select creature_id from cdl_roster where team_id = $1 order by pick_no nulls last, acquired_at, creature_id', [teamId])).map(r => r.creature_id);
  }
  async function defaultStarters(q, lg, teamId, weekNo) {
    const ros = await rosterIds(q, teamId);
    const prev = (await q('select starters from cdl_lineups where team_id = $1 and week_no < $2 order by week_no desc limit 1', [teamId, weekNo]))[0];
    const keep = prev ? prev.starters.filter(c => ros.includes(c)) : [];
    for (const c of ros) { if (keep.length >= lg.starters) break; if (!keep.includes(c)) keep.push(c); }
    return keep.slice(0, lg.starters);
  }
  async function powerupsLeft(q, teamId, exceptWeek) {
    const used = await q('select powerup, count(*)::int n from cdl_lineups where team_id = $1 and powerup is not null and week_no <> $2 group by powerup', [teamId, exceptWeek]);
    const left = {};
    for (const k of Object.keys(E.POWERUPS)) left[k] = E.POWERUPS[k].uses - ((used.find(u => u.powerup === k) || {}).n || 0);
    return left;
  }
  // Scoring for one team's week (server-side truth).
  function scoreTeam(wk, lineup) {
    const rows = lineup.starters.map(cid => {
      const pu = lineup.target === cid ? lineup.powerup : null;
      const bd = E.breakdown(E.creature(cid), perf(wk, cid), wk.weather, wk.mult_mode, pu);
      return { cid, pu, ...bd };
    });
    return { rows, total: rows.reduce((a, r) => a + r.S, 0) };
  }
  function moveWindow(lg, wk) { return lg.current_week + (wk && wk.status !== 'final' ? 0 : 1); }

  /* ---------- expected answers (thousandths) ---------- */
  async function expectedFor(q, lg, wk, teamId, key) {
    const [ln] = await q('select starters, powerup, target from cdl_lineups where team_id = $1 and week_no = $2', [teamId, wk.week_no]);
    if (!ln) fail('No lineup was locked for this week', 409);
    const sc = scoreTeam(wk, ln);
    const [kind, id] = key.split(':');
    if (kind === 'aw' || kind === 's') {
      const r = sc.rows.find(x => x.cid === +id); if (!r) fail('That creature did not start', 400);
      return kind === 'aw' ? { e: r.AW, raw: r.raw, r } : { e: r.S * 10, raw: r.raw, r };
    }
    if (key === 'team') return { e: sc.total * 10 };
    if (key === 'chal') {
      const t = E.challengeFor(wk.week_no);
      if (t === 'range') { const s = sc.rows.map(r => r.S); return { e: (Math.max(...s) - Math.min(...s)) * 10, t }; }
      if (t === 'proj') {
        const proj = sc.rows.reduce((a, r) => a + E.projection(E.creature(r.cid), wk.weather, wk.mult_mode), 0);
        return { e: Math.abs(sc.total - proj) * 10, t };
      }
      if (t === 'margin') {
        if (wk.status !== 'final') fail('The margin question opens when results are published', 409);
        const [res] = await q('select score, opp_score from cdl_results where league_id = $1 and week_no = $2 and team_id = $3', [lg.id, wk.week_no, teamId]);
        if (!res || res.opp_score == null) fail('There was no opponent this week', 409);
        return { e: Math.abs(res.score - res.opp_score) * 10, t };
      }
    }
    fail('Unknown question', 400);
  }
  const HINTS = {
    aw: 'Multiply the Attack number (add 1.5 first if you used Attack Boost) by the weather multiplier. Ignore the decimal points, multiply the whole numbers, then count the decimal places in BOTH numbers and put the point back.',
    s: 'Score = (A \u00d7 W) + D + B \u2212 P. Start with your A \u00d7 W answer, add D and B, then subtract P. Line up the decimal points each time. Round to 2 decimal places if needed.',
    team: 'Add the three starter scores. Line up the decimal points first.',
    chal: 'Re-read the question. Decide which two numbers you need, then subtract the smaller from the larger. Line up the decimal points.'
  };

  /* ---------- actions ---------- */
  const actions = {};

  // ---- students ----
  actions.join = async (ctx, b) => {
    const q = ctx.q;
    const code = String(b.code || '').trim().toUpperCase(), name = String(b.name || '').trim().replace(/\s+/g, ' '), pin = String(b.pin || '');
    if (!/^\d{4}$/.test(pin)) fail('Your PIN must be exactly 4 digits.');
    if (name.length < 2 || name.length > 24) fail('Team names need 2 to 24 characters.');
    const [lg] = await q('select * from cdl_leagues where code = $1', [code]);
    if (!lg) fail('We could not find that class code. Check it with your teacher.', 404);
    const [t] = await q('select * from cdl_teams where league_id = $1 and lower(name) = lower($2)', [lg.id, name]);
    let team = t;
    if (t) {
      if (t.locked_until && new Date(t.locked_until) > new Date()) fail('Too many wrong PINs. Wait a minute and try again.', 429);
      if (!A.safeEq(A.hashPin(pin, t.pin_salt), t.pin_hash)) {
        if (t.pin_fails + 1 >= 5) await q("update cdl_teams set pin_fails = 0, locked_until = now() + interval '60 seconds' where id = $1", [t.id]);
        else await q('update cdl_teams set pin_fails = pin_fails + 1 where id = $1', [t.id]);
        fail('That PIN does not match this team name.', 401);
      }
      if (t.pin_fails) await q('update cdl_teams set pin_fails = 0, locked_until = null where id = $1', [t.id]);
    } else {
      if (lg.phase !== 'setup') fail('This league has already started, so new teams cannot join. Log in with your existing team name and PIN.');
      const [{ n }] = await q('select count(*)::int n from cdl_teams where league_id = $1', [lg.id]);
      if (n >= 24) fail('This league is full.');
      const salt = A.newSalt();
      team = (await q('insert into cdl_teams (league_id, name, pin_salt, pin_hash) values ($1,$2,$3,$4) returning *', [lg.id, name, salt, A.hashPin(pin, salt)]))[0];
      await bump(q, lg.id);
    }
    const token = A.sign({ role: 'team', t: team.id, l: lg.id, exp: Date.now() + 60 * DAY }, SESSION);
    return { token, created: !t, team: { id: team.id, name: team.name }, league: { name: lg.name } };
  };

  actions.state = async (ctx, b) => {
    const q = ctx.q, lg = ctx.league, me = ctx.team.id;
    if (b.since === lg.version) return { unchanged: true, version: lg.version };
    const teams = await q('select id, name from cdl_teams where league_id = $1 order by created_at, name', [lg.id]);
    const rosters = await q('select team_id, creature_id, pick_no from cdl_roster where league_id = $1 order by pick_no nulls last, acquired_at', [lg.id]);
    const weeksAll = await q('select week_no, weather, mult_mode, status, nonce, pairings from cdl_league_weeks where league_id = $1 order by week_no', [lg.id]);
    const results = await q('select week_no, team_id, opp_id, score, opp_score, outcome, detail from cdl_results where league_id = $1 order by week_no', [lg.id]);
    const weeks = weeksAll.map(w => w.status === 'upcoming'
      ? { week_no: w.week_no, status: 'upcoming' }
      : { week_no: w.week_no, weather: w.weather, mult_mode: w.mult_mode, status: w.status, pairings: w.pairings });
    const out = {
      version: lg.version,
      league: { name: lg.name, phase: lg.phase, rosterSize: lg.roster_size, starters: lg.starters, seasonWeeks: lg.season_weeks,
        movesPerWeek: lg.moves_per_week, pickNo: lg.pick_no, totalPicks: totalPicks(lg, teams.length), draftOrder: lg.draft_order, currentWeek: lg.current_week },
      me: { id: me, name: ctx.team.name },
      teams, rosters, weeks,
      results: results.map(r => ({ ...r, detail: (r.team_id === me) ? r.detail : [] })),
      week: null
    };
    if (lg.phase === 'season' || lg.phase === 'done') {
      const cw = weeksAll.find(w => w.week_no === lg.current_week);
      const win = moveWindow(lg, cw);
      out.me.powerups = await powerupsLeft(q, me, cw && cw.status === 'forecast' ? lg.current_week : -1);
      out.me.movesUsed = (await q('select count(*)::int n from cdl_moves where team_id = $1 and week_no = $2', [me, win]))[0].n;
      out.me.moveWindow = win;
      if (cw && cw.status !== 'upcoming') {
        const pair = cw.pairings.find(p => p.includes(me));
        const oppId = pair ? (pair[0] === me ? pair[1] : pair[0]) : null;
        const [ln] = await q('select starters, powerup, target from cdl_lineups where team_id = $1 and week_no = $2', [me, cw.week_no]);
        const lineup = ln ? { starters: ln.starters, powerup: ln.powerup, target: ln.target, saved: true }
          : { starters: await defaultStarters(q, lg, me, cw.week_no), powerup: null, target: null, saved: false };
        const w = { week_no: cw.week_no, weather: cw.weather, mult_mode: cw.mult_mode, status: cw.status, oppId, bye: !oppId, lineup, challenge: E.challengeFor(cw.week_no) };
        const ans = await q('select key, tries, solved, last_value from cdl_answers where team_id = $1 and week_no = $2', [me, cw.week_no]);
        w.answers = Object.fromEntries(ans.map(a => [a.key, { tries: a.tries, solved: a.solved, value: a.last_value }]));
        if (cw.status === 'calc' || cw.status === 'final') {
          const mine = [...new Set([...rosters.filter(r => r.team_id === me).map(r => r.creature_id), ...lineup.starters])];
          w.stats = {};
          for (const cid of mine) { const p = perf(cw, cid); w.stats[cid] = { a: p.a, d: p.d, b: p.b, p: p.p }; }
        }
        out.week = w;
      }
    }
    return out;
  };

  actions.pick = async (ctx, b) => {
    const me = ctx.team.id, cid = +b.creature;
    return db.tx(async q => {
      const [lg] = await q('select * from cdl_leagues where id = $1 for update', [ctx.league.id]);
      if (lg.phase !== 'draft') fail('The draft is not open.', 409);
      const teams = await q('select id from cdl_teams where league_id = $1', [lg.id]);
      if (lg.pick_no >= totalPicks(lg, teams.length)) fail('The draft is finished.', 409);
      const onClock = lg.draft_order[E.snakeSlot(lg.draft_order.length, lg.pick_no)];
      if (onClock !== me) fail('It is not your turn to pick.', 409);
      await doPick(q, lg, me, cid);
      return { ok: true };
    });
  };
  async function doPick(q, lg, teamId, cid) {
    if (!Number.isInteger(cid) || cid < 1 || cid > E.catalog().length) fail('Unknown creature.');
    const [taken] = await q('select 1 from cdl_roster where league_id = $1 and creature_id = $2', [lg.id, cid]);
    if (taken) fail('That creature was just drafted by another team.', 409);
    await q('insert into cdl_roster (league_id, creature_id, team_id, pick_no) values ($1,$2,$3,$4)', [lg.id, cid, teamId, lg.pick_no]);
    await q('update cdl_leagues set pick_no = pick_no + 1, version = version + 1 where id = $1', [lg.id]);
  }

  actions.setLineup = async (ctx, b) => {
    const me = ctx.team.id, lg = ctx.league;
    return db.tx(async q => {
      const [cw] = await q('select * from cdl_league_weeks where league_id = $1 and week_no = $2', [lg.id, lg.current_week]);
      if (lg.phase !== 'season' || !cw || cw.status !== 'forecast') fail('Lineups are locked right now.', 409);
      const starters = (b.starters || []).map(Number);
      if (starters.length !== lg.starters || new Set(starters).size !== starters.length) fail(`Pick exactly ${lg.starters} different starters.`);
      const ros = await rosterIds(q, me);
      if (!starters.every(c => ros.includes(c))) fail('Starters must be on your roster.');
      let powerup = b.powerup || null, target = b.target ? +b.target : null;
      if (powerup) {
        if (!E.POWERUPS[powerup]) fail('Unknown power-up.');
        if (!starters.includes(target)) fail('Choose which starter gets the power-up.');
        const left = await powerupsLeft(q, me, cw.week_no);
        if (left[powerup] <= 0) fail('You have used all of that power-up.');
      } else target = null;
      await q(`insert into cdl_lineups (team_id, week_no, starters, powerup, target) values ($1,$2,$3::int[],$4,$5)
               on conflict (team_id, week_no) do update set starters = excluded.starters, powerup = excluded.powerup, target = excluded.target, updated_at = now()`,
        [me, cw.week_no, starters, powerup, target]);
      await bump(q, lg.id);
      return { ok: true };
    });
  };

  actions.addDrop = async (ctx, b) => {
    const me = ctx.team.id, drop = +b.drop, add = +b.add;
    return db.tx(async q => {
      const [lg] = await q('select * from cdl_leagues where id = $1 for update', [ctx.league.id]);
      if (lg.phase !== 'season') fail('Add/drops open once the season starts.', 409);
      const [cw] = await q('select * from cdl_league_weeks where league_id = $1 and week_no = $2', [lg.id, lg.current_week]);
      if (cw && cw.status === 'calc') fail('Add/drops are closed while scores are being calculated.', 409);
      const win = moveWindow(lg, cw);
      const [{ n }] = await q('select count(*)::int n from cdl_moves where team_id = $1 and week_no = $2', [me, win]);
      if (n >= lg.moves_per_week) fail(`You have used all ${lg.moves_per_week} add/drops for this week.`, 409);
      if (!Number.isInteger(add) || add < 1 || add > E.catalog().length) fail('Unknown creature.');
      const [mine] = await q('select 1 from cdl_roster where league_id = $1 and creature_id = $2 and team_id = $3', [lg.id, drop, me]);
      if (!mine) fail('You can only drop a creature on your roster.');
      const [taken] = await q('select 1 from cdl_roster where league_id = $1 and creature_id = $2', [lg.id, add]);
      if (taken) fail('Another team already has that creature.', 409);
      await q('delete from cdl_roster where league_id = $1 and creature_id = $2', [lg.id, drop]);
      await q('insert into cdl_roster (league_id, creature_id, team_id) values ($1,$2,$3)', [lg.id, add, me]);
      await q('insert into cdl_moves (league_id, team_id, week_no, add_id, drop_id) values ($1,$2,$3,$4,$5)', [lg.id, me, win, add, drop]);
      // keep an open lineup valid
      if (cw && cw.status === 'forecast') {
        const [ln] = await q('select starters, powerup, target from cdl_lineups where team_id = $1 and week_no = $2', [me, cw.week_no]);
        if (ln && ln.starters.includes(drop)) {
          const starters = ln.starters.map(c => c === drop ? add : c);
          const target = ln.target === drop ? add : ln.target;
          await q('update cdl_lineups set starters = $3::int[], target = $4, updated_at = now() where team_id = $1 and week_no = $2', [me, cw.week_no, starters, target]);
        }
      }
      await bump(q, lg.id);
      return { ok: true };
    });
  };

  actions.submit = async (ctx, b) => {
    const q = ctx.q, lg = ctx.league, me = ctx.team.id, key = String(b.key || '');
    if (!/^(aw:\d+|s:\d+|team|chal)$/.test(key)) fail('Unknown question.');
    const [wk] = await q('select * from cdl_league_weeks where league_id = $1 and week_no = $2', [lg.id, lg.current_week]);
    if (!wk || (wk.status !== 'calc' && wk.status !== 'final')) fail('Scores are not open yet.', 409);
    const { e, raw } = await expectedFor(q, lg, wk, me, key);
    const text = String(b.value == null ? '' : b.value).slice(0, 20);
    const g = E.parseTh(text);
    let ok = g !== null && !Number.isNaN(g) && g === e, hint = '';
    const [prev] = await q('select tries, solved from cdl_answers where team_id = $1 and week_no = $2 and key = $3', [me, wk.week_no, key]);
    const tries = (prev ? prev.tries : 0) + (ok ? 0 : 1);
    if (!ok) {
      if (g === null) hint = 'Type a number, like 12.45';
      else if (Number.isNaN(g)) hint = 'That has too many decimal places.';
      else if (key.startsWith('s:') && raw % 10 !== 0 && g === raw) hint = 'Almost! Round your answer to 2 decimal places.';
      else if ([10, 100].some(k => g * k === e || g === e * k)) hint = 'The digits look right. Check where the decimal point goes!';
      else hint = 'Not yet. Check your working and try again.';
      if (tries >= 3) hint += ' Hint: ' + HINTS[key.split(':')[0]];
    }
    await q(`insert into cdl_answers (team_id, week_no, key, tries, solved, last_value) values ($1,$2,$3,$4,$5,$6)
             on conflict (team_id, week_no, key) do update set tries = excluded.tries, solved = cdl_answers.solved or excluded.solved, last_value = excluded.last_value, updated_at = now()`,
      [me, wk.week_no, key, tries, ok, text]);
    return { ok, tries, hint };
  };

  actions.health = async ctx => {
    await ctx.q('select 1');
    const [r] = await ctx.q("select to_regclass('cdl_leagues') as t");
    if (!r.t) fail('Connected to the database, but the tables are missing. Run supabase/schema.sql in the Supabase SQL editor.', 500);
    return { ok: true, message: 'Database connected and tables found.' };
  };

  // ---- teacher ----
  actions.tLogin = async (ctx, b) => {
    if (!A.safeEq(String(b.password || ''), env.TEACHER_PASSWORD)) { await new Promise(r => setTimeout(r, 400)); fail('Wrong password.', 401); }
    return { token: A.sign({ role: 'teacher', exp: Date.now() + 14 * DAY }, SESSION) };
  };
  actions.tOverview = async ctx => {
    const leagues = await ctx.q(`select l.id, l.code, l.name, l.phase, l.current_week, l.season_weeks,
      (select count(*)::int from cdl_teams t where t.league_id = l.id) teams from cdl_leagues l order by l.created_at`);
    return { leagues };
  };
  actions.tCreateLeague = async (ctx, b) => {
    const name = String(b.name || '').trim().slice(0, 40); if (!name) fail('Give the league a name.');
    const letters = name.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 4) || 'LG';
    for (let i = 0; i < 20; i++) {
      const code = letters + '-' + crypto.randomBytes(3).toString('hex').toUpperCase().slice(0, 3).replace(/[01OI]/g, 'X');
      const [dup] = await ctx.q('select 1 from cdl_leagues where code = $1', [code]);
      if (!dup) { const [lg] = await ctx.q('insert into cdl_leagues (code, name) values ($1,$2) returning id, code', [code, name]); return lg; }
    }
    fail('Could not make a code, try again.');
  };
  actions.tLeague = async (ctx, b) => {
    const q = ctx.q, [lg] = await q('select * from cdl_leagues where id = $1', [b.leagueId]); if (!lg) fail('League not found', 404);
    const teams = await q(`select t.id, t.name, t.pin_fails, (t.locked_until > now()) locked,
      (select count(*)::int from cdl_roster r where r.team_id = t.id) roster from cdl_teams t where t.league_id = $1 order by t.created_at`, [lg.id]);
    const weeks = await q('select week_no, weather, mult_mode, status, nonce, pairings from cdl_league_weeks where league_id = $1 order by week_no', [lg.id]);
    const rosters = await q('select team_id, creature_id, pick_no from cdl_roster where league_id = $1 order by pick_no nulls last', [lg.id]);
    const results = await q('select week_no, team_id, opp_id, score, opp_score, outcome from cdl_results where league_id = $1 order by week_no', [lg.id]);
    let progress = [];
    const cw = weeks.find(w => w.week_no === lg.current_week);
    if (cw && (cw.status === 'calc' || cw.status === 'final')) {
      const ans = await q('select team_id, key, tries, solved from cdl_answers where week_no = $1 and team_id = any($2::uuid[])', [cw.week_no, teams.map(t => t.id)]);
      progress = teams.map(t => {
        const mine = ans.filter(a => a.team_id === t.id);
        return { teamId: t.id, solved: mine.filter(a => a.solved && a.key !== 'chal').length, chal: mine.some(a => a.key === 'chal' && a.solved), tries: mine.reduce((s, a) => s + a.tries, 0) };
      });
    }
    let lineups = [];
    if (cw) lineups = await q('select team_id, starters, powerup, target from cdl_lineups where week_no = $1 and team_id = any($2::uuid[])', [cw.week_no, teams.map(t => t.id)]);
    return { league: lg, teams, weeks, rosters, results, progress, lineups, required: lg.starters * 2 + 1 };
  };
  const leagueGuard = async (q, id, forUpdate) => {
    const [lg] = await q('select * from cdl_leagues where id = $1' + (forUpdate ? ' for update' : ''), [id]);
    if (!lg) fail('League not found', 404); return lg;
  };
  actions.tSettings = async (ctx, b) => db.tx(async q => {
    const lg = await leagueGuard(q, b.leagueId, true);
    if (lg.phase !== 'setup') fail('Settings can only change before the draft starts.', 409);
    const rs = E.clamp(+b.rosterSize || 5, 3, 8), sw = E.clamp(+b.seasonWeeks || 6, 1, 20), mv = E.clamp(+b.movesPerWeek, 0, 10);
    await q('update cdl_leagues set roster_size = $2, season_weeks = $3, moves_per_week = $4, name = coalesce(nullif($5, \'\'), name) where id = $1',
      [lg.id, rs, sw, Number.isFinite(mv) ? mv : 2, String(b.name || '').trim().slice(0, 40)]);
    await bump(q, lg.id); return { ok: true };
  });
  actions.tStartDraft = async ctx => { const b = ctx.body; return db.tx(async q => {
    const lg = await leagueGuard(q, b.leagueId, true);
    if (lg.phase !== 'setup') fail('The draft has already started.', 409);
    const teams = await q('select id from cdl_teams where league_id = $1', [lg.id]);
    if (teams.length < 2) fail('Wait until at least 2 teams have joined.', 409);
    if (teams.length * lg.roster_size > E.catalog().length) fail('Too many teams for the creature pool.', 409);
    const order = E.shuffle(teams.map(t => t.id), Math.random);
    await q("update cdl_leagues set phase = 'draft', draft_order = $2::uuid[], pick_no = 0, version = version + 1 where id = $1", [lg.id, order]);
    return { ok: true };
  }); };
  actions.tAutoPick = async ctx => { const b = ctx.body; return db.tx(async q => {
    const lg = await leagueGuard(q, b.leagueId, true);
    if (lg.phase !== 'draft') fail('The draft is not open.', 409);
    const n = lg.draft_order.length; if (lg.pick_no >= n * lg.roster_size) fail('The draft is finished.', 409);
    const team = lg.draft_order[E.snakeSlot(n, lg.pick_no)];
    const owned = new Set((await q('select creature_id from cdl_roster where league_id = $1', [lg.id])).map(r => r.creature_id));
    const best = E.catalog().filter(c => !owned.has(c.id)).sort((a, b2) => E.baseline(b2) - E.baseline(a) || a.id - b2.id)[0];
    await doPick(q, lg, team, best.id); return { ok: true, creature: best.id };
  }); };
  actions.tUndoPick = async ctx => { const b = ctx.body; return db.tx(async q => {
    const lg = await leagueGuard(q, b.leagueId, true);
    if (lg.phase !== 'draft' || lg.pick_no < 1) fail('Nothing to undo.', 409);
    await q('delete from cdl_roster where league_id = $1 and pick_no = $2', [lg.id, lg.pick_no - 1]);
    await q('update cdl_leagues set pick_no = pick_no - 1, version = version + 1 where id = $1', [lg.id]); return { ok: true };
  }); };
  actions.tStartSeason = async ctx => { const b = ctx.body; return db.tx(async q => {
    const lg = await leagueGuard(q, b.leagueId, true);
    if (lg.phase !== 'draft') fail('Start the draft first.', 409);
    if (lg.pick_no < lg.draft_order.length * lg.roster_size) fail('The draft is not finished yet.', 409);
    const rr = E.roundRobin(lg.draft_order), plan = E.defaultWeekPlan(lg.season_weeks, lg.code);
    for (let w = 1; w <= lg.season_weeks; w++) {
      await q('insert into cdl_league_weeks (league_id, week_no, weather, mult_mode, pairings) values ($1,$2,$3,$4,$5::jsonb)',
        [lg.id, w, plan[w - 1].weather, plan[w - 1].mode, JSON.stringify(rr[(w - 1) % rr.length])]);
    }
    await q("update cdl_leagues set phase = 'season', current_week = 0, version = version + 1 where id = $1", [lg.id]); return { ok: true };
  }); };
  actions.tOpenWeek = async ctx => { const b = ctx.body; return db.tx(async q => {
    const lg = await leagueGuard(q, b.leagueId, true), w = +b.week;
    if (lg.phase !== 'season') fail('The season is not running.', 409);
    const wks = await q('select * from cdl_league_weeks where league_id = $1 order by week_no', [lg.id]);
    const wk = wks.find(x => x.week_no === w); if (!wk) fail('No such week.');
    if (wk.status !== 'upcoming') fail('That week is already open.', 409);
    if (w > 1 && wks.find(x => x.week_no === w - 1).status !== 'final') fail('Publish the previous week first.', 409);
    await q("update cdl_league_weeks set status = 'forecast' where league_id = $1 and week_no = $2", [lg.id, w]);
    await q('update cdl_leagues set current_week = $2, version = version + 1 where id = $1', [lg.id, w]); return { ok: true };
  }); };
  actions.tLockWeek = async ctx => { const b = ctx.body; return db.tx(async q => {
    const lg = await leagueGuard(q, b.leagueId, true);
    const [wk] = await q('select * from cdl_league_weeks where league_id = $1 and week_no = $2', [lg.id, lg.current_week]);
    if (!wk || wk.status !== 'forecast') fail('Open a week first.', 409);
    const teams = await q('select id from cdl_teams where league_id = $1', [lg.id]);
    for (const t of teams) {
      const [ln] = await q('select 1 from cdl_lineups where team_id = $1 and week_no = $2', [t.id, wk.week_no]);
      if (!ln) await q('insert into cdl_lineups (team_id, week_no, starters) values ($1,$2,$3::int[])', [t.id, wk.week_no, await defaultStarters(q, lg, t.id, wk.week_no)]);
    }
    await q("update cdl_league_weeks set status = 'calc' where league_id = $1 and week_no = $2", [lg.id, wk.week_no]);
    await bump(q, lg.id); return { ok: true };
  }); };
  actions.tPublishWeek = async ctx => { const b = ctx.body; return db.tx(async q => {
    const lg = await leagueGuard(q, b.leagueId, true);
    const [wk] = await q('select * from cdl_league_weeks where league_id = $1 and week_no = $2', [lg.id, lg.current_week]);
    if (!wk || wk.status !== 'calc') fail('Lock the week first.', 409);
    const lns = await q('select * from cdl_lineups where week_no = $1 and team_id in (select id from cdl_teams where league_id = $2)', [wk.week_no, lg.id]);
    const sc = {}; for (const l of lns) sc[l.team_id] = scoreTeam(wk, l);
    for (const [a, c] of wk.pairings) {
      for (const [me, opp] of [[a, c], [c, a]]) {
        if (!me || !sc[me]) continue;
        const mine = sc[me].total, theirs = opp && sc[opp] ? sc[opp].total : null;
        const outcome = theirs == null ? 'bye' : mine > theirs ? 'W' : mine < theirs ? 'L' : 'T';
        await q('insert into cdl_results (league_id, week_no, team_id, opp_id, score, opp_score, outcome, detail) values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb) on conflict do nothing',
          [lg.id, wk.week_no, me, opp || null, mine, theirs, outcome, JSON.stringify(sc[me].rows)]);
      }
    }
    await q("update cdl_league_weeks set status = 'final' where league_id = $1 and week_no = $2", [lg.id, wk.week_no]);
    if (wk.week_no >= lg.season_weeks) await q("update cdl_leagues set phase = 'done' where id = $1", [lg.id]);
    await bump(q, lg.id); return { ok: true };
  }); };
  actions.tSetWeather = async ctx => { const b = ctx.body; return db.tx(async q => {
    const lg = await leagueGuard(q, b.leagueId, true);
    if (!E.WEATHER[b.weather] || !E.MODES[b.mode]) fail('Unknown weather.');
    const [wk] = await q('select status from cdl_league_weeks where league_id = $1 and week_no = $2', [lg.id, +b.week]);
    if (!wk || (wk.status !== 'upcoming' && wk.status !== 'forecast')) fail('That week is locked.', 409);
    await q('update cdl_league_weeks set weather = $3, mult_mode = $4 where league_id = $1 and week_no = $2', [lg.id, +b.week, b.weather, b.mode]);
    await bump(q, lg.id); return { ok: true };
  }); };
  actions.tReroll = async ctx => { const b = ctx.body; return db.tx(async q => {
    const lg = await leagueGuard(q, b.leagueId, true);
    const [wk] = await q('select status from cdl_league_weeks where league_id = $1 and week_no = $2', [lg.id, +b.week]);
    if (!wk || (wk.status !== 'upcoming' && wk.status !== 'forecast')) fail('Only unrevealed weeks can be re-rolled.', 409);
    await q('update cdl_league_weeks set nonce = nonce + 1 where league_id = $1 and week_no = $2', [lg.id, +b.week]);
    await bump(q, lg.id); return { ok: true };
  }); };
  actions.tResetPin = async ctx => { const b = ctx.body, pin = String(b.pin || '');
    if (!/^\d{4}$/.test(pin)) fail('PIN must be 4 digits.');
    const salt = A.newSalt();
    await ctx.q('update cdl_teams set pin_salt = $2, pin_hash = $3, pin_fails = 0, locked_until = null where id = $1', [b.teamId, salt, A.hashPin(pin, salt)]);
    return { ok: true };
  };
  actions.tRemoveTeam = async ctx => { const b = ctx.body; return db.tx(async q => {
    const [t] = await q('select league_id from cdl_teams where id = $1', [b.teamId]); if (!t) fail('No such team', 404);
    const lg = await leagueGuard(q, t.league_id, true);
    if (lg.phase !== 'setup') fail('Teams can only be removed before the draft.', 409);
    await q('delete from cdl_teams where id = $1', [b.teamId]); await bump(q, lg.id); return { ok: true };
  }); };
  actions.tDeleteLeague = async ctx => { await ctx.q('delete from cdl_leagues where id = $1', [ctx.body.leagueId]); return { ok: true }; };
  actions.tReveal = async ctx => {
    const q = ctx.q, lg = await leagueGuard(q, ctx.body.leagueId);
    const [wk] = await q('select * from cdl_league_weeks where league_id = $1 and week_no = $2', [lg.id, +ctx.body.week]);
    const [ln] = wk ? await q('select * from cdl_lineups where team_id = $1 and week_no = $2', [ctx.body.teamId, wk.week_no]) : [];
    if (!ln) fail('No locked lineup for that team and week.', 404);
    const sc = scoreTeam(wk, ln);
    return { rows: sc.rows, total: sc.total, weather: wk.weather, mode: wk.mult_mode };
  };

  /* ---------- dispatcher ---------- */
  async function handle(body, token) {
    try {
      const action = String((body && body.action) || '');
      const fn = actions[action]; if (!fn) fail('Unknown action', 404);
      const ctx = { body, q: db.q };
      if (action !== 'join' && action !== 'tLogin' && action !== 'health') {
        const p = A.verify(token, SESSION);
        if (!p) fail('Please log in again.', 401);
        if (action.startsWith('t')) { if (p.role !== 'teacher') fail('Teacher only.', 403); }
        else {
          if (p.role !== 'team') fail('Student only.', 403);
          const [team] = await db.q('select * from cdl_teams where id = $1', [p.t]);
          if (!team) fail('That team no longer exists. Please log in again.', 401);
          const [league] = await db.q('select * from cdl_leagues where id = $1', [p.l]);
          ctx.team = team; ctx.league = league;
        }
      }
      return { status: 200, json: await fn(ctx, body) };
    } catch (e) {
      if (e instanceof ApiError) return { status: e.status, json: { error: e.message } };
      if (e && e.code === '23505') return { status: 409, json: { error: 'Someone else got there first. Refresh and try again.' } };
      console.error(e);
      const hint = dbHint(e);
      return { status: 500, json: { error: hint ? 'Database problem: ' + hint : 'Something went wrong on the server (' + ((e && e.code) || 'unknown') + ').' } };
    }
  }
  return { handle };
}
module.exports = { createApi };
