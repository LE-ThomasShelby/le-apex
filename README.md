# LEGION AI

**Intelligence. Without Limits.**

A Discord-first AI assistant for the LEGION community. Members interact using the simple `.q` prefix.

## Current features

- `.q <question>` — ask LEGION AI
- `.q help` — show usage
- `.q clear` — clear your saved conversation context
- `.q model` — show AI provider status
- Per-member, per-server conversation history
- Configurable OpenAI-compatible inference provider
- Discord message-length splitting
- Per-member cooldown
- Optional single-server restriction using `GUILD_ID`

## Requirements

- Node.js 20+
- A Discord application and bot
- Message Content Intent enabled in the Discord Developer Portal
- An AI inference endpoint compatible with OpenAI chat completions

## Local setup

1. Install Node.js 20 or newer.
2. Run `npm install`.
3. Copy `.env.example` to `.env`.
4. Set `DISCORD_TOKEN`.
5. Configure `AI_BASE_URL` and `AI_MODEL` after selecting a verified inference provider.
6. Run `npm start`.

## Discord configuration

In the Discord Developer Portal, open the bot's settings and enable **Message Content Intent**. Invite the bot with permission to view channels, read message history, and send messages.

## AI provider and cost

The provider adapter accepts an OpenAI-compatible `/chat/completions` endpoint. The bot code itself does not require a paid AI subscription, but a working inference service is required to generate answers. A free, no-card provider has not yet been verified or configured. Do not enter payment details to complete this setup.

## Hosting and persistence

This initial version uses a Node.js Discord Gateway connection and SQLite. The host must support a persistent Node.js process and durable disk storage, or the database must be migrated to a managed persistent database. Free hosting availability and limits vary; do not assume an always-on free service.

## Security

- Never commit `.env` or bot tokens.
- Restrict the bot to the intended LEGION server using `GUILD_ID` if desired.
- Keep staff-only data out of member-accessible AI context.
- Add provider-side privacy and retention review before public launch.

## Status

Initial source scaffold created. Discord bot logic and conversation storage are implemented. AI provider selection, Discord credentials, deployment, and live testing remain outstanding.
