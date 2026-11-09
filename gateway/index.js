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
      ? "Registration is open. Type **.reg** in this channel to secure your place. Use **.unreg** to withdraw before the tournament starts.\n\nOne account = one entry. Your place is confirmed only after LE-APEX replies."
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
      session: Boolean(await this.ctx.storage.get("session_id"))
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
      if (!message.guild_id || message.author?.bot || message.webhook_id) return;
      const command = String(message.content || "").trim().toLowerCase();
      if (command === ".reg") await this.handleRegistration(message, false);
      else if (command === ".unreg") await this.handleRegistration(message, true);
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
    if (!response.ok) console.error("LE-APEX could not send registration response", response.status, await response.text());
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
      if (withdraw) {
        const removed = await this.env.DB.prepare(
          "DELETE FROM participants WHERE tournament_id=? AND user_id=? AND EXISTS (SELECT 1 FROM tournaments WHERE id=? AND guild_id=? AND status='registration')"
        ).bind(t.id, userId, t.id, guildId).run();
        if (!removed.meta.changes) {
          await this.sendMessage(channelId, `<@${userId}> you don't have an active registration to withdraw from in **${t.name}**.`, userId);
          return;
        }
        await updateRegistrationPanel(this.env, t);
        await this.sendMessage(channelId, `<@${userId}> your registration for **${t.name}** has been withdrawn. You can use **.reg** again before registration closes.`, userId);
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
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const gateway = env.GATEWAY.getByName("le-apex-gateway");
    if (request.method === "GET" && url.pathname === "/") {
      return Response.json({ service: "LE-APEX Gateway", message: "Gateway service ready. Configure DISCORD_TOKEN, then open /start.", status: "idle" });
    }
    if (request.method === "GET" && url.pathname === "/start") {
      try {
        const status = await gateway.start();
        return Response.json({ ok: true, status, message: "Gateway startup requested." });
      } catch (error) {
        return Response.json({ ok: false, error: error.message }, { status: 500 });
      }
    }
    if (request.method === "GET" && url.pathname === "/status") {
      return Response.json(await gateway.status());
    }
    return new Response("Not found", { status: 404 });
  }
};
