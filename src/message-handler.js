const { EmbedBuilder } = require("discord.js");
const { getReply, isConfigured } = require("./ai/provider");
const { getHistory, addExchange, clearHistory } = require("./database");

const cooldowns = new Map();
const PREFIX = ".q";

function makeEmbed(title, description, color = 0xC62836) {
  return new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setDescription(description)
    .setFooter({ text: "LEGION AI • Intelligence. Without Limits." });
}

async function sendLongReply(message, text) {
  const limit = Number(process.env.MAX_MESSAGE_LENGTH || 1800);
  const chunks = [];
  let remaining = String(text || "").trim();

  while (remaining.length > limit) {
    let cut = remaining.lastIndexOf("\n", limit);
    if (cut < limit * 0.55) cut = remaining.lastIndexOf(" ", limit);
    if (cut < limit * 0.55) cut = limit;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) chunks.push(remaining);

  for (let i = 0; i < chunks.length; i++) {
    await message.reply({
      content: chunks[i],
      allowedMentions: { repliedUser: false },
    });
  }
}

async function handleQuestionMessage(message) {
  if (message.author.bot || !message.guild) return;
  const normalized = message.content.toLowerCase();
  if (normalized !== PREFIX && !normalized.startsWith(PREFIX + " ")) return;

  const guildLock = process.env.GUILD_ID;
  if (guildLock && message.guild.id !== guildLock) return;

  const input = message.content.slice(PREFIX.length).trim();
  const userId = message.author.id;

  if (!input || input.toLowerCase() === "help") {
    return message.reply({
      embeds: [makeEmbed(
        "How to use LEGION AI",
        "**Ask anything:** `.q What is artificial intelligence?\n.q Explain this message\n.q Help me write an announcement`\n\n**Clear your chat:** `.q clear`\nYour conversation history is used to provide follow-up context and is not displayed to other members."
      )],
      allowedMentions: { repliedUser: false },
    });
  }

  if (input.toLowerCase() === "clear") {
    clearHistory(userId, message.guild.id);
    return message.reply({
      embeds: [makeEmbed("Conversation cleared", "Your saved LEGION AI conversation context has been cleared.", 0x687386)],
      allowedMentions: { repliedUser: false },
    });
  }

  if (input.toLowerCase() === "model") {
    const model = process.env.AI_MODEL || "Not configured";
    return message.reply({
      embeds: [makeEmbed("AI engine", isConfigured() ? `Configured model: \`${model}\`` : "No AI provider is configured yet. The bot is online, but it cannot generate AI answers until a provider is connected.", 0x687386)],
      allowedMentions: { repliedUser: false },
    });
  }

  const cooldownSeconds = Number(process.env.USER_COOLDOWN_SECONDS || 4);
  const now = Date.now();
  const last = cooldowns.get(userId) || 0;
  if (now - last < cooldownSeconds * 1000) {
    return message.reply({
      content: `Please wait ${Math.ceil((cooldownSeconds * 1000 - (now - last)) / 1000)}s before asking another question.`,
      allowedMentions: { repliedUser: false },
    });
  }
  cooldowns.set(userId, now);

  if (!isConfigured()) {
    return message.reply({
      embeds: [makeEmbed(
        "AI engine not connected yet",
        "The Discord bot is ready to receive .q messages, but an AI inference provider has not been configured. No paid API or card details are required by this code; we still need to select and verify a genuinely free provider before enabling answers.",
        0xD18A28
      )],
      allowedMentions: { repliedUser: false },
    });
  }

  await message.channel.sendTyping();
  try {
    const history = getHistory(userId, message.guild.id);
    const answer = await getReply(history, input);
    addExchange(userId, message.guild.id, input, answer);
    await sendLongReply(message, answer);
  } catch (error) {
    console.error("[LEGION AI] Provider error:", error);
    await message.reply({
      embeds: [makeEmbed("I couldn't complete that request", "The AI service is temporarily unavailable. Please try again shortly.", 0xB3261E)],
      allowedMentions: { repliedUser: false },
    });
  }
}

module.exports = { handleQuestionMessage };
