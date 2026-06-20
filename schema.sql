-- Nettzone World Cup Pool — D1 schema
-- Apply with:  wrangler d1 execute wc-pool --file=schema.sql --remote

-- Key/value store. Holds the normalized ESPN snapshot under k='scores'.
CREATE TABLE IF NOT EXISTS kv (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

-- Bracket entries (main contest). One row per person; latest submission for a
-- given case-insensitive name overwrites the previous one (norm_name unique).
CREATE TABLE IF NOT EXISTS brackets (
  norm_name    TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  picks_json   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

-- Per-match predictions (side game). One row per (person, match); latest wins.
CREATE TABLE IF NOT EXISTS predictions (
  norm_name    TEXT NOT NULL,
  display_name TEXT NOT NULL,
  match_id     TEXT NOT NULL,
  home_goals   INTEGER NOT NULL,
  away_goals   INTEGER NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (norm_name, match_id)
);
