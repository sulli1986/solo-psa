// Telegram bot: create tickets, log time, and run billing from chat.
// Uses long polling (outbound only — nothing to expose on the LXC).
// Locked to TELEGRAM_ALLOWED_CHAT_ID; everyone else gets silence.
import { db, getSetting, setSetting, getNumberSetting } from '../db.js';
import { buildRun, pushRun, billableMinutes } from '../billing.js';
import { xeroConnected } from './xero.js';
import { parsePlainText } from './telegram-nlp.js';
import { assistantConfigured, runAssistant } from '../assistant.js';
import { parseDbDate, fmtDateTimeShort, todayIsoInTz, hourNowInTz } from '../dates.js';
import { teamsConfigured, sendTeamsMessage } from './teams.js';
import { logTicketEvent, allocateTicketNumber, findTicketByNumberOrId, formatTicketRef, isBillingResolved } from '../ticket-utils.js';

const API = () => `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;

export function telegramConfigured() {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_ALLOWED_CHAT_ID);
}

async function tg(method, payload) {
  const res = await fetch(`${API()}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram ${method}: ${data.description}`);
  return data.result;
}

function send(chatId, text, extra = {}) {
  return tg('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', ...extra });
}

function sendPlain(chatId, text, extra = {}) {
  return tg('sendMessage', { chat_id: chatId, text, ...extra });
}

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const money = (n) => 'A$' + Number(n || 0).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function currentPeriod() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// Fuzzy client lookup: exact (case-insensitive) first, then substring.
function findClient(nameFragment) {
  const frag = nameFragment.trim();
  if (!frag) return { match: null, candidates: [] };
  let match = db.prepare('SELECT * FROM clients WHERE active = 1 AND lower(name) = lower(?)').get(frag);
  if (match) return { match, candidates: [] };
  const candidates = db.prepare("SELECT * FROM clients WHERE active = 1 AND name LIKE ? ORDER BY name LIMIT 5")
    .all(`%${frag}%`);
  return candidates.length === 1 ? { match: candidates[0], candidates: [] } : { match: null, candidates };
}

const HELP = [
  '<b>Solo PSA bot</b>',
  '',
  '<b>Tickets</b>',
  '/ticket &lt;client&gt; | &lt;subject&gt; — new ticket',
  '/tickets — open tickets',
  '/note &lt;id&gt; &lt;text&gt; — add internal note',
  '/time &lt;id&gt; &lt;minutes&gt; [description] — log billable time',
  '/status &lt;id&gt; &lt;open|in_progress|waiting|closed&gt; — change status',
  '/priority &lt;id&gt; &lt;low|normal|high|critical&gt; — change priority',
  '/close &lt;id&gt; — close ticket',
  '',
  '<b>Billing</b>',
  '/charge &lt;client&gt; | &lt;amount&gt; | &lt;description&gt; — one-off line to invoice',
  '/charges — unbilled manual entries',
  '/uncharge &lt;id&gt; — remove an unbilled entry',
  '/bill [YYYY-MM] — preview the run',
  '/push [YYYY-MM] — create Xero drafts (asks first)',
  '',
  '<b>Plain text</b> (no command needed)',
  'charge Apollo 7 hours for the following work:',
  '&lt;multiline description&gt;',
  'Charge Oasis $450 for laptop supply and setup',
  'Invoice Apollo IT for … with a total of 5 hours',
  '',
  '/digest — billing reminder now',
  '/clients — list clients'
].join('\n');

// --- command handlers --------------------------------------------------------

function cmdTickets(chatId) {
  const rows = db.prepare(`
    SELECT t.id, t.ticket_number, t.subject, t.status, t.priority, c.name AS client
    FROM tickets t LEFT JOIN clients c ON c.id = t.client_id
    WHERE t.status != 'closed'
    ORDER BY CASE t.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, t.updated_at DESC
    LIMIT 15
  `).all();
  if (!rows.length) return send(chatId, 'No open tickets. 🎉');
  const lines = rows.map((t) =>
    `<b>${formatTicketRef(t)}</b> [${t.priority}/${t.status}] ${esc(t.subject)}${t.client ? ` — <i>${esc(t.client)}</i>` : ''}`
  );
  return send(chatId, lines.join('\n'));
}

function cmdTicket(chatId, args) {
  // /ticket Oasis | RDS keeps dropping sessions
  const [clientPart, ...subjectParts] = args.split('|');
  const subject = subjectParts.join('|').trim();
  if (!subject) {
    return send(chatId, 'Format: <code>/ticket client name | subject</code>\nExample: <code>/ticket Oasis | Printer offline at front desk</code>');
  }
  const { match, candidates } = findClient(clientPart);
  if (!match) {
    if (candidates.length) {
      return send(chatId, 'Which client?\n' + candidates.map((c) => `• ${esc(c.name)}`).join('\n') + '\n\nRe-run with a more specific name.');
    }
    return send(chatId, `No client matching “${esc(clientPart.trim())}”. Use /clients to see the list, or create the ticket unassigned with:\n<code>/ticket - | ${esc(subject)}</code>`);
  }
  const clientId = clientPart.trim() === '-' ? null : match.id;
  const ticketNo = allocateTicketNumber();
  const info = db.prepare(
    "INSERT INTO tickets (ticket_number, client_id, subject, priority, source, status) VALUES (?, ?, ?, 'normal', 'manual', 'open')"
  ).run(ticketNo, clientId, subject);
  logTicketEvent(info.lastInsertRowid, 'created', 'Created via Telegram');
  return send(chatId, `✅ <b>${formatTicketRef(ticketNo)}</b> created for <i>${esc(match.name)}</i>\n${esc(subject)}`);
}

function cmdUnassignedTicket(chatId, subject) {
  const ticketNo = allocateTicketNumber();
  const info = db.prepare(
    "INSERT INTO tickets (ticket_number, client_id, subject, priority, source, status) VALUES (?, NULL, ?, 'normal', 'manual', 'open')"
  ).run(ticketNo, subject);
  logTicketEvent(info.lastInsertRowid, 'created', 'Created via Telegram (unassigned)');
  return send(chatId, `✅ <b>${formatTicketRef(ticketNo)}</b> created (unassigned)\n${esc(subject)}`);
}

function cmdTime(chatId, args) {
  // /time 14 45 FSLogix cleanup
  const m = args.match(/^(\d+)\s+(\d+)\s*(.*)$/s);
  if (!m) return send(chatId, 'Format: <code>/time ticketId minutes [description]</code>\nExample: <code>/time 14 45 FSLogix cleanup</code>');
  const [, id, minutes, desc] = m;
  const ticket = findTicketByNumberOrId(id);
  if (!ticket) return send(chatId, `No ticket TKT-${String(id).padStart(5, '0')}.`);
  if (!ticket.client_id) return send(chatId, `${formatTicketRef(ticket)} has no client — assign it in the web UI first, then log time.`);
  db.prepare(
    'INSERT INTO time_entries (ticket_id, client_id, minutes, description, billable) VALUES (?, ?, ?, ?, 1)'
  ).run(ticket.id, ticket.client_id, Number(minutes), desc.trim() || null);
  db.prepare("UPDATE tickets SET updated_at = datetime('now') WHERE id = ?").run(ticket.id);
  return send(chatId, `⏱ ${minutes} min on <b>${formatTicketRef(ticket)}</b>${desc.trim() ? ` — ${esc(desc.trim())}` : ''} (billable)`);
}

function cmdNote(chatId, args) {
  const m = args.match(/^(\d+)\s+(.+)$/s);
  if (!m) return send(chatId, 'Format: <code>/note ticketId text</code>');
  const [, id, text] = m;
  const ticket = findTicketByNumberOrId(id);
  if (!ticket) return send(chatId, `No ticket TKT-${String(id).padStart(5, '0')}.`);
  db.prepare("INSERT INTO ticket_messages (ticket_id, direction, author, body) VALUES (?, 'note', 'telegram', ?)").run(ticket.id, text.trim());
  db.prepare("UPDATE tickets SET updated_at = datetime('now') WHERE id = ?").run(ticket.id);
  return send(chatId, `📝 Note added to <b>${formatTicketRef(ticket)}</b>.`);
}

function cmdClose(chatId, args) {
  const id = Number(args.trim());
  if (!id) return send(chatId, 'Format: <code>/close ticketId</code>');
  const ticket = findTicketByNumberOrId(id);
  if (!ticket) return send(chatId, `No ticket TKT-${String(id).padStart(5, '0')}.`);
  if (!isBillingResolved(ticket)) {
    return send(chatId, `⚠️ <b>${formatTicketRef(ticket)}</b> needs billing first — log time with <code>/time</code> or mark not billable in the web UI.`);
  }
  db.prepare("UPDATE tickets SET status = 'closed', updated_at = datetime('now') WHERE id = ?").run(ticket.id);
  logTicketEvent(ticket.id, 'closed', 'Closed via Telegram');
  return send(chatId, `✅ <b>${formatTicketRef(ticket)}</b> closed.`);
}

function cmdStatus(chatId, args) {
  const m = args.match(/^(\d+)\s+(\S+)$/);
  if (!m) return send(chatId, 'Format: <code>/status ticketId open|in_progress|waiting|closed</code>');
  const [, id, status] = m;
  const valid = ['open', 'in_progress', 'waiting', 'closed'];
  if (!valid.includes(status)) return send(chatId, `Status must be one of: ${valid.join(', ')}`);
  const ticket = findTicketByNumberOrId(id);
  if (!ticket) return send(chatId, `No ticket TKT-${String(id).padStart(5, '0')}.`);
  if (status === 'closed' && !isBillingResolved(ticket)) {
    return send(chatId, `⚠️ <b>${formatTicketRef(ticket)}</b> needs billing first — log time with <code>/time</code> or mark not billable in the web UI.`);
  }
  db.prepare("UPDATE tickets SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, ticket.id);
  logTicketEvent(ticket.id, 'changed', `Status: ${ticket.status} → ${status}`);
  if (status === 'closed') logTicketEvent(ticket.id, 'closed', 'Closed via Telegram');
  return send(chatId, `✅ <b>${formatTicketRef(ticket)}</b> status → <b>${esc(status)}</b>`);
}

function cmdPriority(chatId, args) {
  const m = args.match(/^(\d+)\s+(\S+)$/);
  if (!m) return send(chatId, 'Format: <code>/priority ticketId low|normal|high|critical</code>');
  const [, id, priority] = m;
  const valid = ['low', 'normal', 'high', 'critical'];
  if (!valid.includes(priority)) return send(chatId, `Priority must be one of: ${valid.join(', ')}`);
  const ticket = findTicketByNumberOrId(id);
  if (!ticket) return send(chatId, `No ticket TKT-${String(id).padStart(5, '0')}.`);
  db.prepare("UPDATE tickets SET priority = ?, updated_at = datetime('now') WHERE id = ?").run(priority, ticket.id);
  logTicketEvent(ticket.id, 'changed', `Priority: ${ticket.priority} → ${priority}`);
  return send(chatId, `✅ <b>${formatTicketRef(ticket)}</b> priority → <b>${esc(priority)}</b>`);
}

function parseAmount(raw) {
  const n = Number(String(raw).trim().replace(/[$,\s]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function cmdCharge(chatId, args) {
  const parts = args.split('|').map((p) => p.trim());
  if (parts.length < 3) {
    return send(chatId, 'Format: <code>/charge client | amount | description</code>\nExample: <code>/charge Oasis | 450 | HP laptop supply and setup</code>');
  }
  const [clientPart, amountRaw, ...descParts] = parts;
  const description = descParts.join('|').trim();
  const amount = parseAmount(amountRaw);
  if (!description) return send(chatId, 'Description is required.');
  if (amount == null) return send(chatId, 'Amount must be a positive number, e.g. <code>450</code> or <code>$450.00</code>.');

  const { match, candidates } = findClient(clientPart);
  if (!match) {
    if (candidates.length) {
      return send(chatId, 'Which client?\n' + candidates.map((c) => `• ${esc(c.name)}`).join('\n') + '\n\nRe-run with a more specific name.');
    }
    return send(chatId, `No client matching “${esc(clientPart)}”. Use /clients to see the list.`);
  }

  const info = db.prepare(
    'INSERT INTO manual_charges (client_id, description, quantity, unit_amount) VALUES (?, ?, 1, ?)'
  ).run(match.id, description, amount);
  return send(chatId, `💰 Manual charge <b>#${info.lastInsertRowid}</b> for <i>${esc(match.name)}</i>\n${esc(description)} — ${money(amount)}\n\nShows on the next <code>/bill</code> until pushed.`);
}

