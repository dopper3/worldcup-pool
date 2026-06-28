-- Migration 0001 — accounts + player-to-score contest.
--
-- Moves identity from typed display names to real user accounts, and adds the
-- player-to-score contest. The old brackets/predictions tables were keyed by
-- norm_name; this re-keys them by user_id. Safe to run because no real entries
-- exist yet (per the pool owner) — it DROPS and recreates those two tables.
--
-- Apply with:
--   wrangler d1 execute wc-pool --file=migrations/0001_accounts_and_player_picks.sql --remote

DROP TABLE IF EXISTS brackets;
DROP TABLE IF EXISTS predictions;

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  norm_username TEXT NOT NULL UNIQUE,
  username      TEXT NOT NULL,
  pass_hash     TEXT NOT NULL,
  pass_salt     TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE TABLE sessions (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE brackets (
  user_id      TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  picks_json   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE predictions (
  user_id      TEXT NOT NULL,
  display_name TEXT NOT NULL,
  match_id     TEXT NOT NULL,
  home_goals   INTEGER NOT NULL,
  away_goals   INTEGER NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (user_id, match_id)
);

CREATE TABLE player_picks (
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
