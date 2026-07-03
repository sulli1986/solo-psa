import 'dotenv/config';
import express from 'express';
import cron from 'node-cron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import crypto from 'node:crypto';

import { db, getSetting, setSetting, getNumberSetting } from './db.js';
import * as xero from './integrations/xero.js';
import * as pax8 from './integrations/pax8.js';
import * as graph from './integrations/graph.js';
import { startTelegram, sendDailyDigest, sendFollowUpNudges } from './integrations/telegram.js';

import { authEnabled, createSession, clearSessionCookie, requireAuth, safeNextPath, verifyPassword } from './auth.js';
import { billableMinutes, buildRun, mrrByClient, outstandingReceivables } from './billing.js';
import { IS_STALE_SQL, autoCloseStaleTickets, formatTicketRef } from './ticket-utils.js';
import { sanitizeHtml } from './html-utils.js';
import { fmtDate, fmtDateTime, fmtDateTimeShort, fmtDateInput, fmtDateTimeLocalInput, todayIsoInTz, isDateBeforeToday } from './dates.js';

import clientsRouter from './routes/clients.js';
import ticketsRouter from './routes/tickets.js';
import billingRouter from './routes/billing.js';
import settingsRouter from './routes/settings.js';
import assistantRouter from './routes/assistant.js';
import { assistantConfigured } from './assistant.js';
import teamsBotRouter from './integrations/teams-bot.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();

app.disable('x-powered-by'); // don't advertise the framework/version

app.set('view engine', 'ejs');
app.set('views', join(__dirname, '..', 'views'));

// Security headers on every response. The UI relies on inline <script>/<style>,
// so script/style allow 'unsafe-inline'; the rest still blocks framing (clickjacking),
// MIME sniffing, plugin/object embedding, and base-tag hijacking.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: https:",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'"
  ].join('; '));
  next();
});

app.use(express.urlencoded({ extended: true }));
app.use(express.static(join(__dirname, '..', 'public')));

// Shared view locals
app.use((req, res, next) => {
  res.locals.path = req.path;
  res.locals.flash = req.query.flash || null;
  res.locals.flashKind = req.query.kind || 'ok';
  res.locals.authEnabled = authEnabled();
  res.locals.billableMinutes = (mins) => billableMinutes(mins);
  res.locals.money = (n) => 'A$' + Number(n || 0).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  res.locals.ticketRef = (t) => formatTicketRef(t);
  res.locals.sanitizeHtml = (h) => sanitizeHtml(h);
  res.locals.fmtDate = fmtDate;
  res.locals.fmtDateTime = fmtDateTime;
  res.locals.fmtDateTimeShort = fmtDateTimeShort;
  res.locals.fmtDateInput = fmtDateInput;
  res.locals.fmtDateTimeLocalInput = fmtDateTimeLocalInput;
  res.locals.todayIso = todayIsoInTz;
  res.locals.isDateBeforeToday = isDateBeforeToday;
  res.locals.assistantEnabled = assistantConfigured();
  next();
});

app.get('/login', (req, res) => {
  if (!authEnabled()) return res.redirect('/');
  res.render('login', {
    title: 'Sign in',
    next: safeNextPath(req.query.next),
    flash: req.query.flash || null,
    flashKind: req.query.kind || 'ok'
  });
});

app.post('/login', (req, res) => {
  if (!authEnabled()) return res.redirect('/');
  const next = safeNextPath(req.body.next);
  if (!verifyPassword(req.body.password)) {
    return res.redirect(`/login?next=${encodeURIComponent(next)}&flash=${encodeURIComponent('Incorrect password')}&kind=err`);
  }
  createSession(res);
  res.redirect(next);
});

app.post('/logout', (req, res) => {
  clearSessionCookie(res);
  res.redirect('/login');
});

// Teams bot endpoint sits outside session auth — it verifies Bot Framework JWTs itself.
app.use('/teams', teamsBotRouter);

app.use(requireAuth);