function cmdCharges(chatId) {
  const rows = db.prepare(`
    SELECT m.id, m.description, m.quantity, m.unit_amount, c.name AS client
    FROM manual_charges m JOIN clients c ON c.id = m.client_id
    WHERE m.invoiced_at IS NULL
    ORDER BY m.created_at DESC
    LIMIT 20
  `).all();
  if (!rows.length) return send(chatId, 'No unbilled manual charges.');
  const lines = rows.map((r) =>
    `<b>#${r.id}</b> <i>${esc(r.client)}</i> — ${esc(r.description)}\n    ${r.quantity} × ${money(r.unit_amount)} = ${money(r.quantity * r.unit_amount)}`
  );
  return send(chatId, '<b>Unbilled manual charges</b>\n\n' + lines.join('\n'));
}

function cmdUncharge(chatId, args) {
  const id = Number(args.trim());
  if (!id) return send(chatId, 'Format: <code>/uncharge id</code>');
  const row = db.prepare('SELECT id FROM manual_charges WHERE id = ? AND invoiced_at IS NULL').get(id);
  if (!row) return send(chatId, `No unbilled charge #${id}.`);
  db.prepare('DELETE FROM manual_charges WHERE id = ?').run(id);
  return send(chatId, `🗑 Charge <b>#${id}</b> removed.`);
}

