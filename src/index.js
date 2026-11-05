require("dotenv").config();

const { Client, GatewayIntentBits, Partials } = require("discord.js");
const { handleQuestionMessage } = require("./message-handler");

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error("[LEGION AI] Missing DISCORD_TOKEN. Copy .env.example to .env and configure it.");
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

client.once("ready", (readyClient) => {
  console.log(`[LEGION AI] Online as ${readyClient.user.tag}`);
  console.log("[LEGION AI] Prefix: .q");
  console.log("[LEGION AI] Message Content Intent is required in the Discord Developer Portal.");
});

client.on("messageCreate", async (message) => {
  try {
    await handleQuestionMessage(message, client);
  } catch (error) {
    console.error("[LEGION AI] Message handler error:", error);
  }
});

client.on("error", (error) => console.error("[LEGION AI] Discord client error:", error));
process.on("unhandledRejection", (error) => console.error("[LEGION AI] Unhandled rejection:", error));

client.login(token);
