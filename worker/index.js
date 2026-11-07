const API = "https://discord.com/api/v10";
const EPHEMERAL = 64;
const STATUS = { registration: "Registration open", ongoing: "In progress", completed: "Completed", cancelled: "Cancelled" };

function hexToBytes(hex) {
  if (!/^[0-9a-f]{64}$/i.test(hex || "")) throw new Error("Invalid Discord public key");
  return Uint8Array.from(hex.match(/.{2}/g), (b) => parseInt(b, 16));
}
function fromHex(hex) { return Uint8Array.from(hex.match(/.{2}/g) || [], (b) => parseInt(b, 16)); }
async function verifyDiscordRequest(request, body, publicKey) {
  const signature = request.headers.get("X-Signature-Ed25519");
  const timestamp = request.headers.get("X-Signature-Timestamp");
  if (!signature || !timestamp || !/^\d+$/.test(timestamp)) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  try {
    const key = await crypto.subtle.importKey("raw", hexToBytes(publicKey), { name: "Ed25519" }, false, ["verify"]);
    return crypto.subtle.verify({ name: "Ed25519" }, key, fromHex(signature), new TextEncoder().encode(timestamp + body));
  } catch { return false; }
}
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8" } });
const reply = (content, ephemeral = false) => ({ type: 4, data: { content, ...(ephemeral ? { flags: EPHEMERAL } : {}) } });
const embedReply = (title, description, color = 0x7C3AED, ephemeral = false) => ({
  type: 4, data: { embeds: [{ title, description, color, footer: { text: "LE-APEX • Multi-server Tournament Manager" } }], ...(ephemeral ? { flags: EPHEMERAL } : {}) }
});
function option(options, name) { return options?.find((o) => o.name === name); }
function value(options, name) { return option(options, name)?.value; }
function subcommand(options) { return option(options, ""); }
function isManager(interaction) {
  const permissions = BigInt(interaction.member?.permissions || "0");
  return (permissions & 0x20n) === 0x20n || (permissions & 0x8n) === 0x8n;
}
async function tournament(db, guildId, id) {
  return db.prepare("SELECT * FROM tournaments WHERE guild_id = ? AND id = ?").bind(guildId, id).first();
}
async function runCommand(interaction, env) {
  const db = env.DB;
  const guildId = interaction.guild_id;
  if (!guildId) return reply("Use this command inside a server.", true);
  const data = interaction.data;
  const action = data.options?.[0]?.name;
  const opts = data.options?.[0]?.options || [];
  const id = Number(value(opts, "id"));
  const manager = isManager(interaction);

  if (action === "create") {
    if (!manager) return reply("You need Manage Server permission to create tournaments.", true);
    const name = String(value(opts, "name") || "").trim();
    const game = String(value(opts, "game") || "").trim();
    const maxPlayers = Number(value(opts, "players"));
    if (!name || !game || !Number.isInteger(maxPlayers) || maxPlayers < 2 || maxPlayers > 128) return reply("Invalid tournament details.", true);
    const result = await db.prepare("INSERT INTO tournaments (guild_id, name, game, max_players, created_by) VALUES (?, ?, ?, ?, ?)").bind(guildId, name, game, maxPlayers, interaction.member.user.id).run();
    return embedReply("Tournament created", `**${name}**\nGame: ${game}\nPlayer limit: ${maxPlayers}\nTournament ID: **#${result.meta.last_row_id}**\n\nPlayers can join using /tournament register.`, 0x16A34A);
  }
  if (action === "list") {
    const { results = [] } = await db.prepare("SELECT t.*, (SELECT COUNT(*) FROM participants p WHERE p.tournament_id=t.id) AS player_count FROM tournaments t WHERE t.guild_id=? ORDER BY t.id DESC LIMIT 15").bind(guildId).all();
    if (!results.length) return embedReply("No tournaments yet", "A server manager can create one with /tournament create.");
    return embedReply("This server's tournaments", results.map((t) => `**#${t.id} — ${t.name}**\n${t.game} • ${t.player_count}/${t.max_players} players • ${STATUS[t.status] || t.status}`).join("\n\n").slice(0, 4000));
  }
  if (action === "register") {
    const t = await tournament(db, guildId, id);
    if (!t) return reply("That tournament does not exist in this server.", true);
    if (t.status !== "registration") return reply("Registration is closed.", true);
    const user = interaction.member?.user || interaction.user;
    const userId = user.id;
    const existing = await db.prepare("SELECT 1 AS found FROM participants WHERE tournament_id=? AND user_id=?").bind(id, userId).first();
    if (existing) return reply("You're already registered.", true);
    const count = await db.prepare("SELECT COUNT(*) AS count FROM participants WHERE tournament_id=?").bind(id).first();
    if (count.count >= t.max_players) return reply("This tournament is full.", true);
    const displayName = interaction.member?.nick || user.global_name || user.username;
    try {
      await db.prepare("INSERT INTO participants (tournament_id,user_id,display_name) VALUES (?,?,?)").bind(id, userId, displayName).run();
      return embedReply("Registration confirmed", `You're registered for **${t.name}** (#${id}). Good luck!`, 0x16A34A, true);
    } catch { return reply("Registration could not be completed. You may already be registered.", true); }
  }
  if (action === "start") {
    if (!manager) return reply("You need Manage Server permission to start tournaments.", true);
    const t = await tournament(db, guildId, id);
    if (!t) return reply("That tournament does not exist in this server.", true);
    if (t.status !== "registration") return reply("That tournament has already started or is closed.", true);
    const { results: people = [] } = await db.prepare("SELECT user_id FROM participants WHERE tournament_id=? ORDER BY joined_at,id").bind(id).all();
    const players = people.map((p) => p.user_id);
    if (players.length < 2) return reply("At least two players must register.", true);
    for (let i = players.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [players[i], players[j]] = [players[j], players[i]]; }
    const size = 2 ** Math.ceil(Math.log2(players.length));
    const byeCount = size - players.length;
    const slots = [];
    for (let i = 0; i < byeCount; i++) slots.push(players[i], null);
    for (let i = byeCount; i < players.length; i += 2) slots.push(players[i], players[i + 1] || null);
    const rounds = Math.log2(size);
    const statements = [];
    for (let round = 1; round <= rounds; round++) {
      const count = size / (2 ** round);
      for (let match = 1; match <= count; match++) {
        const p1 = round === 1 ? slots[(match - 1) * 2] || null : null;
        const p2 = round === 1 ? slots[(match - 1) * 2 + 1] || null : null;
        const winner = round === 1 && p1 && !p2 ? p1 : null;
        statements.push(db.prepare("INSERT INTO matches (tournament_id,round_number,match_number,player1_id,player2_id,winner_id,status) VALUES (?,?,?,?,?,?,?)").bind(id, round, match, p1, p2, winner, winner ? "completed" : "pending"));
      }
    }
    const firstRound = slots.reduce((acc, player, index) => {
      if (index % 2 === 0 && player && !slots[index + 1]) acc.push({ match: index / 2 + 1, player });
      return acc;
    }, []);
    for (const bye of firstRound) {
      const next = Math.ceil(bye.match / 2);
      if (rounds >= 2) {
        const column = bye.match % 2 === 1 ? "player1_id" : "player2_id";
        statements.push(db.prepare(`UPDATE matches SET ${column}=? WHERE tournament_id=? AND round_number=2 AND match_number=?`).bind(bye.player, id, next));
      }
    }
    statements.push(db.prepare("UPDATE tournaments SET status='ongoing',started_at=CURRENT_TIMESTAMP WHERE id=? AND guild_id=? AND status='registration'").bind(id, guildId));
    await db.batch(statements);
    return embedReply("Bracket generated", `**${t.name}**\nPlayers: **${players.length}**\nRounds: **${rounds}**\n\nUse /tournament bracket id:${id} to view the draw.`, 0x16A34A);
  }
  if (action === "bracket") {
    const t = await tournament(db, guildId, id);
    if (!t) return reply("That tournament does not exist in this server.", true);
    const { results: matches = [] } = await db.prepare("SELECT * FROM matches WHERE tournament_id=? ORDER BY round_number,match_number").bind(id).all();
    if (!matches.length) return embedReply(`#${id} — ${t.name}`, "The bracket appears after a manager starts the tournament.");
    const { results: participants = [] } = await db.prepare("SELECT user_id,display_name FROM participants WHERE tournament_id=?").bind(id).all();
    const names = new Map(participants.map((p) => [p.user_id, p.display_name]));
    const rounds = new Map();
    for (const m of matches) { if (!rounds.has(m.round_number)) rounds.set(m.round_number, []); rounds.get(m.round_number).push(m); }
    const sections = [...rounds.entries()].map(([round, rows]) => `**Round ${round}**\n` + rows.map((m) => {
      const p1 = names.get(m.player1_id) || (m.player1_id ? "Participant" : "TBD");
      const p2 = names.get(m.player2_id) || (m.player2_id ? "Participant" : "TBD");
      const winner = names.get(m.winner_id);
      return `M${m.match_number}: ${p1} vs ${p2}${winner ? ` — Winner: **${winner}**` : ""}`;
    }).join("\n"));
    return embedReply(`#${id} — ${t.name}`, sections.join("\n\n").slice(0, 4000));
  }
  if (action === "result") {
    if (!manager) return reply("You need Manage Server permission to record results.", true);
    const t = await tournament(db, guildId, id);
    if (!t) return reply("That tournament does not exist in this server.", true);
    if (t.status !== "ongoing") return reply("That tournament is not running.", true);
    const round = Number(value(opts, "round"));
    const matchNo = Number(value(opts, "match"));
    const winner = value(opts, "winner");
    const match = await db.prepare("SELECT * FROM matches WHERE tournament_id=? AND round_number=? AND match_number=?").bind(id, round, matchNo).first();
    if (!match || match.status !== "pending") return reply("That pending match could not be found.", true);
    if (![match.player1_id, match.player2_id].includes(winner)) return reply("The selected winner is not in that match.", true);
    const nextRound = round + 1;
    const nextMatchNo = Math.ceil(matchNo / 2);
    const next = await db.prepare("SELECT * FROM matches WHERE tournament_id=? AND round_number=? AND match_number=?").bind(id, nextRound, nextMatchNo).first();
    const statements = [db.prepare("UPDATE matches SET winner_id=?,score=?,status='completed' WHERE id=? AND status='pending'").bind(winner, value(opts, "score") || null, match.id)];
    if (next) {
      const column = matchNo % 2 === 1 ? "player1_id" : "player2_id";
      statements.push(db.prepare(`UPDATE matches SET ${column}=? WHERE id=?`).bind(winner, next.id));
    } else {
      statements.push(db.prepare("UPDATE tournaments SET status='completed',completed_at=CURRENT_TIMESTAMP WHERE id=?").bind(id));
    }
    await db.batch(statements);
    return embedReply("Result recorded", `Winner: <@${winner}>${value(opts, "score") ? `\nScore: ${value(opts, "score")}` : ""}`, 0x16A34A);
  }
  if (action === "cancel") {
    if (!manager) return reply("You need Manage Server permission to cancel tournaments.", true);
    const t = await tournament(db, guildId, id);
    if (!t) return reply("That tournament does not exist in this server.", true);
    if (["completed", "cancelled"].includes(t.status)) return reply("That tournament is already finished or cancelled.", true);
    await db.prepare("UPDATE tournaments SET status='cancelled' WHERE id=? AND guild_id=?").bind(id, guildId).run();
    return embedReply("Tournament cancelled", `**${t.name}** has been cancelled.`, 0xD97706);
  }
  return reply("Unknown tournament command.", true);
}
async function registerCommands(env) {
  const commands = [{
    name: "tournament", description: "Create and manage tournaments in this server", dm_permission: false,
    options: [
      { type: 1, name: "create", description: "Create a tournament", options: [
        { type: 3, name: "name", description: "Tournament name", required: true, max_length: 80 },
        { type: 3, name: "game", description: "Game or competition", required: true, max_length: 60 },
        { type: 4, name: "players", description: "Maximum players, 2 to 128", required: true, min_value: 2, max_value: 128 }
      ]},
      { type: 1, name: "list", description: "List this server's tournaments" },
      { type: 1, name: "register", description: "Register for a tournament", options: [{ type: 4, name: "id", description: "Tournament ID", required: true, min_value: 1 }] },
      { type: 1, name: "start", description: "Close registration and generate a random bracket", options: [{ type: 4, name: "id", description: "Tournament ID", required: true, min_value: 1 }] },
      { type: 1, name: "bracket", description: "View a tournament bracket", options: [{ type: 4, name: "id", description: "Tournament ID", required: true, min_value: 1 }] },
      { type: 1, name: "result", description: "Record a match winner", options: [
        { type: 4, name: "id", description: "Tournament ID", required: true, min_value: 1 },
        { type: 4, name: "round", description: "Round number", required: true, min_value: 1 },
        { type: 4, name: "match", description: "Match number in that round", required: true, min_value: 1 },
        { type: 6, name: "winner", description: "Winning participant", required: true },
        { type: 3, name: "score", description: "Optional score, e.g. 3-1", max_length: 20 }
      ]},
      { type: 1, name: "cancel", description: "Cancel a tournament", options: [{ type: 4, name: "id", description: "Tournament ID", required: true, min_value: 1 }] }
    ]
  }];
  const response = await fetch(`${API}/applications/${env.DISCORD_APPLICATION_ID}/commands`, {
    method: "PUT",
    headers: { Authorization: `Bot ${env.DISCORD_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(commands)
  });
  if (!response.ok) throw new Error(`Discord command registration failed: ${response.status} ${await response.text()}`);
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") return new Response("LE-APEX is running. Discord interactions endpoint is active.");
    if (request.method === "POST" && url.pathname === "/setup") {
      if (!env.SETUP_SECRET || request.headers.get("Authorization") !== `Bearer ${env.SETUP_SECRET}`) return new Response("Unauthorized", { status: 401 });
      try { await registerCommands(env); return json({ ok: true, message: "LE-APEX slash commands registered globally." }); }
      catch (error) { return json({ ok: false, error: error.message }, 500); }
    }
    if (request.method !== "POST" || url.pathname !== "/interactions") return new Response("Not found", { status: 404 });
    const body = await request.text();
    if (!await verifyDiscordRequest(request, body, env.DISCORD_PUBLIC_KEY)) return new Response("Invalid request signature", { status: 401 });
    let interaction;
    try { interaction = JSON.parse(body); } catch { return new Response("Invalid JSON", { status: 400 }); }
    if (interaction.type === 1) return json({ type: 1 });
    if (interaction.type !== 2 || interaction.data?.name !== "tournament") return json(reply("Unsupported interaction.", true));
    try { return json(await runCommand(interaction, env)); }
    catch (error) { console.error("LE-APEX interaction error", error); return json(reply("Something went wrong. Please try again.", true)); }
  }
};