function cmdClients(chatId) {
  const rows = db.prepare('SELECT name, agreement_name, monthly_fee FROM clients WHERE active = 1 ORDER BY name').all();
  if (!rows.length) return send(chatId, 'No clients yet.');
  return send(chatId, rows.map((c) =>
    `• <b>${esc(c.name)}</b>${c.agreement_name ? ` — ${esc(c.agreement_name)} ${money(c.monthly_fee)}/mo` : ''}`
  ).join('\n'));
}

function applyTimeEntry(client, minutes, description) {
  const info = db.prepare(
    'INSERT INTO time_entries (ticket_id, client_id, minutes, description, billable) VALUES (NULL, ?, ?, ?, 1)'
  ).run(client.id, minutes, description);
  const billed = billableMinutes(minutes);
  return { id: info.lastInsertRowid, billed };
}

function applyManualCharge(client, amount, description) {
  const info = db.prepare(
    'INSERT INTO manual_charges (client_id, description, quantity, unit_amount) VALUES (?, ?, 1, ?)'
  ).run(client.id, description, amount);
  return info.lastInsertRowid;
}

// Conversational assistant: per-chat text history (user/assistant turns only),
// capped so context stays small. /new clears it.
const chatHistories = new Map();

async function handleAssistantText(chatId, text) {
  const history = chatHistories.get(chatId) || [];
  history.push({ role: 'user', content: text });
  await tg('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
  try {
    const { reply } = await runAssistant(history.slice(-20));
    history.push({ role: 'assistant', content: reply });
    chatHistories.set(chatId, history.slice(-20));
    return await sendPlain(chatId, reply);
  } catch (err) {
    history.pop(); // don't poison history with the failed turn
    console.error('[telegram] assistant error:', err.message);
    return sendPlain(chatId, `Assistant error: ${err.message}\n\nFalling back to /help commands.`);
  }
}

async function handlePlainText(chatId, text) {
  if (assistantConfigured()) return handleAssistantText(chatId, text);
  const intent = parsePlainText(text);
  if (!intent) {
    return sendPlain(chatId,
      "I didn't understand that.\n\nTry:\n" +
      'charge Apollo 7 hours for the following work:\n<long description>\n\n' +
      'Invoice Apollo IT for Server setup with a total of 5 hours\n' +
      'Charge Oasis $450 for laptop supply and setup\n\n' +
      'Or /help for commands.'
    );
  }

  const { match, candidates } = findClient(intent.clientPart);
  if (!match) {
    if (candidates.length) {
      return sendPlain(chatId,
        'Which client?\n' + candidates.map((c) => `• ${c.name}`).join('\n') +
        '\n\nRephrase with the full client name.'
      );
    }
    return sendPlain(chatId, `No client matching "${intent.clientPart}". Use /clients to see the list.`);
  }

  if (intent.type === 'time') {
    const { id, billed } = applyTimeEntry(match, intent.minutes, intent.description);
    const rate = match.hourly_rate ?? getNumberSetting('default_hourly_rate', 150);
    const est = (billed / 60) * rate;
    return sendPlain(chatId,
      `Logged billable time #${id} for ${match.name}\n` +
      `${intent.description}\n` +
      `${intent.minutes} min logged → ${billed} min on invoice (~${money(est)} ex GST)\n\n` +
      'Shows on /bill until pushed to Xero.'
    );
  }

  if (intent.type === 'charge') {
    const chargeId = applyManualCharge(match, intent.amount, intent.description);
    return sendPlain(chatId,
      `Manual invoice line #${chargeId} for ${match.name}\n` +
      `${intent.description}\n` +
      `${money(intent.amount)} ex GST\n\n` +
      'Shows on /bill until pushed to Xero.'
    );
  }
}

// --- follow-up nudges ---------------------------------------------------------
// Two nudges per follow-up: 'pre' 15 minutes before the set time, 'due' at the time
// itself (or first check afterwards, e.g. after a server restart). follow_up_nudge
// tracks what has been sent; editing the follow-up resets it.
function preNudgeMs() {
  return Math.max(1, getNumberSetting('follow_up_pre_nudge_minutes', 15)) * 60 * 1000;
}

export function pendingFollowUpNudges(nowMs = Date.now()) {
  const rows = db.prepare(`
    SELECT t.*, c.name AS client FROM tickets t
    LEFT JOIN clients c ON c.id = t.client_id
    WHERE t.status != 'closed' AND t.follow_up_at IS NOT NULL
      AND COALESCE(t.follow_up_nudge, '') != 'due'
  `).all();
  const out = [];
  for (const t of rows) {
    const due = parseDbDate(t.follow_up_at);
    if (!due) continue;
    const dueMs = due.getTime();
    if (nowMs >= dueMs) {
      out.push({ ticket: t, kind: 'due', dueMs });
    } else if (nowMs >= dueMs - preNudgeMs() && !t.follow_up_nudge) {
      out.push({ ticket: t, kind: 'pre', dueMs });
    }
  }
  return out;
}

export async function sendFollowUpNudges() {
  if (!telegramConfigured() && !teamsConfigured()) return;
  const mark = db.prepare('UPDATE tickets SET follow_up_nudge = ? WHERE id = ?');
  for (const { ticket, kind, dueMs } of pendingFollowUpNudges()) {
    const at = fmtDateTimeShort(ticket.follow_up_at);
    const lateMin = Math.round((Date.now() - dueMs) / 60000);
    const head = kind === 'pre'
      ? `⏰ Follow-up in 15 min (${at})`
      : lateMin > 60
        ? `🔔 Follow-up overdue (was ${at})`
        : `🔔 Follow-up due now (${at})`;
    const plainBody = `${formatTicketRef(ticket)} ${ticket.subject}${ticket.client ? ` — ${ticket.client}` : ''}`;
    let delivered = false;
    if (telegramConfigured()) {
      try {
        await send(process.env.TELEGRAM_ALLOWED_CHAT_ID,
          `${head}\n<b>${formatTicketRef(ticket)}</b> ${esc(ticket.subject)}${ticket.client ? ` — ${esc(ticket.client)}` : ''}`);
        delivered = true;
      } catch (err) {
        console.error('[telegram] follow-up nudge failed:', err.message);
      }
    }
    if (teamsConfigured()) {
      try {
        await sendTeamsMessage(plainBody, head);
        delivered = true;
      } catch (err) {
        console.error('[teams] follow-up nudge failed:', err.message);
      }
    }
    if (delivered) mark.run(kind, ticket.id);
  }
}

export function buildDailyDigest() {
  const period = currentPeriod();
  const openTicketCount = db.prepare(`
    SELECT COUNT(*) AS n FROM tickets WHERE status != 'closed'
  `).get().n;
  const openTicketRows = db.prepare(`
    SELECT t.id, t.ticket_number, t.subject, t.status, t.priority, c.name AS client
    FROM tickets t LEFT JOIN clients c ON c.id = t.client_id
    WHERE t.status != 'closed'
    ORDER BY CASE t.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, t.updated_at DESC
    LIMIT 10
  `).all();
  const unbilledTime = db.prepare(`
    SELECT te.minutes, c.name AS client
    FROM time_entries te JOIN clients c ON c.id = te.client_id
    WHERE te.billable = 1 AND te.invoiced_at IS NULL
  `).all();
  const manualCharges = db.prepare(`
    SELECT m.description, m.unit_amount, c.name AS client
    FROM manual_charges m JOIN clients c ON c.id = m.client_id
    WHERE m.invoiced_at IS NULL
  `).all();
  const billedMins = unbilledTime.reduce((s, r) => s + billableMinutes(r.minutes), 0);
  const manualTotal = manualCharges.reduce((s, r) => s + r.unit_amount, 0);
  const run = buildRun(period);
  const pending = run.items.filter((i) => !i.alreadyInvoiced);
  const pendingTotal = pending.reduce((s, i) => s + i.total, 0);

  const followUps = db.prepare(`
    SELECT t.ticket_number, t.id, t.subject, t.follow_up_at, c.name AS client
    FROM tickets t LEFT JOIN clients c ON c.id = t.client_id
    WHERE t.status != 'closed' AND t.follow_up_at IS NOT NULL
      AND datetime(t.follow_up_at) <= datetime('now', '+1 day')
    ORDER BY t.follow_up_at
  `).all();

  const lines = [`Solo PSA — daily check-in (${period})`, ''];
  if (followUps.length) {
    lines.push('Follow-ups due:');
    for (const t of followUps) {
      lines.push(`  • ${formatTicketRef(t)} ${t.subject}${t.client ? ` — ${t.client}` : ''} (${fmtDateTimeShort(t.follow_up_at)})`);
    }
    lines.push('');
  }
  lines.push(`${openTicketCount} open ticket(s)`);
  if (openTicketRows.length) {
    for (const t of openTicketRows) {
      lines.push(`  • ${formatTicketRef(t)} [${t.priority}/${t.status}] ${t.subject}${t.client ? ` — ${t.client}` : ''}`);
    }
    if (openTicketCount > openTicketRows.length) lines.push('  …and more on /tickets');
  }
  if (unbilledTime.length) {
    lines.push(`${unbilledTime.length} unbilled time entry/entries (${(billedMins / 60).toFixed(1)}h billable)`);
  }
  if (manualCharges.length) {
    lines.push(`${manualCharges.length} manual line(s) (${money(manualTotal)})`);
  }
  if (pending.length) {
    lines.push(`${pending.length} client(s) ready to bill this month — ${money(pendingTotal)} total`);
    for (const item of pending.slice(0, 8)) {
      lines.push(`  • ${item.client.name} — ${money(item.total)}`);
    }
    if (pending.length > 8) lines.push(`  …and ${pending.length - 8} more`);
  } else if (!unbilledTime.length && !manualCharges.length) {
    lines.push('Nothing waiting to bill right now.');
  }

  lines.push('');
  lines.push('Plain text examples:');
  lines.push('Invoice Client for work done with a total of 2 hours');
  lines.push('Charge Client $500 for project work');
  lines.push('');
  lines.push('/bill to preview · /push to create Xero drafts');
  return lines.join('\n');
}

export async function sendDailyDigest() {
  if (!telegramConfigured() && !teamsConfigured()) return;
  const hour = getNumberSetting('telegram_digest_hour', 8);
  const last = getSetting('tg_last_digest_date');
  const today = todayIsoInTz();
  const nowHour = hourNowInTz();
  if (last === today) return;
  if (nowHour < hour) return;
  const digest = buildDailyDigest();
  let delivered = false;
  if (telegramConfigured()) {
    try {
      await sendPlain(process.env.TELEGRAM_ALLOWED_CHAT_ID, digest);
      delivered = true;
      console.log('[telegram] daily digest sent');
    } catch (err) {
      console.error('[telegram] digest failed:', err.message);
    }
  }
  if (teamsConfigured()) {
    try {
      await sendTeamsMessage(digest, 'Solo PSA — daily check-in');
      delivered = true;
      console.log('[teams] daily digest sent');
    } catch (err) {
      console.error('[teams] digest failed:', err.message);
    }
  }
  if (delivered) setSetting('tg_last_digest_date', today);
}

async function cmdDigest(chatId) {
  await sendPlain(chatId, buildDailyDigest());
}

function runSummary(period) {
  const run = buildRun(period);
  const pending = run.items.filter((i) => !i.alreadyInvoiced);
  const lines = [`<b>Billing run — ${esc(run.label)}</b>`];
  for (const item of run.items) {
    const kinds = item.lines.reduce((acc, l) => ((acc[l.kind] = (acc[l.kind] || 0) + l.quantity * l.unitAmount), acc), {});
    const detail = Object.entries(kinds).map(([k, v]) => `${k} ${money(v)}`).join(' · ');
    lines.push(`${item.alreadyInvoiced ? '✅' : '▫️'} <b>${esc(item.client.name)}</b> — ${money(item.total)}\n    <i>${detail}</i>`);
  }
  if (!run.items.length) lines.push('Nothing to bill.');
  const total = pending.reduce((s, i) => s + i.total, 0);
  lines.push('', `Ready to push: <b>${money(total)}</b> across ${pending.length} client(s)`);
  return { run, pending, text: lines.join('\n') };
}

function cmdBill(chatId, args) {
  const period = /^\d{4}-\d{2}$/.test(args.trim()) ? args.trim() : currentPeriod();
  const { text } = runSummary(period);
  return send(chatId, text + `\n\nPush with <code>/push ${period}</code>`);
}

function cmdPush(chatId, args) {
  const period = /^\d{4}-\d{2}$/.test(args.trim()) ? args.trim() : currentPeriod();
  if (!xeroConnected()) return send(chatId, 'Xero isn’t connected — do that from the web UI Settings first.');
  const { pending, text } = runSummary(period);
  if (!pending.length) return send(chatId, `Nothing pending for ${period}.`);
  // Stash the pending client ids for the confirm callback.
  setSetting('tg_pending_push', JSON.stringify({ period, clientIds: pending.map((i) => i.client.id), ts: Date.now() }));
  return send(chatId, text + '\n\n<b>Create Xero draft invoices for these clients?</b>', {
    reply_markup: {
      inline_keyboard: [[
        { text: `✅ Push ${pending.length} draft(s)`, callback_data: 'push_confirm' },
        { text: '✖️ Cancel', callback_data: 'push_cancel' }
      ]]
    }
  });
}

async function handleCallback(cb) {
  const chatId = cb.message.chat.id;
  await tg('answerCallbackQuery', { callback_query_id: cb.id }).catch(() => {});
  if (String(chatId) !== String(process.env.TELEGRAM_ALLOWED_CHAT_ID)) return;

  if (cb.data === 'push_cancel') {
    setSetting('tg_pending_push', '');
    return send(chatId, 'Cancelled — nothing pushed.');
  }
  if (cb.data === 'push_confirm') {
    const raw = getSetting('tg_pending_push');
    if (!raw) return send(chatId, 'Nothing pending. Run /push again.');
    const { period, clientIds, ts } = JSON.parse(raw);
    setSetting('tg_pending_push', '');
    if (Date.now() - ts > 10 * 60 * 1000) return send(chatId, 'That preview is stale (>10 min). Run /push again.');
    await send(chatId, `Pushing ${clientIds.length} draft(s) to Xero…`);
    const results = await pushRun(period, clientIds);
    const lines = results.map((r) =>
      r.ok ? `✅ ${esc(r.client)} — ${esc(r.number || 'draft')} ${money(r.total)}` : `❌ ${esc(r.client)} — ${esc(r.error)}`
    );
    return send(chatId, `<b>Push results — ${period}</b>\n` + lines.join('\n') + '\n\nDrafts are in Xero awaiting your approval.');
  }
}

async function handleMessage(msg) {
  const chatId = msg.chat.id;
  if (String(chatId) !== String(process.env.TELEGRAM_ALLOWED_CHAT_ID)) return; // silence for strangers
  const text = (msg.text || '').trim();
  if (!text) return;

  const [cmdRaw, ...rest] = text.split(/\s+/);
  const cmd = cmdRaw.toLowerCase().replace(/@.+$/, '');
  const args = text.slice(cmdRaw.length).trim();

  try {
    if (cmd === '/start' || cmd === '/help') return await send(chatId, HELP);
    if (cmd === '/tickets') return await cmdTickets(chatId);
    if (cmd === '/ticket') {
      if (args.startsWith('-') && args.includes('|')) return await cmdUnassignedTicket(chatId, args.split('|').slice(1).join('|').trim());
      return await cmdTicket(chatId, args);
    }
    if (cmd === '/time') return await cmdTime(chatId, args);
    if (cmd === '/note') return await cmdNote(chatId, args);
    if (cmd === '/close') return await cmdClose(chatId, args);
    if (cmd === '/status') return await cmdStatus(chatId, args);
    if (cmd === '/priority') return await cmdPriority(chatId, args);
    if (cmd === '/clients') return await cmdClients(chatId);
    if (cmd === '/charge') return await cmdCharge(chatId, args);
    if (cmd === '/charges') return await cmdCharges(chatId);
    if (cmd === '/uncharge') return await cmdUncharge(chatId, args);
    if (cmd === '/bill') return await cmdBill(chatId, args);
    if (cmd === '/push') return await cmdPush(chatId, args);
    if (cmd === '/digest') return await cmdDigest(chatId);
    if (cmd === '/new') {
      chatHistories.delete(chatId);
      return await sendPlain(chatId, 'Fresh conversation started.');
    }
    if (text.startsWith('/')) return await send(chatId, 'Unknown command — /help for the list.');
    return await handlePlainText(chatId, text);
  } catch (err) {
    console.error('[telegram] handler error:', err.message);
    await send(chatId, `⚠️ ${esc(err.message)}`).catch(() => {});
  }
}

// --- long-polling loop --------------------------------------------------------
let running = false;

export function startTelegram() {
  if (!telegramConfigured() || running) return;
  running = true;
  console.log('[telegram] bot polling started');
  (async () => {
    let offset = Number(getSetting('tg_offset', '0')) || 0;
    while (running) {
      try {
        const updates = await tg('getUpdates', { offset, timeout: 50, allowed_updates: ['message', 'callback_query'] });
        for (const u of updates) {
          offset = u.update_id + 1;
          setSetting('tg_offset', String(offset));
          if (u.message) await handleMessage(u.message);
          if (u.callback_query) await handleCallback(u.callback_query);
        }
      } catch (err) {
        console.error('[telegram] poll error:', err.message);
        await new Promise((r) => setTimeout(r, 10000)); // back off, then resume
      }
    }
  })();
}
