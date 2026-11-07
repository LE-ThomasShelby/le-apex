const { db } = require("./database");

function getTournament(guildId, id) {
  return db.prepare("SELECT * FROM tournaments WHERE guild_id = ? AND id = ?").get(guildId, id);
}

function createTournament({ guildId, name, game, maxPlayers, createdBy }) {
  const result = db.prepare("INSERT INTO tournaments (guild_id, name, game, max_players, created_by) VALUES (?, ?, ?, ?, ?)")
    .run(guildId, name.trim(), game.trim(), maxPlayers, createdBy);
  return getTournament(guildId, Number(result.lastInsertRowid));
}

function listTournaments(guildId) {
  return db.prepare(`
    SELECT t.*, (SELECT COUNT(*) FROM participants p WHERE p.tournament_id = t.id) AS player_count
    FROM tournaments t WHERE t.guild_id = ? ORDER BY t.id DESC LIMIT 15
  `).all(guildId);
}

function registerPlayer(guildId, id, userId, displayName) {
  const tournament = getTournament(guildId, id);
  if (!tournament) return { ok: false, reason: "not_found" };
  if (tournament.status !== "registration") return { ok: false, reason: "closed" };
  const count = db.prepare("SELECT COUNT(*) AS count FROM participants WHERE tournament_id = ?").get(id).count;
  if (count >= tournament.max_players) return { ok: false, reason: "full" };
  try {
    db.prepare("INSERT INTO participants (tournament_id, user_id, display_name) VALUES (?, ?, ?)")
      .run(id, userId, displayName);
    return { ok: true };
  } catch (error) {
    if (String(error.code).includes("SQLITE_CONSTRAINT")) return { ok: false, reason: "already_registered" };
    throw error;
  }
}

function startTournament(guildId, id) {
  const tournament = getTournament(guildId, id);
  if (!tournament) return { ok: false, reason: "not_found" };
  if (tournament.status !== "registration") return { ok: false, reason: "not_open" };
  const players = db.prepare("SELECT user_id FROM participants WHERE tournament_id = ? ORDER BY joined_at, id")
    .all(id).map((p) => p.user_id);
  if (players.length < 2) return { ok: false, reason: "too_few" };
  for (let i = players.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [players[i], players[j]] = [players[j], players[i]];
  }
  const size = 2 ** Math.ceil(Math.log2(players.length));
  const slots = [...players, ...Array(size - players.length).fill(null)];
  const totalRounds = Math.log2(size);

  const build = db.transaction(() => {
    const insert = db.prepare("INSERT INTO matches (tournament_id, round_number, match_number, player1_id, player2_id, winner_id, status) VALUES (?, ?, ?, ?, ?, ?, ?)");
    let currentWinners = [];
    for (let i = 0; i < size / 2; i++) {
      const a = slots[i * 2] || null;
      const b = slots[i * 2 + 1] || null;
      const winner = a && !b ? a : (!a && b ? b : null);
      insert.run(id, 1, i + 1, a, b, winner, winner ? "completed" : "pending");
      currentWinners.push(winner);
    }
    for (let round = 2; round <= totalRounds; round++) {
      const nextWinners = [];
      for (let i = 0; i < currentWinners.length / 2; i++) {
        const a = currentWinners[i * 2] || null;
        const b = currentWinners[i * 2 + 1] || null;
        const winner = a && !b ? a : (!a && b ? b : null);
        insert.run(id, round, i + 1, a, b, winner, winner ? "completed" : "pending");
        nextWinners.push(winner);
      }
      currentWinners = nextWinners;
    }
    db.prepare("UPDATE tournaments SET status = 'ongoing', started_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);
    const champion = currentWinners[0];
    if (champion) db.prepare("UPDATE tournaments SET status = 'completed', completed_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);
  });
  build();
  return { ok: true, players: players.length, rounds: totalRounds };
}

function reportResult(guildId, id, round, matchNumber, winnerId, score) {
  const tournament = getTournament(guildId, id);
  if (!tournament) return { ok: false, reason: "not_found" };
  if (tournament.status !== "ongoing") return { ok: false, reason: "not_ongoing" };
  const match = db.prepare("SELECT * FROM matches WHERE tournament_id = ? AND round_number = ? AND match_number = ?")
    .get(id, round, matchNumber);
  if (!match || match.status !== "pending") return { ok: false, reason: "match_not_found" };
  if (![match.player1_id, match.player2_id].includes(winnerId)) return { ok: false, reason: "winner_not_in_match" };

  const save = db.transaction(() => {
    db.prepare("UPDATE matches SET winner_id = ?, score = ?, status = 'completed' WHERE id = ?")
      .run(winnerId, score || null, match.id);
    const nextRound = round + 1;
    const nextMatchNumber = Math.ceil(matchNumber / 2);
    const next = db.prepare("SELECT * FROM matches WHERE tournament_id = ? AND round_number = ? AND match_number = ?")
      .get(id, nextRound, nextMatchNumber);
    if (next) {
      const slot = matchNumber % 2 === 1 ? "player1_id" : "player2_id";
      db.prepare(`UPDATE matches SET ${slot} = ? WHERE id = ?`).run(winnerId, next.id);
    } else {
      db.prepare("UPDATE tournaments SET status = 'completed', completed_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);
    }
  });
  save();
  return { ok: true };
}

function getBracket(guildId, id) {
  const tournament = getTournament(guildId, id);
  if (!tournament) return null;
  const matches = db.prepare("SELECT * FROM matches WHERE tournament_id = ? ORDER BY round_number, match_number").all(id);
  const participants = db.prepare("SELECT user_id, display_name FROM participants WHERE tournament_id = ?").all(id);
  return { tournament, matches, names: new Map(participants.map((p) => [p.user_id, p.display_name])) };
}

function cancelTournament(guildId, id) {
  const tournament = getTournament(guildId, id);
  if (!tournament) return false;
  db.prepare("UPDATE tournaments SET status = 'cancelled' WHERE id = ?").run(id);
  return true;
}

module.exports = { createTournament, listTournaments, registerPlayer, startTournament, reportResult, getBracket, cancelTournament };
