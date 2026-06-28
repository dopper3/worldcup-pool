-- Migration 0002 — repair player_picks: add player_key, re-key the table.
--
-- In some deployments migration 0001's `CREATE TABLE player_picks` was skipped
-- because an older player_picks table already existed (0001 had no DROP/IF NOT
-- EXISTS for it). Those tables are missing the player_key column and still use
-- PRIMARY KEY (user_id, match_id), which both (a) breaks scorer picks
-- (`no such column: player_key`) and (b) forbids stacking multiple players in
-- one game. This rebuilds the table to the canonical schema, preserving rows.
--
-- player_key is derived the same way the Worker's playerKeyOf() does:
--   "id:" + player_id   when player_id is present, else
--   "nm:" + lowercased player_name.
--
-- Apply with:
--   wrangler d1 execute wc-pool --file=migrations/0002_fix_player_picks_player_key.sql --remote

CREATE TABLE player_picks_new (
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

INSERT INTO player_picks_new (user_id, display_name, match_id, player_id, player_name, player_key, created_at, updated_at)
  SELECT user_id, display_name, match_id, player_id, player_name,
         CASE WHEN trim(player_id) <> '' THEN 'id:' || trim(player_id)
              ELSE 'nm:' || lower(player_name) END,
         created_at, updated_at
  FROM player_picks;

DROP TABLE player_picks;
ALTER TABLE player_picks_new RENAME TO player_picks;
