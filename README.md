# LE-APEX

Multi-server Discord Tournament Manager.

One bot can serve many Discord communities. Each server has its own isolated tournament records, registrations, brackets and match results.

## Commands

- /tournament create - create a tournament (Manage Server)
- /tournament list - list tournaments in the current server
- /tournament register - join a tournament
- /tournament start - close registration and generate a randomized single-elimination bracket (Manage Server)
- /tournament bracket - view a tournament bracket
- /tournament result - record a match winner (Manage Server)
- /tournament cancel - cancel a tournament (Manage Server)

## Multi-server isolation

Every tournament stores its originating Discord server ID. All tournament reads and writes are scoped to the current server, so an ID from another server cannot be used to view or manage its tournaments.

## Requirements

- Node.js 20+
- Discord application and bot token
- Bot invited with bot and applications.commands scopes
- Send Messages and Embed Links permissions
- Persistent Node.js process and durable disk storage for SQLite

## Setup

1. Install dependencies with npm install.
2. Copy .env.example to .env.
3. Set DISCORD_TOKEN privately.
4. Optionally set COMMAND_GUILD_ID for instant command registration in a test server. Leave blank for global registration.
5. Run npm start.

LE-APEX uses Discord slash-command interactions and does not need the privileged Message Content Intent.

## Hosting

SQLite requires durable storage. Do not use a host that deletes local files when the service restarts. Free hosting limits and uptime can change; no host is guaranteed to be free or online 24/7.

## Security

- Never commit .env or publish the bot token.
- Do not send the token in chat or screenshots.
- Keep Manage Server checks enabled for tournament administration.
- Tournament data is isolated by Discord server ID.

## Roadmap

- Automated tests for bracket generation and result progression
- Double elimination and league formats
- Team registration and team tournaments
- Match deadlines, reminders and dispute handling
- Optional public web dashboard
