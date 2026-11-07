const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "le-apex-test-"));
process.env.DATABASE_PATH = path.join(dir, "test.sqlite");
const { db, initializeDatabase } = require("../src/database");
const service = require("../src/tournament-service");

before(() => initializeDatabase());
after(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function makeTournament(guildId, count) {
  const t = service.createTournament({
    guildId, name: "Test Cup", game: "Test Game",
    maxPlayers: count, createdBy: "manager"
  });
  for (let i = 1; i <= count; i++) {
    const result = service.registerPlayer(guildId, t.id, `user-${i}`, `Player ${i}`);
    assert.equal(result.ok, true);
  }
  return t;
}

function completeRound(guildId, tournamentId, round) {
  const bracket = service.getBracket(guildId, tournamentId);
  const matches = bracket.matches.filter((m) => m.round_number === round && m.status === "pending");
  for (const match of matches) {
    assert.ok(match.player1_id && match.player2_id, `Round ${round} match ${match.match_number} must have both players`);
    const result = service.reportResult(guildId, tournamentId, round, match.match_number, match.player1_id, "1-0");
    assert.equal(result.ok, true);
  }
}

test("rejects duplicate registrations and isolates tournaments by server", () => {
  const t = makeTournament("guild-A", 2);
  assert.deepEqual(service.registerPlayer("guild-A", t.id, "user-1", "Player 1"),
    { ok: false, reason: "already_registered" });
  assert.equal(service.getBracket("guild-B", t.id), null);
  assert.equal(service.registerPlayer("guild-B", t.id, "outsider", "Outsider").reason, "not_found");
});

test("rejects starting with fewer than two players", () => {
  const t = service.createTournament({
    guildId: "guild-small", name: "Small Cup", game: "Test", maxPlayers: 4, createdBy: "manager"
  });
  service.registerPlayer("guild-small", t.id, "only-player", "Only Player");
  assert.deepEqual(service.startTournament("guild-small", t.id), { ok: false, reason: "too_few" });
});

for (const count of [2, 3, 5, 8, 17]) {
  test(`completes a ${count}-player single-elimination bracket including byes`, () => {
    const guildId = `guild-${count}`;
    const t = makeTournament(guildId, count);
    const started = service.startTournament(guildId, t.id);
    assert.equal(started.ok, true);
    const initial = service.getBracket(guildId, t.id);
    assert.equal(initial.matches.length, (2 ** Math.ceil(Math.log2(count))) - 1);

    const rounds = started.rounds;
    for (let round = 1; round <= rounds; round++) {
      completeRound(guildId, t.id, round);
    }
    const final = service.getBracket(guildId, t.id);
    assert.equal(final.tournament.status, "completed");
    const finalMatch = final.matches.find((m) => m.round_number === rounds);
    assert.equal(finalMatch.status, "completed");
    assert.ok(finalMatch.winner_id);
  });
}

test("does not allow a manager to report a winner outside the match", () => {
  const t = makeTournament("guild-winner", 2);
  service.startTournament("guild-winner", t.id);
  const match = service.getBracket("guild-winner", t.id).matches[0];
  assert.deepEqual(
    service.reportResult("guild-winner", t.id, 1, 1, "not-a-player", null),
    { ok: false, reason: "winner_not_in_match" }
  );
  assert.equal(match.status, "pending");
});
