import { DurableObject } from "cloudflare:workers";

const API = "https://discord.com/api/v10";

async function discordApi(env, path, method = "GET", body) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bot ${env.DISCORD_TOKEN}`, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  if (response.status === 204) return null;
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch {}
  if (!response.ok) throw new Error(`Discord API ${method} ${path} failed: ${response.status} ${data.message || text}`);
  return data;
}

function registrationEmbed(t, count) {
  const full = count >= t.max_players;
  const open = t.status === "registration" && !full;
  return {
    title: `📋 OFFICIAL REGISTRATION — ${t.name}`,
    description: open
      ? "Registration is open. Type **-reg** in this channel to secure your place. Use **-unreg** to withdraw before the tournament starts.\n\nOne account = one entry. Your place is confirmed only after LE-APEX replies."
      : full ? "All tournament slots have been filled. Registration is closed."
      : "Registration is closed. Follow the announcement channel for tournament updates.",
    color: open ? 0xC9A34D : 0x64748B,
    fields: [
      { name: "Players", value: `**${count} / ${t.max_players}**`, inline: true },
      { name: "Status", value: full ? "FULL" : open ? "OPEN" : "CLOSED", inline: true },
      { name: "Tournament ID", value: `#${t.id}`, inline: true }
    ],
    footer: { text: "LE-APEX • Official Registration Desk" }
  };
}

async function updateRegistrationPanel(env, t) {
  if (!t.registration_channel_id || !t.registration_message_id) return;
  const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM participants WHERE tournament_id=?").bind(t.id).first();
  await discordApi(env, `/channels/${t.registration_channel_id}/messages/${t.registration_message_id}`, "PATCH", {
    embeds: [registrationEmbed(t, Number(row?.count || 0))]
  });
}

