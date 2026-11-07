# LE-APEX

**Multi-server Discord Tournament Manager** — one bot, isolated tournament data for every Discord server.

## Current architecture

- Cloudflare Worker receives Discord HTTP interactions (no always-on Gateway process).
- Cloudflare D1 stores tournaments, participants and matches.
- Discord Ed25519 signatures are verified before any interaction is accepted.
- Server data is isolated by Discord guild ID.
- No Discord privileged intents are required.

## Commands

- `/tournament create` — Manage Server permission
- `/tournament list`
- `/tournament register id:<id>`
- `/tournament start id:<id>` — Manage Server permission
- `/tournament bracket id:<id>`
- `/tournament result id:<id> round:<round> match:<match> winner:<user>` — Manage Server permission
- `/tournament cancel id:<id>` — Manage Server permission

The current engine supports randomized single-elimination brackets, byes, results and automatic advancement.

## Deploy through the Cloudflare dashboard

1. Create a Cloudflare account on the Free plan. Do not add a payment method if you do not want to.
2. Create a D1 database named `le-apex`.
3. In D1, run the SQL in `migrations/0001_init.sql`.
4. Create a Worker named `le-apex` and paste the contents of `worker/index.js` into its editor, or connect this GitHub repository and set the root entry point to `worker/index.js`.
5. Add a D1 binding named `DB` pointing to the database.
6. Add these Worker secrets/variables:
   - `DISCORD_PUBLIC_KEY` — from Discord Developer Portal → General Information → Public Key
   - `DISCORD_APPLICATION_ID` — Application ID
   - `DISCORD_TOKEN` — bot token (secret; never share it in chat)
   - `SETUP_SECRET` — a long random secret you create; store it as a Worker secret
7. Deploy the Worker. Its endpoint is `https://<your-worker>.workers.dev/interactions`.
8. In Discord Developer Portal → General Information, set **Interactions Endpoint URL** to that endpoint. Discord will validate it.
9. After Discord accepts the endpoint, call `POST https://<your-worker>.workers.dev/setup` with header `Authorization: Bearer <SETUP_SECRET>` once to register slash commands globally.
10. Invite the bot with `bot` and `applications.commands` scopes. Give it View Channels, Send Messages and Embed Links permissions where tournaments will be used.

## Free-tier note

Cloudflare Workers and D1 offer free tiers with usage limits. This is not a promise of unlimited usage or guaranteed 24/7 service. The Worker uses D1 instead of local SQLite, so it does not need a persistent server process or local disk.

## Local checks

- `npm test` runs the existing tournament-engine regression tests.
- `npm run check:worker` checks Worker JavaScript syntax.

## Security

- Never commit secrets or share the bot token.
- Discord request signatures are verified before handling commands.
- Setup route requires the private `SETUP_SECRET`.
- Manager-only actions check Manage Server or Administrator permissions.
- Tournament reads and writes are scoped to the current server.

## Roadmap

Double elimination, league tables, team registration, match confirmation/disputes, deadlines and reminders.
