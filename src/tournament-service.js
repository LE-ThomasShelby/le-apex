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
  const byeCount = size - players.length;
  const slots = [];
  // Spread byes across the draw so no empty-vs-empty opening matches are created.
  for (let i = 0; i < byeCount; i++) slots.push(players[i], null);
  for (let i = byeCount; i < players.length; i += 2) slots.push(players[i], players[i + 1] || null);
  const totalRounds = Math.log2(size);

  const build = db.transaction(() => {
    const insert = db.prepare("INSERT INTO matches (tournament_id, round_number, match_number, player1_id, player2_id, winner_id, status) VALUES (?, ?, ?, ?, ?, ?, ?)");
    const updateSlot = db.prepare("UPDATE matches SET player1_id = ? WHERE tournament_id = ? AND round_number = ? AND match_number = ?");
    const updateSlot2 = db.prepare("UPDATE matches SET player2_id = ? WHERE tournament_id = ? AND round_number = ? AND match_number = ?");
    for (let round = 1; round <= totalRounds; round++) {
      const count = size / (2 ** round);
      for (let matchNo = 1; matchNo <= count; matchNo++) {
        const p1 = round === 1 ? slots[(matchNo - 1) * 2] || null : null;
        const p2 = round === 1 ? slots[(matchNo - 1) * 2 + 1] || null : null;
        const byeWinner = round === 1 && p1 && !p2 ? p1 : null;
        insert.run(id, round, matchNo, p1, p2, byeWinner, byeWinner ? "completed" : "pending");
      }
    }
    // A first-round bye advances its player, but the next match remains pending
    // until the other feeder match has produced its winner.
    const firstRound = db.prepare("SELECT * FROM matches WHERE tournament_id = ? AND round_number = 1").all(id);
    for (const match of firstRound) {
      if (match.status !== "completed" || !match.winner_id || totalRounds < 2) continue;
      const nextNo = Math.ceil(match.match_number / 2);
      if (match.match_number % 2 === 1) updateSlot.run(match.winner_id, id, 2, nextNo);
      else updateSlot2.run(match.winner_id, id, 2, nextNo);
    }
    db.prepare("UPDATE tournaments SET status = 'ongoing', started_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);
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
