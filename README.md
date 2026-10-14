# Creature Draft League

A fantasy-football-style class game for a Grade 6 decimals unit. Pairs of students draft creatures, set a weekly
lineup, then **work out the scores on paper** and type them in; the site checks every answer.

Hosting: static site + one Netlify Function + a Supabase (Postgres) database. Students need no accounts: they join with a
class code, a team name and a 4-digit PIN. No emails or real names are stored.

---

## 1. Try it on your computer first (5 minutes, no accounts)

```
npm install
npm run dev
```
Open http://localhost:8888. Teacher page: http://localhost:8888/#/teacher (password `teacher`).
This uses an in-memory database, so everything resets when you stop it. Open it in a few private windows to play
as several teams.

## 2. Put it online

### a) Database (Supabase, free tier is plenty)
1. Create a project at supabase.com. Save the database password.
2. Open **SQL Editor**, paste all of `supabase/schema.sql`, click **Run**.
3. Click **Connect** at the top of the project and copy the **Transaction pooler** connection string (port 6543).
   Put your database password in place of `[YOUR-PASSWORD]`. That is your `DATABASE_URL`.

The tables are locked down (Row Level Security with no public policies), so nobody can read hidden stats or answers
through Supabase's public API. Only the Netlify function can reach the data.

### b) Website (Netlify)
1. Put this folder in a GitHub repository (or use `npx netlify-cli deploy --prod`).
2. In Netlify choose **Add new site, Import an existing project**. Build settings are read from `netlify.toml`.
3. Before the first deploy, add these **environment variables**:

| Name | Value |
|---|---|
| `DATABASE_URL` | the Supabase Transaction pooler string |
| `SESSION_SECRET` | any long random text (`openssl rand -hex 32`) |
| `SEASON_SECRET` | another long random text. **Never change it mid-season**: it seeds every hidden weekly stat |
| `TEACHER_PASSWORD` | your teacher password |

4. Deploy. Visit `https://your-site.netlify.app/#/teacher`.

## 3. Running it in class

1. **Teacher page**: add a league per class (6CK, 6KB, 6LK). Each gets a class code, such as `6CK-9F6`.
2. Students open the site, enter the class code, make up a team name (include both initials) and a PIN.
3. Pick settings (default: 5 creatures per team, 6-week season, 2 add/drops a week) and **Start the draft**.
   Order is random and snakes back and forth. Use **Auto-pick** if a pair is away; **Undo** fixes mistakes.
4. **Start the season.** Each week, in each class:
   - **Open forecast**: students see weather, opponent and projections; they set 3 starters + an optional power-up; add/drop.
   - **Lock lineups & reveal stats**: stats appear. Students calculate on paper, then check on the Matchup tab.
     The Teacher page shows who has confirmed what, and the **Answers** button shows the full working for any team.
   - **Publish results**: official scores, standings, and the "margin" challenge question unlock.
5. Each week's weather and multiplier set can be edited before it opens. The dice button re-rolls a week's hidden stats
   if you dislike them (only before reveal).

### Suggested use over three periods
- **Period 1:** join, draft, read the Rules tab.
- **Period 2:** Week 1 (Clear Skies: addition and subtraction only) lineup + calculation.
- **Period 3:** Week 2 or 3 (first weather multipliers). Then run one more week every few lessons through the unit.

### How the maths ramps up
| Weeks | Weather | Skills |
|---|---|---|
| 1-2 | Clear Skies, all x1.00 | add and subtract decimals; multiply by 1.00 |
| 3-5 | x1.20 / x0.80 | decimal x decimal; Attack Boost (add 1.5 first, order of operations) |
| 6+ | x1.25 / x0.75 | three-decimal products, **rounding to 2 places** |

Each starter has two checked steps (A x W, then the full score), then the team total, then a rotating challenge
(difference from projection, best minus lowest starter, winning margin). All maths runs in whole numbers on the
server, so there is never a floating-point rounding surprise in the answer key.

## The rules in one screen
`Score = (A x W) + D + B - P`. A = weekly Attack, W = weather multiplier (Attack only), D = Defense, B = Speed bonus,
P = Energy penalty. 120 creatures (6 types x 20), 5 roles. Power-ups: Attack Boost +1.5 to A before W (2 uses),
Energy Shield removes P (2 uses), Weather Ward cancels a weakening multiplier (1 use). One per week.

## Known limits (v1)
- No playoffs or trades yet. The data model leaves room for both.
- The page checks for updates every few seconds rather than using websockets. Fine for a class.
- Students can guess answers repeatedly; after 3 misses they get a method hint, never the answer.
- Supabase's free tier pauses a project after about a week of no activity. Click **Restore** if that happens over a break.
- Student progress shows on the Teacher page only for the current week.

## Tests
`npm test` runs 17 tests, including a full simulated season (join, snake draft, lineups, add/drops, answer checking,
publishing) against a real Postgres engine (PGlite).
