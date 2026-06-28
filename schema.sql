-- Nettzone World Cup Pool — D1 schema (canonical, fresh setup)
-- Apply with:  wrangler d1 execute wc-pool --file=schema.sql --remote
--
-- NOTE: identity is keyed by user_id (real accounts), not a typed display name.
-- If you already deployed the old name-based schema, run the migration instead:
--   wrangler d1 execute wc-pool --file=migrations/0001_accounts_and_player_picks.sql --remote

-- Key/value store. Holds the normalized ESPN snapshot under k='scores',
-- the roster cache under k='rosters', and player-pick overrides under k='pp_overrides'.
CREATE TABLE IF NOT EXISTS kv (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

-- Pool members. Self-signup with username + password. norm_username is the
-- lowercased handle used for login + uniqueness; username is what we display.
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,        -- random opaque id
  norm_username TEXT NOT NULL UNIQUE,
  username      TEXT NOT NULL,
  pass_hash     TEXT NOT NULL,           -- base64 PBKDF2-SHA256 (256-bit)
  pass_salt     TEXT NOT NULL,           -- base64 salt
  created_at    TEXT NOT NULL
);

-- Login sessions. Opaque token stored in an HttpOnly cookie; row is the
-- source of truth so sessions are revocable. Expired rows are pruned lazily.
CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

-- Bracket entries (main contest). One row per user; latest submission wins.
CREATE TABLE IF NOT EXISTS brackets (
  user_id      TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,           -- snapshot of username at submit time
  picks_json   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

-- Per-match score predictions (side game). One row per (user, match); latest wins.
CREATE TABLE IF NOT EXISTS predictions (
  user_id      TEXT NOT NULL,
  display_name TEXT NOT NULL,
  match_id     TEXT NOT NULL,
  home_goals   INTEGER NOT NULL,
  away_goals   INTEGER NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (user_id, match_id)
);

-- Player-to-score picks. Each pick is a $5 stake worth 2 points if that player
-- scores in the chosen game. A user may stack several players in one game, but
-- can pick any given player only once (unique per player_key) — player_key is
-- the ESPN athlete id when known, else a normalized name. player_id is the
-- athlete id (exact grading); player_name is a snapshot for display.
CREATE TABLE IF NOT EXISTS player_picks (
  user_id      TEXT NOT NULL,
  display_name TEXT NOT NULL,
  match_id     TEXT NOT NULL,
  player_id    TEXT NOT NULL,
  player_name  TEXT NOT NULL,
  player_key   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (user_id, player_key)
);
