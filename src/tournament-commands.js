const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require("discord.js");
const service = require("./tournament-service");

const commandData = [
  new SlashCommandBuilder()
    .setName("tournament")
    .setDescription("Create and manage tournaments in this server")
    .addSubcommand((s) => s.setName("create").setDescription("Create a tournament")
      .addStringOption((o) => o.setName("name").setDescription("Tournament name").setRequired(true).setMaxLength(80))
      .addStringOption((o) => o.setName("game").setDescription("Game or competition").setRequired(true).setMaxLength(60))
      .addIntegerOption((o) => o.setName("players").setDescription("Maximum players, 2 to 128").setRequired(true).setMinValue(2).setMaxValue(128)))
    .addSubcommand((s) => s.setName("list").setDescription("List this server's tournaments"))
    .addSubcommand((s) => s.setName("register").setDescription("Register for a tournament")
      .addIntegerOption((o) => o.setName("id").setDescription("Tournament ID").setRequired(true).setMinValue(1)))
    .addSubcommand((s) => s.setName("start").setDescription("Close registration and generate a random bracket")
      .addIntegerOption((o) => o.setName("id").setDescription("Tournament ID").setRequired(true).setMinValue(1)))
    .addSubcommand((s) => s.setName("bracket").setDescription("View a tournament bracket")
      .addIntegerOption((o) => o.setName("id").setDescription("Tournament ID").setRequired(true).setMinValue(1)))
    .addSubcommand((s) => s.setName("result").setDescription("Record a match winner")
      .addIntegerOption((o) => o.setName("id").setDescription("Tournament ID").setRequired(true).setMinValue(1))
      .addIntegerOption((o) => o.setName("round").setDescription("Round number").setRequired(true).setMinValue(1))
      .addIntegerOption((o) => o.setName("match").setDescription("Match number in that round").setRequired(true).setMinValue(1))
      .addUserOption((o) => o.setName("winner").setDescription("Winning participant").setRequired(true))
      .addStringOption((o) => o.setName("score").setDescription("Optional score, e.g. 3-1").setMaxLength(20)))
    .addSubcommand((s) => s.setName("cancel").setDescription("Cancel a tournament")
      .addIntegerOption((o) => o.setName("id").setDescription("Tournament ID").setRequired(true).setMinValue(1)))
    .setDMPermission(false)
].map((c) => c);

const manager = (i) => i.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ||
  i.memberPermissions?.has(PermissionFlagsBits.Administrator);

function makeEmbed(title, description, color = 0x7C3AED) {
  return new EmbedBuilder().setColor(color).setTitle(title).setDescription(description)
    .setFooter({ text: "LE-APEX • Multi-server Tournament Manager" });
}

const statusText = {
  registration: "Registration open",
  ongoing: "In progress",
  completed: "Completed",
  cancelled: "Cancelled"
};

