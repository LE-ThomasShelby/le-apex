CREATE TABLE IF NOT EXISTS tournaments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  name TEXT NOT NULL,
  game TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'registration',
  max_players INTEGER NOT NULL CHECK (max_players BETWEEN 2 AND 128),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at TEXT,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_tournaments_guild ON tournaments(guild_id, status, id);
CREATE TABLE IF NOT EXISTS participants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  joined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(tournament_id, user_id)
);
CREATE TABLE IF NOT EXISTS matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  round_number INTEGER NOT NULL,
  match_number INTEGER NOT NULL,
  player1_id TEXT,
  player2_id TEXT,
  winner_id TEXT,
  score TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  UNIQUE(tournament_id, round_number, match_number)
);
CREATE INDEX IF NOT EXISTS idx_matches_round ON matches(tournament_id, round_number, match_number);