export class DiscordGateway extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    this.ws = null;
    this.heartbeatTimer = null;
    this.reconnectTimer = null;
    this.sequence = null;
    this.awaitingAck = false;
    this.stopped = false;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/start") {
      try {
        const status = await this.start();
        return Response.json({ ok: true, status, message: "Gateway startup requested." });
      } catch (error) {
        return Response.json({ ok: false, error: error.message }, { status: 500 });
      }
    }
    if (request.method === "GET" && url.pathname === "/status") {
      return Response.json(await this.status());
    }
    if (request.method === "GET" && url.pathname === "/reidentify") {
      try {
        this.stopped = true;
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
        this.clearHeartbeat();
        const previousSocket = this.ws;
        this.ws = null;
        if (previousSocket && previousSocket.readyState <= WebSocket.OPEN) previousSocket.close(1000, "Refreshing Gateway intents");
        await this.ctx.storage.delete("session_id");
        await this.ctx.storage.delete("resume_gateway_url");
        await this.ctx.storage.delete("sequence");
        this.sequence = null;
        this.stopped = false;
        await this.ctx.storage.put("gateway_status", "connecting");
        await this.connect();
        return Response.json({ ok: true, message: "Fresh Discord Gateway Identify requested with configured intents." });
      } catch (error) {
        this.stopped = false;
        await this.ctx.storage.put("gateway_status", "connection_error");
        return Response.json({ ok: false, error: error.message }, { status: 500 });
      }
    }
    return new Response("Not found", { status: 404 });
  }

  async start() {
    if (!this.env.DISCORD_TOKEN) throw new Error("Add the DISCORD_TOKEN secret to this Gateway Worker first.");
    this.stopped = false;
    const current = await this.ctx.storage.get("gateway_status");
    if (current === "online" && this.ws?.readyState === WebSocket.OPEN) return "online";
    await this.ctx.storage.put("gateway_status", "connecting");
    await this.connect();
    return "connecting";
  }

  async status() {
    return {
      status: await this.ctx.storage.get("gateway_status") || "not_started",
      session: Boolean(await this.ctx.storage.get("session_id")),
      messageEvents: Number(await this.ctx.storage.get("diag_message_events") || 0),
      ignoredBotMessages: Number(await this.ctx.storage.get("diag_ignored_bot_messages") || 0),
      prefixedMessages: Number(await this.ctx.storage.get("diag_prefixed_messages") || 0),
      pingCommands: Number(await this.ctx.storage.get("diag_ping_commands") || 0),
      sendFailures: Number(await this.ctx.storage.get("diag_send_failures") || 0),
      lastMessageAt: await this.ctx.storage.get("diag_last_message_at") || null,
      lastMessageHadContent: await this.ctx.storage.get("diag_last_message_had_content") || false
    };
  }

  async connect() {
    if (this.stopped || (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING))) return;
    try {
      const gatewayResponse = await fetch(`${API}/gateway/bot`, {
        headers: { Authorization: `Bot ${this.env.DISCORD_TOKEN}` }
      });
      if (!gatewayResponse.ok) throw new Error(`Discord gateway discovery failed: ${gatewayResponse.status} ${await gatewayResponse.text()}`);
      const gatewayData = await gatewayResponse.json();
      const base = await this.ctx.storage.get("resume_gateway_url") || gatewayData.url;
      const ws = new WebSocket(`${base}?v=10&encoding=json`);
      this.ws = ws;
      ws.addEventListener("message", event => { this.ctx.waitUntil(this.onGatewayMessage(ws, event.data)); });
      ws.addEventListener("close", event => {
        if (this.ws !== ws) return;
        this.ws = null;
        this.clearHeartbeat();
        if (!this.stopped) {
          this.ctx.waitUntil(this.ctx.storage.put("gateway_status", `disconnected_${event.code}`));
          this.scheduleReconnect(5000);
        }
      });
      ws.addEventListener("error", () => {
        if (this.ws === ws) this.ctx.waitUntil(this.ctx.storage.put("gateway_status", "connection_error"));
      });
    } catch (error) {
      console.error("LE-APEX Gateway connection error", error);
      await this.ctx.storage.put("gateway_status", "connection_error");
      this.scheduleReconnect(10000);
    }
  }

  scheduleReconnect(delay) {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.ctx.waitUntil(this.connect());
    }, delay);
  }

  clearHeartbeat() {
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.awaitingAck = false;
  }

  sendGateway(payload) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(payload));
  }

  heartbeat(interval) {
    this.clearHeartbeat();
    const tick = () => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      if (this.awaitingAck) {
        this.ws.close(4000, "Heartbeat ACK not received");
        return;
      }
      this.awaitingAck = true;
      this.sendGateway({ op: 1, d: this.sequence });
      this.heartbeatTimer = setTimeout(tick, interval);
    };
    this.heartbeatTimer = setTimeout(tick, interval * Math.random());
  }

  async onGatewayMessage(ws, raw) {
    if (this.ws !== ws) return;
    let packet;
    try { packet = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw)); } catch { return; }
    if (packet.s !== null && packet.s !== undefined) {
      this.sequence = packet.s;
      await this.ctx.storage.put("sequence", packet.s);
    }
    if (packet.op === 10) {
      const interval = Number(packet.d?.heartbeat_interval || 41250);
      this.heartbeat(interval);
      const sessionId = await this.ctx.storage.get("session_id");
      const sequence = await this.ctx.storage.get("sequence");
      const token = this.env.DISCORD_TOKEN;
      if (sessionId && sequence !== null && sequence !== undefined) {
        this.sendGateway({ op: 6, d: { token, session_id: sessionId, seq: sequence } });
      } else {
        this.sendGateway({
          op: 2,
          d: {
            token,
            intents: 33281,
            properties: { os: "linux", browser: "le-apex", device: "le-apex" }
          }
        });
      }
      return;
    }
    if (packet.op === 11) {
      this.awaitingAck = false;
      return;
    }
    if (packet.op === 1) {
      this.sendGateway({ op: 1, d: this.sequence });
      return;
    }
    if (packet.op === 7) {
      ws.close(4000, "Discord requested reconnect");
      return;
    }
    if (packet.op === 9) {
      await this.ctx.storage.delete("session_id");
      await this.ctx.storage.delete("resume_gateway_url");
      await this.ctx.storage.delete("sequence");
      ws.close(4000, "Invalid session; re-identifying");
      return;
    }
    if (packet.op !== 0) return;
    if (packet.t === "READY") {
      await this.ctx.storage.put("session_id", packet.d.session_id);
      await this.ctx.storage.put("resume_gateway_url", packet.d.resume_gateway_url);
      await this.ctx.storage.put("gateway_status", "online");
      console.log("LE-APEX Discord Gateway is online", packet.d.user?.id);
      return;
    }
    if (packet.t === "RESUMED") {
      await this.ctx.storage.put("gateway_status", "online");
      console.log("LE-APEX Discord Gateway session resumed");
      return;
    }
    if (packet.t === "MESSAGE_CREATE") {
      const message = packet.d;
      await this.ctx.storage.put("diag_message_events", Number(await this.ctx.storage.get("diag_message_events") || 0) + 1);
      await this.ctx.storage.put("diag_last_message_at", new Date().toISOString());
      await this.ctx.storage.put("diag_last_message_had_content", Boolean(message.content));
      if (!message.guild_id || message.author?.bot || message.webhook_id) {
        if (message.author?.bot || message.webhook_id) {
          await this.ctx.storage.put("diag_ignored_bot_messages", Number(await this.ctx.storage.get("diag_ignored_bot_messages") || 0) + 1);
        }
        return;
      }
      const rawCommand = String(message.content || "").trim();
      const command = rawCommand.toLowerCase();
      if (command.startsWith("-")) {
        await this.ctx.storage.put("diag_prefixed_messages", Number(await this.ctx.storage.get("diag_prefixed_messages") || 0) + 1);
      }
      if (command === "-ping") {
        await this.ctx.storage.put("diag_ping_commands", Number(await this.ctx.storage.get("diag_ping_commands") || 0) + 1);
        await this.sendMessage(message.channel_id, "🏓 Pong! LE-APEX is online.");
      } else if (command === "-fixture" || command.startsWith("-fixture ")) {
        await this.handleFixture(message);
      } else if (command === "-team" || command.startsWith("-team ")) {
        await this.handleTeam(message);
      } else if (command === "-help") {
        await this.sendMessage(message.channel_id,
          "**LE-APEX — COMMAND GUIDE**\n" +
          "-ping — Check bot response/status\n" +
          "-help — Show this guide\n" +
          "-reg — Register for the open tournament in this channel\n" +
          "-unreg — Withdraw before the tournament starts\n" +
          "-fixture — View your own upcoming and completed matchups\n" +
          "-team create/join/leave/list — Build and manage a team in team tournaments\n" +
          "Use /tournament to create, manage, start and view tournaments."
        );
      } else if (command === "-reg") await this.handleRegistration(message, false);
      else if (command === "-unreg") await this.handleRegistration(message, true);
    }
  }

  async sendMessage(channelId, content, userId) {
    const body = {
      content,
      allowed_mentions: userId ? { parse: [], users: [userId] } : { parse: [] }
    };
    const response = await fetch(`${API}/channels/${channelId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bot ${this.env.DISCORD_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      await this.ctx.storage.put("diag_send_failures", Number(await this.ctx.storage.get("diag_send_failures") || 0) + 1);
      console.error("LE-APEX could not send Discord response", response.status, await response.text());
    }
  }

  async handleRegistration(message, withdraw) {
    const guildId = message.guild_id;
    const channelId = message.channel_id;
    const userId = message.author.id;
    try {
      const result = await this.env.DB.prepare(
        "SELECT t.*, COUNT(p.id) AS player_count FROM tournaments t LEFT JOIN participants p ON p.tournament_id=t.id WHERE t.guild_id=? AND t.registration_channel_id=? AND t.status='registration' GROUP BY t.id ORDER BY t.id"
      ).bind(guildId, channelId).all();
      const tournaments = result.results || [];
      if (!tournaments.length) {
        await this.sendMessage(channelId, "There isn't an open tournament in this registration channel right now.");
        return;
      }
      if (tournaments.length > 1) {
        const choices = tournaments.map(t =>
          `• **${t.name}** — ${Number(t.player_count) >= t.max_players ? "FULL" : `#${t.id} · ${t.player_count}/${t.max_players}`}`
        ).join("\n");
        await this.sendMessage(channelId, `There are multiple tournaments accepting registrations here. Choose one using **/tournament register id:TOURNAMENT_ID**:\n${choices}`);
        return;
      }
      const t = tournaments[0];
      if (Number(t.team_size || 1) > 1) {
        await this.handleTeamRegistration(message, t, withdraw);
        return;
      }
      if (withdraw) {
        const removed = await this.env.DB.prepare(
          "DELETE FROM participants WHERE tournament_id=? AND user_id=? AND EXISTS (SELECT 1 FROM tournaments WHERE id=? AND guild_id=? AND status='registration')"
        ).bind(t.id, userId, t.id, guildId).run();
        if (!removed.meta.changes) {
          await this.sendMessage(channelId, `<@${userId}> you don't have an active registration to withdraw from in **${t.name}**.`, userId);
          return;
        }
        await updateRegistrationPanel(this.env, t);
        await this.sendMessage(channelId, `<@${userId}> your registration for **${t.name}** has been withdrawn. You can use **-reg** again before registration closes.`, userId);
        return;
      }
      if (Number(t.player_count) >= t.max_players) {
        await this.sendMessage(channelId, `**${t.name}** is full. Registration is closed.`);
        return;
      }
      const displayName = message.member?.nick || message.author.global_name || message.author.username || "Player";
      const inserted = await this.env.DB.prepare(
        "INSERT INTO participants (tournament_id,user_id,display_name) SELECT ?, ?, ? WHERE (SELECT COUNT(*) FROM participants WHERE tournament_id=?) < (SELECT max_players FROM tournaments WHERE id=? AND guild_id=? AND status='registration') ON CONFLICT(tournament_id,user_id) DO NOTHING"
      ).bind(t.id, userId, displayName, t.id, t.id, guildId).run();
      if (!inserted.meta.changes) {
        const existing = await this.env.DB.prepare("SELECT 1 AS found FROM participants WHERE tournament_id=? AND user_id=?").bind(t.id, userId).first();
        await this.sendMessage(
          channelId,
          existing ? `<@${userId}> you're already registered for **${t.name}**.` : `**${t.name}** is full or registration has closed.`,
          existing ? userId : undefined
        );
        return;
      }
      await updateRegistrationPanel(this.env, t);
      await this.sendMessage(channelId, `<@${userId}> registration confirmed for **${t.name}**! You're on the official player list. Good luck.`, userId);
    } catch (error) {
      console.error("LE-APEX prefix registration error", error);
      await this.sendMessage(channelId, "LE-APEX couldn't process that registration just now. Please try again in a moment.");
    }
  }

  async handleTeamRegistration(message, t, withdraw) {
    const userId = message.author.id;
    const channelId = message.channel_id;
    try {
      const team = await this.env.DB.prepare("SELECT te.*, COUNT(tm.user_id) AS member_count FROM teams te LEFT JOIN team_members tm ON tm.team_id=te.id WHERE te.tournament_id=? AND te.captain_id=? GROUP BY te.id").bind(t.id, userId).first();
      if (withdraw) {
        if (!team) { await this.sendMessage(channelId, "Only the team captain can withdraw a registered team."); return; }
        await this.env.DB.prepare("DELETE FROM participants WHERE tournament_id=? AND user_id=?").bind(t.id, userId).run();
        await this.env.DB.prepare("DELETE FROM teams WHERE id=? AND tournament_id=?").bind(team.id, t.id).run();
        await updateRegistrationPanel(this.env, t);
        await this.sendMessage(channelId, "Your team registration has been withdrawn and its roster released.");
        return;
      }
      if (!team) { await this.sendMessage(channelId, "Create a team first with -team create Team Name, then ask teammates to use -team join TEAM_ID."); return; }
      if (Number(team.member_count) !== Number(t.team_size)) { await this.sendMessage(channelId, "Your roster is incomplete: " + team.member_count + "/" + t.team_size + " members. Fill every slot before -reg."); return; }
      const existing = await this.env.DB.prepare("SELECT 1 AS found FROM participants WHERE tournament_id=? AND user_id=?").bind(t.id, userId).first();
      if (existing) { await this.sendMessage(channelId, "Your team is already registered for " + t.name + "."); return; }
      const count = await this.env.DB.prepare("SELECT COUNT(*) AS count FROM participants WHERE tournament_id=?").bind(t.id).first();
      if (Number(count?.count || 0) >= Number(t.max_players)) { await this.sendMessage(channelId, t.name + " has no team slots remaining."); return; }
      const inserted = await this.env.DB.prepare("INSERT INTO participants (tournament_id,user_id,display_name) VALUES (?,?,?) ON CONFLICT(tournament_id,user_id) DO NOTHING").bind(t.id, userId, team.name).run();
      if (!inserted.meta.changes) { await this.sendMessage(channelId, "Your team is already registered."); return; }
      await updateRegistrationPanel(this.env, t);
      await this.sendMessage(channelId, "🏆 " + team.name + " is officially registered for " + t.name + "!");
    } catch (error) {
      console.error("LE-APEX team registration error", error);
      await this.sendMessage(channelId, "I couldn't process that team registration. Please try again.");
    }
  }

  async handleTeam(message) {
    const channelId = message.channel_id;
    const userId = message.author.id;
    const args = String(message.content || "").trim().split(/\s+/);
    const action = (args[1] || "").toLowerCase();
    try {
      const t = await this.env.DB.prepare("SELECT * FROM tournaments WHERE guild_id=? AND registration_channel_id=? AND status='registration' ORDER BY id DESC LIMIT 1").bind(message.guild_id, channelId).first();
      if (!t) { await this.sendMessage(channelId, "Use team commands in the registration channel of an open tournament."); return; }
      if (Number(t.team_size || 1) <= 1) { await this.sendMessage(channelId, "This tournament is set up for solo entries, not teams."); return; }
      if (action === "create") {
        const name = String(message.content || "").trim().replace(/^-team\s+create\s+/i, "").trim().slice(0, 40);
        if (!name) { await this.sendMessage(channelId, "Usage: -team create Team Name"); return; }
        const existing = await this.env.DB.prepare("SELECT id FROM teams WHERE tournament_id=? AND captain_id=?").bind(t.id, userId).first();
        if (existing) { await this.sendMessage(channelId, "You already captain team #" + existing.id + ". Use -team list."); return; }
        const membership = await this.env.DB.prepare("SELECT team_id FROM team_members WHERE tournament_id=? AND user_id=?").bind(t.id, userId).first();
        if (membership) { await this.sendMessage(channelId, "You're already assigned to a team in this tournament."); return; }
        const created = await this.env.DB.prepare("INSERT INTO teams (tournament_id,name,captain_id) VALUES (?,?,?)").bind(t.id, name, userId).run();
        const teamId = Number(created.meta.last_row_id);
        const displayName = message.member?.nick || message.author.global_name || message.author.username || "Captain";
        await this.env.DB.prepare("INSERT INTO team_members (tournament_id,team_id,user_id,display_name) VALUES (?,?,?,?)").bind(t.id, teamId, userId, displayName).run();
        await this.sendMessage(channelId, "Team " + name + " created! Share team ID #" + teamId + ". Roster: 1/" + t.team_size + ". Teammates: -team join " + teamId);
        return;
      }
      if (action === "join") {
        const teamId = Number(args[2]);
        if (!Number.isInteger(teamId) || teamId < 1) { await this.sendMessage(channelId, "Usage: -team join TEAM_ID"); return; }
        const team = await this.env.DB.prepare("SELECT * FROM teams WHERE id=? AND tournament_id=?").bind(teamId, t.id).first();
        if (!team) { await this.sendMessage(channelId, "That team ID isn't part of this tournament."); return; }
        const count = await this.env.DB.prepare("SELECT COUNT(*) AS count FROM team_members WHERE team_id=?").bind(teamId).first();
        if (Number(count?.count || 0) >= Number(t.team_size)) { await this.sendMessage(channelId, "That team roster is full."); return; }
        const displayName = message.member?.nick || message.author.global_name || message.author.username || "Player";
        const joined = await this.env.DB.prepare("INSERT INTO team_members (tournament_id,team_id,user_id,display_name) VALUES (?,?,?,?) ON CONFLICT(tournament_id,user_id) DO NOTHING").bind(t.id, teamId, userId, displayName).run();
        if (!joined.meta.changes) { await this.sendMessage(channelId, "You're already assigned to a team in this tournament."); return; }
        await this.sendMessage(channelId, "You're on " + team.name + "! Roster: " + (Number(count.count) + 1) + "/" + t.team_size + ".");
        return;
      }
      if (action === "leave") {
        const membership = await this.env.DB.prepare("SELECT tm.*,te.captain_id,te.name FROM team_members tm JOIN teams te ON te.id=tm.team_id WHERE tm.tournament_id=? AND tm.user_id=?").bind(t.id, userId).first();
        if (!membership) { await this.sendMessage(channelId, "You're not on a team in this tournament."); return; }
        if (membership.captain_id === userId) { await this.sendMessage(channelId, "The captain cannot leave their own team. Use -team disband before registering."); return; }
        await this.env.DB.prepare("DELETE FROM team_members WHERE tournament_id=? AND user_id=?").bind(t.id, userId).run();
        await this.sendMessage(channelId, "You've left " + membership.name + ".");
        return;
      }
      if (action === "disband") {
        const team = await this.env.DB.prepare("SELECT * FROM teams WHERE tournament_id=? AND captain_id=?").bind(t.id, userId).first();
        if (!team) { await this.sendMessage(channelId, "Only a team captain can disband their team."); return; }
        const registered = await this.env.DB.prepare("SELECT 1 AS found FROM participants WHERE tournament_id=? AND user_id=?").bind(t.id, userId).first();
        if (registered) { await this.sendMessage(channelId, "Withdraw with -unreg before disbanding your team."); return; }
        await this.env.DB.prepare("DELETE FROM teams WHERE id=? AND tournament_id=?").bind(team.id, t.id).run();
        await this.sendMessage(channelId, "Team " + team.name + " has been disbanded.");
        return;
      }
      if (action === "list") {
        const result = await this.env.DB.prepare("SELECT te.id,te.name,COUNT(tm.user_id) AS member_count FROM teams te LEFT JOIN team_members tm ON tm.team_id=te.id WHERE te.tournament_id=? GROUP BY te.id ORDER BY te.id").bind(t.id).all();
        const rows = result.results || [];
        await this.sendMessage(channelId, rows.length ? rows.map(x => "#" + x.id + " — " + x.name + " (" + x.member_count + "/" + t.team_size + ")").join("\n") : "No teams have been created yet.");
        return;
      }
      await this.sendMessage(channelId, "TEAM COMMANDS\n-team create Team Name — Create a team\n-team join TEAM_ID — Join a team\n-team leave — Leave your team\n-team list — Show teams\n-team disband — Disband your team (captain only)");
    } catch (error) {
      console.error("LE-APEX team command error", error);
      await this.sendMessage(channelId, "Team command failed. Make sure you're using the active registration channel.");
    }
  }

  async handleFixture(message) {
    const userId = message.author.id;
    try {
      const result = await this.env.DB.prepare("SELECT t.id AS tournament_id,t.name AS tournament_name,m.round_number,m.match_number,m.player1_id,m.player2_id,m.winner_id,m.score,m.status,p1.display_name AS p1_name,p2.display_name AS p2_name,pw.display_name AS winner_name FROM tournaments t JOIN matches m ON m.tournament_id=t.id LEFT JOIN participants p1 ON p1.tournament_id=t.id AND p1.user_id=m.player1_id LEFT JOIN participants p2 ON p2.tournament_id=t.id AND p2.user_id=m.player2_id LEFT JOIN participants pw ON pw.tournament_id=t.id AND pw.user_id=m.winner_id WHERE t.guild_id=? AND t.status IN ('ongoing','completed') AND (m.player1_id=? OR m.player2_id=? OR m.player1_id IN (SELECT te.captain_id FROM team_members tm JOIN teams te ON te.id=tm.team_id WHERE tm.tournament_id=t.id AND tm.user_id=?) OR m.player2_id IN (SELECT te.captain_id FROM team_members tm JOIN teams te ON te.id=tm.team_id WHERE tm.tournament_id=t.id AND tm.user_id=?)) ORDER BY t.id DESC,m.round_number,m.match_number LIMIT 20").bind(message.guild_id, userId, userId, userId, userId).all();
      const rows = result.results || [];
      if (!rows.length) { await this.sendMessage(message.channel_id, "No fixtures found for you yet. Make sure you're registered and the tournament has started."); return; }
      const lines = rows.map(m => {
        const p1 = m.p1_name || "TBD";
        const p2 = m.p2_name || "TBD";
        const state = m.status === "completed" ? "Completed" : "Upcoming";
        const winner = m.winner_name ? " — Winner: " + m.winner_name : "";
        const score = m.score ? " — " + m.score : "";
        return m.tournament_name + " · Round " + m.round_number + " · Match " + m.match_number + "\n" + p1 + " vs " + p2 + " · " + state + winner + score;
      });
      await this.sendMessage(message.channel_id, lines.join("\n\n"));
    } catch (error) {
      console.error("LE-APEX fixture lookup error", error);
      await this.sendMessage(message.channel_id, "I couldn't load your fixtures just now. Please try again.");
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") {
      return Response.json({ service: "LE-APEX Gateway", message: "Gateway service ready.", status: "ready" });
    }
    if (request.method === "GET" && (url.pathname === "/start" || url.pathname === "/status" || url.pathname === "/reidentify")) {
      const id = env.GATEWAY.idFromName("le-apex-gateway");
      const stub = env.GATEWAY.get(id);
      return stub.fetch(new Request(`https://gateway.internal${url.pathname}`));
    }
    return new Response("Not found", { status: 404 });
  }
};
