// Microsoft Teams bot: full interactive chat, same capabilities as Telegram.
// Uses the Bot Framework REST API directly (no SDK). Inbound messages arrive at
// POST /teams/messages (requires the app to be reachable over public HTTPS —
// same requirement as the Xero OAuth callback); replies go out via the connector.
//
// Setup: see .env.example — an Entra app registration + an Azure Bot resource
// (free F0) pointing its messaging endpoint at https://<host>/teams/messages,
// with the Microsoft Teams channel enabled.
import { Router, json } from 'express';
import crypto from 'node:crypto';
import { db } from '../db.js';
import { buildRun } from '../billing.js';
import { formatTicketRef } from '../ticket-utils.js';
import { assistantConfigured, runAssistant } from '../assistant.js';

export function teamsBotConfigured() {
  return Boolean(process.env.TEAMS_BOT_APP_ID && process.env.TEAMS_BOT_APP_PASSWORD);
}

// --- inbound auth: verify the Bot Framework service JWT -----------------------
let jwksCache = { keys: null, exp: 0 };

async function botFrameworkKeys() {
  if (jwksCache.keys && Date.now() < jwksCache.exp) return jwksCache.keys;
  const conf = await (await fetch('https://login.botframework.com/v1/.well-known/openidconfiguration')).json();
  const jwks = await (await fetch(conf.jwks_uri)).json();
  jwksCache = { keys: jwks.keys || [], exp: Date.now() + 24 * 3600 * 1000 };
  return jwksCache.keys;
}

function b64urlJson(part) {
  return JSON.parse(Buffer.from(part, 'base64url').toString());
}

export async function verifyBotJwt(authHeader, appId, fetchKeys = botFrameworkKeys) {
  try {
    const token = String(authHeader || '').replace(/^Bearer\s+/i, '');
    const [h, p, sig] = token.split('.');
    if (!h || !p || !sig) return false;
    const header = b64urlJson(h);
    const payload = b64urlJson(p);
    if (payload.aud !== appId) return false;
    if (payload.iss !== 'https://api.botframework.com') return false;
    if (!payload.exp || payload.exp * 1000 < Date.now() - 5 * 60 * 1000) return false;
    const keys = await fetchKeys();
    const key = keys.find((k) => k.kid === header.kid);
    if (!key) return false;
    const pubKey = crypto.createPublicKey({ key: { kty: key.kty, n: key.n, e: key.e }, format: 'jwk' });
    return crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), pubKey, Buffer.from(sig, 'base64url'));
  } catch {
    return false;
  }
}

// --- outbound: reply through the connector service -----------------------------
let tokenCache = { token: null, exp: 0 };

async function connectorToken() {
  if (tokenCache.token && Date.now() < tokenCache.exp) return tokenCache.token;
  const tenant = process.env.TEAMS_BOT_TENANT_ID || 'botframework.com';
  const res = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: process.env.TEAMS_BOT_APP_ID,
      client_secret: process.env.TEAMS_BOT_APP_PASSWORD,
      scope: 'https://api.botframework.com/.default'
    })
  });
  if (!res.ok) throw new Error(`Bot auth failed (${res.status}): ${await res.text()}`);
  const tok = await res.json();
  tokenCache = { token: tok.access_token, exp: Date.now() + (tok.expires_in - 60) * 1000 };
  return tokenCache.token;
}

