import { Router } from 'express';
import { db, getSetting, setSetting } from '../db.js';
import * as xero from '../integrations/xero.js';
import * as pax8 from '../integrations/pax8.js';
import * as graph from '../integrations/graph.js';
import { assistantConfigured } from '../assistant.js';
import { teamsConfigured } from '../integrations/teams.js';
import { teamsBotConfigured } from '../integrations/teams-bot.js';

const r = Router();

const EDITABLE = [
  'default_hourly_rate', 'default_markup_pct',
  'xero_labour_account', 'xero_licence_account', 'xero_agreement_account',
  'xero_tax_type', 'mail_poll_minutes', 'pax8_sync_hours', 'telegram_digest_hour',
  'ticket_auto_close_days', 'assistant_model',
  'app_timezone', 'follow_up_pre_nudge_minutes'
];

r.get('/', (req, res) => {
  const values = Object.fromEntries(EDITABLE.map((k) => [k, getSetting(k, '')]));
  const unset = db.prepare('SELECT id, name, vendor FROM pax8_products WHERE counts_as_user IS NULL').all();
  if (unset.length) {
    const setCount = db.prepare('UPDATE pax8_products SET counts_as_user = ? WHERE id = ?');
    for (const p of unset) {
      setCount.run(pax8.defaultCountsAsUser(p.name, p.vendor), p.id);
    }
  }
  const products = db.prepare(`
    SELECT p.*, COALESCE(SUM(s.quantity), 0) AS seats
    FROM pax8_products p LEFT JOIN pax8_subscriptions s ON s.product_id = p.id AND s.status = 'Active'
    GROUP BY p.id ORDER BY p.name
  `).all();
  res.render('settings', {
    title: 'Settings',
    values, products,
    xero: {
      configured: xero.xeroConfigured(),
      connected: xero.xeroConnected(),
      tenant: getSetting('xero_tenant_name')
    },
    pax8Configured: pax8.pax8Configured(),
    graphConfigured: graph.graphConfigured(),
    assistantOn: assistantConfigured(),
    teamsOn: teamsConfigured(),
    teamsBotOn: teamsBotConfigured(),
    mailbox: process.env.SUPPORT_MAILBOX || '',
    lastSync: getSetting('last_pax8_sync'),
    lastPoll: getSetting('last_mail_poll'),
    markupPct: Number(getSetting('default_markup_pct', '20')),
    jobLog: db.prepare('SELECT * FROM job_log ORDER BY id DESC LIMIT 12').all(),
    pollMinutes: Math.max(1, Number(getSetting('mail_poll_minutes', '2')) || 2)
  });
});

r.post('/', (req, res) => {
  if (req.body.app_timezone != null) {
    const tz = String(req.body.app_timezone).trim();
    try {
      new Intl.DateTimeFormat('en', { timeZone: tz });
    } catch {
      return res.redirect(`/settings?flash=${encodeURIComponent(`Unknown timezone “${tz}” — use an IANA name like Australia/Perth or Europe/London`)}&kind=err`);
    }
  }
  for (const k of EDITABLE) {
    if (req.body[k] != null) setSetting(k, String(req.body[k]).trim());
  }
  res.redirect('/settings?flash=Settings saved — timezone and schedule changes apply to new times immediately; cron schedules apply after a restart');
});

// Per-product sell prices and user-count flags
r.post('/products', (req, res) => {
  const updateSell = db.prepare('UPDATE pax8_products SET sell_price = ? WHERE id = ?');
  const updateUser = db.prepare('UPDATE pax8_products SET counts_as_user = ? WHERE id = ?');
  const allProducts = db.prepare('SELECT id FROM pax8_products').all();
  const tx = db.transaction(() => {
    for (const { id } of allProducts) {
      updateUser.run(req.body[`user_${id}`] ? 1 : 0, id);
    }
    for (const [key, val] of Object.entries(req.body)) {
      if (!key.startsWith('sell_')) continue;
      const id = key.slice(5);
      const price = String(val).trim() === '' ? null : Number(val);
      if (price == null || (!Number.isNaN(price) && price >= 0)) updateSell.run(price, id);
    }
  });
  tx();
  res.redirect('/settings?flash=Product settings saved');
});

export default r;