// --- Dashboard ---------------------------------------------------------------
app.get('/', (req, res) => {
  const today = todayIsoInTz();
  const openTickets = db.prepare(`
    SELECT t.*, c.name AS client_name FROM tickets t
    LEFT JOIN clients c ON c.id = t.client_id
    WHERE t.status != 'closed'
    ORDER BY
      CASE t.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
      CASE WHEN t.follow_up_at IS NOT NULL AND date(t.follow_up_at) <= date(@today) THEN 0 ELSE 1 END,
      t.updated_at DESC
    LIMIT 12
  `).all({ today });
  const followUpTickets = db.prepare(`
    SELECT t.*, c.name AS client_name FROM tickets t
    LEFT JOIN clients c ON c.id = t.client_id
    WHERE t.status != 'closed'
      AND t.follow_up_at IS NOT NULL
      AND date(t.follow_up_at) <= date(@today)
    ORDER BY t.follow_up_at ASC
    LIMIT 8
  `).all({ today });
  const counts = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM tickets WHERE status = 'open') AS open,
      (SELECT COUNT(*) FROM tickets WHERE status = 'in_progress') AS in_progress,
      (SELECT COUNT(*) FROM tickets WHERE status = 'waiting') AS waiting,
      (SELECT COUNT(*) FROM tickets t WHERE ${IS_STALE_SQL}) AS stale,
      (SELECT COUNT(*) FROM clients WHERE active = 1) AS clients,
      (SELECT COALESCE(SUM(minutes), 0) FROM time_entries WHERE billable = 1 AND invoiced_at IS NULL) AS unbilled_minutes
    FROM (SELECT 1)
  `).get();
  const ticketStats = db.prepare(`
    SELECT
      ROUND(AVG(
        julianday(updated_at) - julianday(created_at)
      ), 1) AS avg_close_days
    FROM tickets WHERE status = 'closed'
  `).get();
  const openByClient = db.prepare(`
    SELECT c.name, COUNT(*) AS n
    FROM tickets t JOIN clients c ON c.id = t.client_id
    WHERE t.status != 'closed'
    GROUP BY c.id ORDER BY n DESC, c.name LIMIT 6
  `).all();
  const defaultRate = getNumberSetting('default_hourly_rate', 150);
  const unbilledRows = db.prepare(
    'SELECT minutes FROM time_entries WHERE billable = 1 AND invoiced_at IS NULL'
  ).all();
  const unbilledBillableMinutes = unbilledRows.reduce((s, r) => s + billableMinutes(r.minutes), 0);
  const period = new Date().toISOString().slice(0, 7);
  const run = buildRun(period);
  const readyToBill = run.items.reduce((s, i) => s + (i.alreadyInvoiced ? 0 : i.total), 0);
  const mrrTotal = [...mrrByClient().values()].reduce((s, v) => s + v, 0);
  res.render('dashboard', {
    title: 'Dashboard',
    openTickets,
    followUpTickets,
    openByClient,
    ticketStats,
    counts,
    period,
    readyToBill,
    billingAttention: run.attention.length,
    mrrTotal,
    outstanding: outstandingReceivables(),
    unbilledValueApprox: (unbilledBillableMinutes / 60) * defaultRate
  });
});

// --- Xero OAuth --------------------------------------------------------------
app.get('/auth/xero', (req, res) => {
  if (!xero.xeroConfigured()) return res.redirect('/settings?flash=Set Xero credentials in .env first&kind=err');
  const state = crypto.randomBytes(16).toString('hex');
  setSetting('xero_oauth_state', state);
  res.redirect(xero.authorizeUrl(state));
});

app.get('/auth/xero/callback', async (req, res) => {
  try {
    if (req.query.state !== getSetting('xero_oauth_state')) throw new Error('OAuth state mismatch');
    const org = await xero.handleCallback(req.query.code);
    res.redirect(`/settings?flash=Connected to Xero (${encodeURIComponent(org.tenantName || 'org')})`);
  } catch (err) {
    res.redirect(`/settings?flash=${encodeURIComponent('Xero connect failed: ' + err.message)}&kind=err`);
  }
});

app.use('/clients', clientsRouter);
app.use('/tickets', ticketsRouter);
app.use('/billing', billingRouter);
app.use('/settings', settingsRouter);
app.use('/assistant', assistantRouter);

// --- Background jobs -----------------------------------------------------------
function logJob(job, ok, detail) {
  db.prepare('INSERT INTO job_log (job, ok, detail) VALUES (?, ?, ?)').run(job, ok ? 1 : 0, detail || null);
  db.prepare('DELETE FROM job_log WHERE id NOT IN (SELECT id FROM job_log ORDER BY id DESC LIMIT 200)').run();
}

async function pollMail() {
  if (!graph.graphConfigured()) {
    return { ok: false, error: 'M365 mail not configured — set MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET and SUPPORT_MAILBOX in .env' };
  }
  try {
    const r = await graph.pollInbox();
    setSetting('last_mail_poll', new Date().toISOString());
    logJob('mail', true, `scanned ${r.scanned} unread · ${r.created} new ticket(s) · ${r.appended} reply(ies) · ${r.attachmentsSaved || 0} attachment(s)`);
    if (r.created || r.appended) console.log(`[mail] ${r.created} new ticket(s), ${r.appended} reply(ies)`);
    return { ok: true, ...r };
  } catch (err) {
    logJob('mail', false, err.message);
    console.error('[mail] poll failed:', err.message);
    return { ok: false, error: err.message };
  }
}

async function syncPax8() {
  if (!pax8.pax8Configured()) return { ok: false, error: 'Pax8 not configured — set PAX8_CLIENT_ID / PAX8_CLIENT_SECRET in .env' };
  try {
    const r = await pax8.syncSubscriptions();
    setSetting('last_pax8_sync', new Date().toISOString());
    logJob('pax8', true, `${r.subscriptions} subscription(s) · ${r.prorata} prorata · ${r.companies} companies`);
    console.log(`[pax8] synced ${r.subscriptions} subscription(s), ${r.prorata} prorata item(s) across ${r.companies} companies`);
    return { ok: true, ...r };
  } catch (err) {
    logJob('pax8', false, err.message);
    console.error('[pax8] sync failed:', err.message);
    return { ok: false, error: err.message };
  }
}

const pollMin = Math.max(1, getNumberSetting('mail_poll_minutes', 2));
cron.schedule(`*/${pollMin} * * * *`, pollMail);
const syncHrs = Math.max(1, getNumberSetting('pax8_sync_hours', 12));
cron.schedule(`15 */${syncHrs} * * *`, syncPax8);
// Timezone for scheduled jobs comes from Settings (fallback APP_TIMEZONE env, then Perth).
// Read at boot — changing it in Settings needs a restart for the crons themselves,
// but the digest-hour check and all displayed times use the new zone immediately.
const cronTz = getSetting('app_timezone') || process.env.APP_TIMEZONE || 'Australia/Perth';
// Daily digest (hour from settings; sent to Telegram and/or Teams)
cron.schedule('0 * * * *', sendDailyDigest, { timezone: cronTz });
// Ticket follow-up nudges: a configurable warning before the set time, and at the time itself
cron.schedule('* * * * *', sendFollowUpNudges);
// Auto-close stale waiting tickets (daily at 3am local)
cron.schedule('0 3 * * *', () => {
  const days = getNumberSetting('ticket_auto_close_days', 0);
  const n = autoCloseStaleTickets(days);
  if (n) console.log(`[tickets] auto-closed ${n} stale waiting ticket(s)`);
}, { timezone: cronTz });

// Manual triggers
app.post('/jobs/poll-mail', async (req, res) => {
  const r = await pollMail();
  if (!r.ok) return res.redirect(`/settings?flash=${encodeURIComponent('Mail poll failed: ' + r.error)}&kind=err`);
  res.redirect(`/settings?flash=${encodeURIComponent(`Mailbox polled — ${r.scanned} unread scanned, ${r.created} ticket(s) created, ${r.appended} reply(ies) appended, ${r.attachmentsSaved || 0} attachment(s) saved`)}`);
});
app.post('/jobs/sync-pax8', async (req, res) => {
  const r = await syncPax8();
  if (!r.ok) return res.redirect(`/settings?flash=${encodeURIComponent('Pax8 sync failed: ' + r.error)}&kind=err`);
  res.redirect(`/settings?flash=${encodeURIComponent(`Pax8 sync: ${r.subscriptions} subscriptions, ${r.prorata} prorata, ${r.companies} companies`)}`);
});

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`Solo PSA running on http://localhost:${PORT}`);
  if (!authEnabled()) console.warn('[auth] APP_PASSWORD is not set — the app is open to anyone who can reach it');
  pollMail();
  startTelegram();
});
server.on('error', (err) => {
  console.error(`[startup] Cannot listen on port ${PORT}:`, err.message);
  process.exit(1);
});