async function reply(activity, text) {
  const base = String(activity.serviceUrl || '').replace(/\/$/, '');
  const url = `${base}/v3/conversations/${encodeURIComponent(activity.conversation.id)}/activities/${encodeURIComponent(activity.id)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${await connectorToken()}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      type: 'message',
      from: activity.recipient,
      recipient: activity.from,
      conversation: activity.conversation,
      replyToId: activity.id,
      textFormat: 'plain',
      text
    })
  });
  if (!res.ok) throw new Error(`Teams reply failed (${res.status}): ${await res.text()}`);
}

// --- message handling -----------------------------------------------------------
const money = (n) => 'A$' + Number(n || 0).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const HELP = [
  'Solo PSA — Teams bot',
  '',
  'Just type what you need in plain English:',
  '• "Charge Oasis $450 for laptop supply and setup"',
  '• "Log 2 hours on the printer ticket — cleared the queue"',
  '• "New high-priority ticket for Oasis: email is down"',
  '• "What tickets are open?" / "What\'s ready to bill?"',
  '',
  'Commands: tickets · bill · new (fresh conversation) · help'
].join('\n');

function ticketsText() {
  const rows = db.prepare(`
    SELECT t.id, t.ticket_number, t.subject, t.status, t.priority, c.name AS client
    FROM tickets t LEFT JOIN clients c ON c.id = t.client_id
    WHERE t.status != 'closed'
    ORDER BY CASE t.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, t.updated_at DESC
    LIMIT 15
  `).all();
  if (!rows.length) return 'No open tickets. 🎉';
  return rows.map((t) =>
    `${formatTicketRef(t)} [${t.priority}/${t.status}] ${t.subject}${t.client ? ` — ${t.client}` : ''}`
  ).join('\n');
}

function billText() {
  const period = new Date().toISOString().slice(0, 7);
  const run = buildRun(period);
  const pending = run.items.filter((i) => !i.alreadyInvoiced);
  const lines = [`Billing run — ${run.label}`];
  for (const item of run.items) {
    lines.push(`${item.alreadyInvoiced ? '✅' : '▫️'} ${item.client.name} — ${money(item.total)}`);
  }
  if (!run.items.length) lines.push('Nothing to bill.');
  lines.push('', `Ready to push: ${money(pending.reduce((s, i) => s + i.total, 0))} across ${pending.length} client(s)`);
  lines.push('Push to Xero from the web Billing page.');
  return lines.join('\n');
}

const conversations = new Map(); // conversation.id → [{role, content}]

export async function handleTeamsActivity(activity, sendReply = reply) {
  if (activity.type === 'conversationUpdate' && activity.membersAdded?.some((m) => m.id === activity.recipient?.id)) {
    return sendReply(activity, HELP);
  }
  if (activity.type !== 'message') return;

  // Lock the bot to one operator, like TELEGRAM_ALLOWED_CHAT_ID.
  const allowed = process.env.TEAMS_BOT_ALLOWED_USER_ID;
  const senderId = activity.from?.aadObjectId || activity.from?.id || '';
  if (!allowed) {
    return sendReply(activity,
      `Almost there — lock the bot to you by setting TEAMS_BOT_ALLOWED_USER_ID=${senderId} in .env and restarting.`);
  }
  if (senderId !== allowed) return; // silence for strangers

  // Teams prefixes messages with the bot @mention in channels — strip it.
  const text = String(activity.text || '').replace(/<at>.*?<\/at>/g, '').trim();
  if (!text) return;
  const lower = text.toLowerCase().replace(/^\//, '');

  if (lower === 'help' || lower === 'start') return sendReply(activity, HELP);
  if (lower === 'tickets') return sendReply(activity, ticketsText());
  if (lower === 'bill') return sendReply(activity, billText());
  if (lower === 'new') {
    conversations.delete(activity.conversation.id);
    return sendReply(activity, 'Fresh conversation started.');
  }

  if (!assistantConfigured()) {
    return sendReply(activity,
      'Natural language needs ANTHROPIC_API_KEY in .env. Meanwhile: "tickets", "bill", or use the web UI.');
  }

  const history = conversations.get(activity.conversation.id) || [];
  history.push({ role: 'user', content: text });
  try {
    const { reply: answer } = await runAssistant(history.slice(-20));
    history.push({ role: 'assistant', content: answer });
    conversations.set(activity.conversation.id, history.slice(-20));
    return sendReply(activity, answer);
  } catch (err) {
    history.pop();
    console.error('[teams-bot] assistant error:', err.message);
    return sendReply(activity, `Assistant error: ${err.message}`);
  }
}

// --- express router ---------------------------------------------------------------
const r = Router();
r.use(json({ limit: '256kb' }));

r.post('/messages', async (req, res) => {
  if (!teamsBotConfigured()) return res.status(503).end();
  const ok = await verifyBotJwt(req.headers.authorization, process.env.TEAMS_BOT_APP_ID);
  if (!ok) return res.status(401).end();
  res.status(200).end(); // ack fast; Bot Framework expects a quick 200
  try {
    await handleTeamsActivity(req.body || {});
  } catch (err) {
    console.error('[teams-bot] handler error:', err.message);
  }
});

export default r;
