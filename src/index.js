require("dotenv").config();
const { Client, GatewayIntentBits, REST, Routes } = require("discord.js");
const { commandData, handleTournamentCommand } = require("./tournament-commands");
const { initializeDatabase } = require("./database");

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error("[LE-APEX] Missing DISCORD_TOKEN environment variable.");
  process.exit(1);
}
initializeDatabase();

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once("ready", async (readyClient) => {
  console.log(`[LE-APEX] Online as ${readyClient.user.tag}`);
  try {
    const rest = new REST({ version: "10" }).setToken(token);
    const commands = commandData.map((command) => command.toJSON());
    if (process.env.COMMAND_GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(readyClient.application.id, process.env.COMMAND_GUILD_ID), { body: commands });
      console.log("[LE-APEX] Test-server commands registered.");
    } else {
      await rest.put(Routes.applicationCommands(readyClient.application.id), { body: commands });
      console.log("[LE-APEX] Global commands registered.");
    }
  } catch (error) {
    console.error("[LE-APEX] Command registration failed:", error);
  }
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== "tournament") return;
  try {
    await handleTournamentCommand(interaction);
  } catch (error) {
    console.error("[LE-APEX] Command error:", error);
    const payload = { content: "Something went wrong. Please try again.", ephemeral: true };
    if (interaction.deferred || interaction.replied) await interaction.followUp(payload).catch(() => {});
    else await interaction.reply(payload).catch(() => {});
  }
});
client.on("error", (error) => console.error("[LE-APEX] Discord error:", error));
process.on("unhandledRejection", (error) => console.error("[LE-APEX] Unhandled rejection:", error));
client.login(token);
