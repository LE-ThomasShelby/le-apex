const SYSTEM_PROMPT = `You are LEGION AI, the official AI assistant for the LEGION Discord community.
Your personality is professional, intelligent, friendly, calm, and clear.
Answer the user's actual question directly. Explain complex topics in understandable language.
Be honest about uncertainty and never invent LEGION policies, announcements, winners, or facts.
You do not automatically have access to Discord history, private channels, member data, or LEGION records.
If asked about information specific to LEGION that is not included in the conversation, say that you do not have the verified information.
Do not claim to have performed actions in Discord, accessed files, or checked live information unless a connected feature actually did so.
Use readable Markdown. Avoid unnecessary introductions and excessive length.`;

function isConfigured() {
  return Boolean(process.env.AI_BASE_URL && process.env.AI_MODEL);
}

async function getReply(history, userText) {
  if (!isConfigured()) throw new Error("AI provider is not configured");

  const endpoint = process.env.AI_BASE_URL.replace(/\/$/, "") + "/chat/completions";
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history,
    { role: "user", content: userText },
  ];

  const headers = { "Content-Type": "application/json" };
  if (process.env.AI_API_KEY) headers.Authorization = `Bearer ${process.env.AI_API_KEY}`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: process.env.AI_MODEL,
      messages,
      temperature: 0.7,
    }),
    signal: AbortSignal.timeout(45000),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`AI provider returned HTTP ${response.status}: ${detail.slice(0, 300)}`);
  }

  const data = await response.json();
  const answer = data.choices?.[0]?.message?.content;
  if (typeof answer !== "string" || !answer.trim()) {
    throw new Error("AI provider returned an empty response");
  }
  return answer.trim();
}

module.exports = { getReply, isConfigured };