async function handleTournamentCommand(i) {
  if (!i.guildId) return i.reply({ content: "Use this command inside a server.", ephemeral: true });
  const action = i.options.getSubcommand();
  const guildId = i.guildId;

  if (action === "create") {
    if (!manager(i)) return i.reply({ content: "You need Manage Server permission to create tournaments.", ephemeral: true });
    const t = service.createTournament({
      guildId,
      name: i.options.getString("name"),
      game: i.options.getString("game"),
      maxPlayers: i.options.getInteger("players"),
      createdBy: i.user.id
    });
    return i.reply({ embeds: [makeEmbed("Tournament created", [
      `**${t.name}**`,
      `Game: ${t.game}`,
      `Player limit: ${t.max_players}`,
      `Tournament ID: **#${t.id}**`,
      "",
      `Players can join using /tournament register id:${t.id}`
    ].join("\n"), 0x16A34A)] });
  }

  if (action === "list") {
    const rows = service.listTournaments(guildId);
    if (!rows.length) return i.reply({ embeds: [makeEmbed("No tournaments yet", "A server manager can create one with /tournament create.")] });
    const body = rows.map((t) => `**#${t.id} — ${t.name}**\n${t.game} • ${t.player_count}/${t.max_players} players • ${statusText[t.status] || t.status}`).join("\n\n");
    return i.reply({ embeds: [makeEmbed("This server's tournaments", body.slice(0, 4000))] });
  }

  if (action === "register") {
    const id = i.options.getInteger("id");
    const r = service.registerPlayer(guildId, id, i.user.id, i.member?.displayName || i.user.username);
    const messages = {
      not_found: "That tournament does not exist in this server.",
      closed: "Registration is closed.",
      full: "This tournament is full.",
      already_registered: "You're already registered."
    };
    return i.reply({ embeds: [makeEmbed(r.ok ? "Registration confirmed" : "Registration unavailable",
      r.ok ? `You're registered for tournament #${id}. Good luck!` : messages[r.reason],
      r.ok ? 0x16A34A : 0xD97706)], ephemeral: true });
  }

  if (action === "start") {
    if (!manager(i)) return i.reply({ content: "You need Manage Server permission to start tournaments.", ephemeral: true });
    const id = i.options.getInteger("id");
    const r = service.startTournament(guildId, id);
    const messages = {
      not_found: "That tournament does not exist in this server.",
      not_open: "That tournament has already started or is closed.",
      too_few: "At least two players must register."
    };
    return i.reply({ embeds: [makeEmbed(r.ok ? "Bracket generated" : "Could not start tournament",
      r.ok ? `Players: **${r.players}**\nRounds: **${r.rounds}**\n\nUse /tournament bracket id:${id} to view the draw.` : messages[r.reason],
      r.ok ? 0x16A34A : 0xD97706)] });
  }

  if (action === "bracket") {
    const id = i.options.getInteger("id");
    const data = service.getBracket(guildId, id);
    if (!data) return i.reply({ content: "That tournament does not exist in this server.", ephemeral: true });
    if (!data.matches.length) return i.reply({ embeds: [makeEmbed(`#${id} — ${data.tournament.name}`, "The bracket appears after a manager starts the tournament.")] });
    const rounds = new Map();
    for (const m of data.matches) {
      if (!rounds.has(m.round_number)) rounds.set(m.round_number, []);
      rounds.get(m.round_number).push(m);
    }
    const sections = [...rounds.entries()].map(([round, matches]) => {
      const lines = matches.map((m) => {
        const p1 = data.names.get(m.player1_id) || (m.player1_id ? "Participant" : "TBD");
        const p2 = data.names.get(m.player2_id) || (m.player2_id ? "Participant" : "TBD");
        const winner = data.names.get(m.winner_id);
        return `M${m.match_number}: ${p1} vs ${p2}${winner ? ` — Winner: **${winner}**` : ""}`;
      });
      return `**Round ${round}**\n${lines.join("\n")}`;
    });
    return i.reply({ embeds: [makeEmbed(`#${id} — ${data.tournament.name}`, sections.join("\n\n").slice(0, 4000))] });
  }

  if (action === "result") {
    if (!manager(i)) return i.reply({ content: "You need Manage Server permission to record results.", ephemeral: true });
    const winner = i.options.getUser("winner");
    const r = service.reportResult(guildId, i.options.getInteger("id"), i.options.getInteger("round"),
      i.options.getInteger("match"), winner.id, i.options.getString("score"));
    const messages = {
      not_found: "That tournament does not exist in this server.",
      not_ongoing: "That tournament is not running.",
      match_not_found: "That pending match could not be found.",
      winner_not_in_match: "The selected winner is not in that match."
    };
    return i.reply({ embeds: [makeEmbed(r.ok ? "Result recorded" : "Could not record result",
      r.ok ? `Winner: **${winner.username}**${i.options.getString("score") ? `\nScore: ${i.options.getString("score")}` : ""}` : messages[r.reason],
      r.ok ? 0x16A34A : 0xD97706)] });
  }

  if (action === "cancel") {
    if (!manager(i)) return i.reply({ content: "You need Manage Server permission to cancel tournaments.", ephemeral: true });
    const ok = service.cancelTournament(guildId, i.options.getInteger("id"));
    return i.reply({ embeds: [makeEmbed(ok ? "Tournament cancelled" : "Tournament not found",
      ok ? "This server's tournament has been cancelled." : "That tournament does not exist here.",
      ok ? 0xD97706 : 0xB91C1C)] });
  }
}

module.exports = { commandData, handleTournamentCommand };
