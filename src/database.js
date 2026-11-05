const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");

const databasePath = process.env.DATABASE_PATH || "./data/legion-ai.sqlite";
fs.mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
const db = new Database(databasePath);

db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    guild_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_conversations_user_guild
    ON conversations(user_id, guild_id, id);
`);

const selectHistory = db.prepare(`
  SELECT role, content FROM conversations
  WHERE user_id = ? AND guild_id = ?
  ORDER BY id DESC LIMIT ?
`);
const insertMessage = db.prepare(
  "INSERT INTO conversations (user_id, guild_id, role, content) VALUES (?, ?, ?, ?)"
);
const deleteHistory = db.prepare(
  "DELETE FROM conversations WHERE user_id = ? AND guild_id = ?"
);

function getHistory(userId, guildId) {
  const max = Math.max(2, Number(process.env.MAX_HISTORY_MESSAGES || 16));
  return selectHistory.all(userId, guildId, max).reverse();
}

function addExchange(userId, guildId, question, answer) {
  const transaction = db.transaction(() => {
    insertMessage.run(userId, guildId, "user", question);
    insertMessage.run(userId, guildId, "assistant", answer);
  });
  transaction();
}

function clearHistory(userId, guildId) {
  deleteHistory.run(userId, guildId);
}

module.exports = { getHistory, addExchange, clearHistory };
