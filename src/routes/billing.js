import { Router } from 'express';
import { db } from '../db.js';
import { buildRun, pushRun, lineKeysFromBody, outstandingReceivables } from '../billing.js';
import { syncLocalInvoices, xeroConnected } from '../integrations/xero.js';

const r = Router();

async function loadHistory() {
  const rows = db.prepare(`
    SELECT i.*, c.name AS client_name FROM invoices i
    JOIN clients c ON c.id = i.client_id ORDER BY i.created_at DESC LIMIT 20
  `).all();
  return syncLocalInvoices(rows);
}

function defaultPeriod() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function billingPeriod(req) {
  const p = req.body?.period || req.query?.period || '';
  return /^\d{4}-\d{2}$/.test(p) ? p : defaultPeriod();
}

function billingRedirect(period, flash, kind = 'ok') {
  const q = new URLSearchParams({ period });
  if (flash) {
    q.set('flash', flash);
    if (kind === 'err') q.set('kind', 'err');
  }
  return `/billing?${q}`;
}

function shiftPeriod(period, delta) {
  const [y, m] = period.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// Aggregate the uninvoiced part of the run: totals per line kind, Pax8 margin, labour hours.
function runStats(run) {
  const stats = {
    ready: 0, clients: 0, margin: 0, labourMinutes: 0,
    byKind: { agreement: 0, service: 0, licence: 0, renewal: 0, labour: 0, manual: 0, prorate: 0 }
  };
  for (const item of run.items) {
    if (item.alreadyInvoiced) continue;
    stats.clients++;
    stats.ready += item.total;
    for (const l of item.lines) {
      stats.byKind[l.kind] = (stats.byKind[l.kind] || 0) + l.quantity * l.unitAmount;
      if (l.kind === 'licence' || l.kind === 'service') stats.margin += (l.unitAmount - (l.buyUnit || 0)) * l.quantity;
      if (l.kind === 'prorate' || l.kind === 'renewal') stats.margin += l.unitAmount - (l.editBuy || 0);
      if (l.kind === 'labour') stats.labourMinutes += l.billedMinutes || 0;
    }
  }
  return stats;
}

async function renderBilling(res, period, results = null) {
  const run = buildRun(period);
  const history = await loadHistory();
  const outstanding = outstandingReceivables();
  res.render('billing', {
    title: 'Billing',
    run, period, history, results,
    stats: runStats(run),
    outstanding,
    prevPeriod: shiftPeriod(period, -1),
    nextPeriod: shiftPeriod(period, 1),
    xeroReady: xeroConnected()
  });
}

r.get('/', async (req, res) => {
  await renderBilling(res, billingPeriod(req));
});

r.post('/push', async (req, res) => {
  const period = billingPeriod(req);
  const selectedByClient = lineKeysFromBody(req.body);
  const clientIds = [...selectedByClient.keys()];
  if (!clientIds.length) {
    return res.redirect(billingRedirect(period, 'Select at least one line to invoice', 'err'));
  }
  const results = await pushRun(period, clientIds, selectedByClient);
  await renderBilling(res, period, results);
});

r.post('/time/:id', (req, res) => {
  const period = billingPeriod(req);
  const mins = Number(req.body.minutes);
  const description = String(req.body.description || '').trim();
  const row = db.prepare(
    'SELECT id FROM time_entries WHERE id = ? AND billable = 1 AND invoiced_at IS NULL'
  ).get(req.params.id);
  if (!row) return res.redirect(billingRedirect(period, 'Time entry not found or already invoiced', 'err'));
  if (!mins || mins <= 0) return res.redirect(billingRedirect(period, 'Minutes must be positive', 'err'));
  db.prepare('UPDATE time_entries SET minutes = ?, description = ? WHERE id = ?')
    .run(mins, description || null, req.params.id);
  res.redirect(billingRedirect(period, 'Time entry saved'));
});

r.post('/time/:id/delete', (req, res) => {
  const period = billingPeriod(req);
  db.prepare('DELETE FROM time_entries WHERE id = ? AND invoiced_at IS NULL').run(req.params.id);
  res.redirect(billingRedirect(period, 'Time entry removed'));
});

r.post('/charges/:id', (req, res) => {
  const period = billingPeriod(req);
  const description = String(req.body.description || '').trim();
  const amount = Number(req.body.unit_amount);
  const row = db.prepare(
    'SELECT id FROM manual_charges WHERE id = ? AND invoiced_at IS NULL'
  ).get(req.params.id);
  if (!row) return res.redirect(billingRedirect(period, 'Line not found or already invoiced', 'err'));
  if (!description) return res.redirect(billingRedirect(period, 'Description is required', 'err'));
  if (!amount || amount <= 0) return res.redirect(billingRedirect(period, 'Amount must be positive', 'err'));
  db.prepare('UPDATE manual_charges SET description = ?, unit_amount = ? WHERE id = ?')
    .run(description, amount, req.params.id);
  res.redirect(billingRedirect(period, 'Manual line saved'));
});

r.post('/charges/:id/delete', (req, res) => {
  const period = billingPeriod(req);
  db.prepare('DELETE FROM manual_charges WHERE id = ? AND invoiced_at IS NULL').run(req.params.id);
  res.redirect(billingRedirect(period, 'Manual line removed'));
});

r.post('/prorata/:id', (req, res) => {
  const period = billingPeriod(req);
  const description = String(req.body.description || '').trim();
  const sell = Number(req.body.sell_amount);
  const row = db.prepare(
    'SELECT id FROM pax8_prorata_items WHERE id = ? AND invoiced_at IS NULL'
  ).get(req.params.id);
  if (!row) return res.redirect(billingRedirect(period, 'Prorata line not found or already invoiced', 'err'));
  if (!description) return res.redirect(billingRedirect(period, 'Description is required', 'err'));
  if (!sell || sell <= 0) return res.redirect(billingRedirect(period, 'Sell amount must be positive', 'err'));
  db.prepare('UPDATE pax8_prorata_items SET description = ?, sell_amount = ? WHERE id = ?')
    .run(description, sell, req.params.id);
  res.redirect(billingRedirect(period, 'Prorata line saved'));
});

r.post('/prorata/:id/delete', (req, res) => {
  const period = billingPeriod(req);
  db.prepare('DELETE FROM pax8_prorata_items WHERE id = ? AND invoiced_at IS NULL').run(req.params.id);
  res.redirect(billingRedirect(period, 'Prorata line removed'));
});

export default r;
