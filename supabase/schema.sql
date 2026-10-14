-- Creature Draft League: database schema (PostgreSQL / Supabase)
-- Every table and index is prefixed cdl_ so nothing can clash with other apps in the same project.
-- Run this once in the Supabase SQL editor. Safe to re-run: every statement is idempotent.
--
-- Security model: the browser NEVER talks to the database. All access goes through the
-- Netlify function using the DATABASE_URL connection string. Row Level Security is switched
-- on for every table with no policies, so Supabase's public REST/GraphQL API (anon key)
-- can read and write nothing, even if someone finds your project URL.

create table if not exists cdl_leagues (
  id            uuid primary key default gen_random_uuid(),
  code          text not null unique,               -- class join code, stored uppercase
  name          text not null,
  phase         text not null default 'setup' check (phase in ('setup','draft','season','done')),
  roster_size   int  not null default 5 check (roster_size between 3 and 8),
  starters      int  not null default 3 check (starters between 1 and 5),
  season_weeks  int  not null default 6 check (season_weeks between 1 and 20),
  moves_per_week int not null default 2 check (moves_per_week between 0 and 10),
  draft_order   uuid[] not null default '{}',
  pick_no       int  not null default 0,
  current_week  int  not null default 0,
  version       int  not null default 1,            -- bumped on every change; clients poll on it
  created_at    timestamptz not null default now()
);

create table if not exists cdl_teams (
  id           uuid primary key default gen_random_uuid(),
  league_id    uuid not null references cdl_leagues(id) on delete cascade,
  name         text not null,
  pin_salt     text not null,
  pin_hash     text not null,
  pin_fails    int  not null default 0,
  locked_until timestamptz,
  created_at   timestamptz not null default now()
);
create unique index if not exists cdl_teams_league_name_uq on cdl_teams (league_id, lower(name));

-- One creature can sit on exactly one roster per league (primary key enforces it).
create table if not exists cdl_roster (
  league_id   uuid not null references cdl_leagues(id) on delete cascade,
  creature_id int  not null,
  team_id     uuid not null references cdl_teams(id) on delete cascade,
  pick_no     int,                                  -- draft pick number, null for free-agent adds
  acquired_at timestamptz not null default now(),
  primary key (league_id, creature_id)
);
create index if not exists cdl_roster_team_idx on cdl_roster (team_id);

-- Every add/drop, used to count weekly moves.
create table if not exists cdl_moves (
  id          bigserial primary key,
  league_id   uuid not null references cdl_leagues(id) on delete cascade,
  team_id     uuid not null references cdl_teams(id) on delete cascade,
  week_no     int  not null,
  add_id      int  not null,
  drop_id     int  not null,
  created_at  timestamptz not null default now()
);

create table if not exists cdl_league_weeks (
  league_id  uuid not null references cdl_leagues(id) on delete cascade,
  week_no    int  not null,
  weather    text not null default 'Clear Skies',
  mult_mode  text not null default 'standard' check (mult_mode in ('standard','challenge')),
  status     text not null default 'upcoming' check (status in ('upcoming','forecast','calc','final')),
  nonce      int  not null default 0,               -- teacher can bump before reveal to re-roll the week
  pairings   jsonb not null default '[]',           -- [[teamIdA, teamIdB|null], ...]
  primary key (league_id, week_no)
);

create table if not exists cdl_lineups (
  team_id    uuid not null references cdl_teams(id) on delete cascade,
  week_no    int  not null,
  starters   int[] not null,
  powerup    text check (powerup in ('atk','def','wx')),
  target     int,                                   -- creature the power-up is applied to
  updated_at timestamptz not null default now(),
  primary key (team_id, week_no)
);

-- Student answer attempts. The correct value is never stored here; it is recomputed on demand.
create table if not exists cdl_answers (
  team_id    uuid not null references cdl_teams(id) on delete cascade,
  week_no    int  not null,
  key        text not null,                         -- aw:<id> | s:<id> | team | chal
  tries      int  not null default 0,
  solved     boolean not null default false,
  last_value text,
  updated_at timestamptz not null default now(),
  primary key (team_id, week_no, key)
);

-- Official frozen results, written when the teacher publishes a week.
create table if not exists cdl_results (
  league_id  uuid not null references cdl_leagues(id) on delete cascade,
  week_no    int  not null,
  team_id    uuid not null references cdl_teams(id) on delete cascade,
  opp_id     uuid references cdl_teams(id) on delete set null,
  score      int  not null,                         -- hundredths of a point
  opp_score  int,
  outcome    text not null check (outcome in ('W','L','T','bye')),
  detail     jsonb not null default '[]',
  primary key (league_id, week_no, team_id)
);

alter table cdl_leagues      enable row level security;
alter table cdl_teams        enable row level security;
alter table cdl_roster       enable row level security;
alter table cdl_moves        enable row level security;
alter table cdl_league_weeks enable row level security;
alter table cdl_lineups      enable row level security;
alter table cdl_answers      enable row level security;
alter table cdl_results      enable row level security;
