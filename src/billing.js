// Billing engine: assemble a monthly run per client from
//   1) flat agreement fee, 2) Pax8 subscription lines at sell price,
//   3) unbilled billable time, 4) manual charges, 5) Pax8 prorata — then push each as a Xero draft invoice.
import { db, getSetting, getNumberSetting } from './db.js';
import { sellPrice, subTermMonths } from './integrations/pax8.js';
export { subTermMonths };
import { createDraftInvoice } from './integrations/xero.js';
import { formatTicketRef } from './ticket-utils.js';
import { fmtDate, parseDbDate } from './dates.js';

function monthLabel(period) {
  const [y, m] = period.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleString('en-AU', { month: 'long', year: 'numeric' });
}

const BILLING_INCREMENT_MINUTES = 15;

// Round logged time up to the nearest billing block (15 minutes).
export function billableMinutes(logged) {
  const mins = Number(logged);
  if (!mins || mins <= 0) return 0;
  return Math.ceil(mins / BILLING_INCREMENT_MINUTES) * BILLING_INCREMENT_MINUTES;
}

function dateMonth(d) {
  const m = d ? Number(String(d).slice(5, 7)) : null;
  return m >= 1 && m <= 12 ? m : null;
}

// Descriptive cadence for a subscription. months: 1 monthly, 12/24/36 per-term,
// 0 never recurs. nextRenewal: the upcoming renewal date — term end date, or
// start + term when Pax8 omits it, rolled forward to the future by whole terms.
// Multi-month terms are BILLED from Pax8's draft-invoice renewal items, not predicted;
// nextRenewal says when to expect that to happen.
export function subBillingInfo(sub) {
  const months = subTermMonths(sub.billing_term);
  const anchor = dateMonth(sub.end_date) ?? dateMonth(sub.billing_start || sub.start_date);
  let nextRenewal = null;
  if (months > 1) {
    let d = parseDbDate(sub.end_date);
    if (!d) {
      const start = parseDbDate(sub.billing_start || sub.start_date);
      if (start) {
        d = new Date(start);
        d.setMonth(d.getMonth() + months);
      }
    }
    if (d) {
      const now = new Date();
      while (d < now) d.setMonth(d.getMonth() + months);
      nextRenewal = fmtDate(d);
    }
  }
  return { months, anchor, nextRenewal, renewsOn: sub.end_date ? fmtDate(sub.end_date) : null };
}

// Pro-rata quote for the remainder of an annual/multi-year term, from `asOf` to the
// subscription's end date. Used when billing is picked up mid-term (co-termed NCE,
// onboarding, missed renewal). Returns null when there's nothing to prorate.
export function subProrataQuote(sub, unitSell, asOf = new Date()) {
  const info = subBillingInfo(sub);
  if (!info.months || info.months <= 1 || !sub.end_date) return null;
  const end = new Date(String(sub.end_date).slice(0, 10));
  if (Number.isNaN(end.getTime())) return null;
  const daysLeft = Math.ceil((end - asOf) / 86400000);
  if (daysLeft <= 0) return null;
  const termDays = Math.round(info.months * 30.44); // ≈365 for annual, 730 for 2-year
  const fraction = Math.min(1, daysLeft / termDays);
  return {
    daysLeft,
    termDays,
    fraction,
    amount: Math.round((sub.quantity ?? 1) * (unitSell || 0) * fraction * 100) / 100
  };
}

function labourLineDescription(entry) {
  const logged = entry.minutes;
  const billed = billableMinutes(logged);
  const date = fmtDate(entry.worked_at);
  const detail = (entry.description || 'support').trim();
  const header = entry.ticket_id
    ? `[${formatTicketRef(entry)}] ${entry.ticket_subject || 'Ticket'}`
    : 'Labour';
  const timeLine = billed !== logged
    ? `${billed} min billed (${logged} min logged)`
    : `${billed} min`;
  return [header, detail, `${date} · ${timeLine}`].join('\n');
}

// Monthly-recurring revenue per active client: agreement fee + Pax8 subs + recurring
// services, all at monthly-equivalent sell price (annual ÷ 12, respecting overrides).
export function mrrByClient() {
  const clients = db.prepare('SELECT id, monthly_fee, bill_pax8 FROM clients WHERE active = 1').all();
  const map = new Map(clients.map((c) => [c.id, c.monthly_fee || 0]));
  const billPax8 = new Map(clients.map((c) => [c.id, c.bill_pax8]));
  const subs = db.prepare(`
    SELECT s.client_id, s.quantity, s.buy_price, s.billing_term,
      s.billing_start, s.start_date, s.end_date, p.buy_price AS p_buy, p.sell_price AS p_sell
    FROM pax8_subscriptions s LEFT JOIN pax8_products p ON p.id = s.product_id
    WHERE s.client_id IS NOT NULL AND s.status = 'Active' AND s.quantity > 0
  `).all();
  for (const s of subs) {
    if (!map.has(s.client_id) || !billPax8.get(s.client_id)) continue;
    const { months } = subBillingInfo(s);
    if (!months) continue;
    const unit = sellPrice({ sell_price: s.p_sell, buy_price: s.p_buy ?? s.buy_price });
    map.set(s.client_id, map.get(s.client_id) + (s.quantity * unit) / months);
  }
  for (const s of db.prepare(
    'SELECT client_id, quantity, sell_price, months FROM recurring_services WHERE active = 1'
  ).all()) {
    if (!map.has(s.client_id)) continue;
    map.set(s.client_id, map.get(s.client_id) + (s.quantity * s.sell_price) / (s.months || 1));
  }
  return map;
}

export function outstandingReceivables() {
  return db.prepare(`
    SELECT COALESCE(SUM(amount_due), 0) AS due, COUNT(*) AS n FROM invoices
    WHERE amount_due > 0 AND lower(COALESCE(status, '')) IN ('unpaid', 'authorised', 'submitted')
  `).get();
}

// Build (but don't send) the run for a period: [{ client, lines, total, timeEntryIds }]
export function buildRun(period) {
  const label = monthLabel(period);
  const clients = db.prepare('SELECT * FROM clients WHERE active = 1 ORDER BY name').all();
  const subsFor = db.prepare(`
    SELECT s.*, p.name AS product_name, p.buy_price AS p_buy, p.sell_price AS p_sell
    FROM pax8_subscriptions s LEFT JOIN pax8_products p ON p.id = s.product_id
    WHERE s.client_id = ? AND s.status = 'Active' AND s.quantity > 0
    ORDER BY p.name
  `);
  const timeFor = db.prepare(`
    SELECT te.*, tk.subject AS ticket_subject, tk.ticket_number
    FROM time_entries te
    LEFT JOIN tickets tk ON tk.id = te.ticket_id
    WHERE te.client_id = ? AND te.billable = 1 AND te.invoiced_at IS NULL
    ORDER BY te.worked_at
  `);
  const chargesFor = db.prepare(`
    SELECT * FROM manual_charges
    WHERE client_id = ? AND invoiced_at IS NULL
    ORDER BY created_at
  `);
  const prorataFor = db.prepare(`
    SELECT * FROM pax8_prorata_items
    WHERE client_id = ? AND invoiced_at IS NULL AND billing_period <= ?
    ORDER BY synced_at
  `);
  const servicesFor = db.prepare(
    'SELECT * FROM recurring_services WHERE client_id = ? AND active = 1 ORDER BY name'
  );
  const alreadyInvoiced = db.prepare('SELECT 1 FROM invoices WHERE client_id = ? AND period = ?');

  const labourAcct = getSetting('xero_labour_account', '200');
  const licenceAcct = getSetting('xero_licence_account', '200');
  const agreementAcct = getSetting('xero_agreement_account', '200');
  const defaultRate = getNumberSetting('default_hourly_rate', 150);

  const run = [];
  const attention = [];
  for (const client of clients) {
    const lines = [];
    const timeEntryIds = [];
    const manualChargeIds = [];
    const prorataIds = [];

    if (client.monthly_fee > 0) {
      lines.push({
        lineKey: `a:${client.id}`,
        kind: 'agreement',
        editable: false,
        description: `${client.agreement_name || 'Managed services agreement'} — ${label}`,
        quantity: 1,
        unitAmount: client.monthly_fee,
        accountCode: agreementAcct
      });
    }

    for (const svc of servicesFor.all(client.id)) {
      if (svc.months > 1) {
        if (!svc.bill_month) {
          attention.push({
            clientId: client.id,
            clientName: client.name,
            productName: svc.name,
            billingTerm: `${svc.months === 12 ? 'Annual' : svc.months + '-month'} service`
          });
          continue;
        }
        if (Number(period.slice(5, 7)) !== svc.bill_month) continue;
      }
      if (svc.sell_price <= 0 || svc.quantity <= 0) continue;
      lines.push({
        lineKey: `s:${svc.id}`,
        kind: 'service',
        editable: false,
        description: `${svc.name} — ${label}`
          + (svc.months > 1 ? ` — covers ${svc.months} months` : '')
          + (svc.description ? `\n${svc.description}` : ''),
        quantity: svc.quantity,
        unitAmount: svc.sell_price,
        buyUnit: svc.cost_price || 0,
        accountCode: agreementAcct
      });
    }

    if (client.bill_pax8) {
      for (const s of subsFor.all(client.id)) {
        // Multi-month terms (Annual/2-Year/3-Year) are billed from Pax8's own draft-invoice
        // renewal items when Pax8 raises them — never predicted here. Trials never bill.
        const months = subTermMonths(s.billing_term);
        if (months !== 1) continue;
        const unit = sellPrice({ sell_price: s.p_sell, buy_price: s.p_buy ?? s.buy_price });
        if (unit <= 0) continue;
        lines.push({
          lineKey: `l:${s.id}`,
          kind: 'licence',
          editable: false,
          description: `${s.product_name || s.product_id} — ${label}${s.billing_term ? ` (${s.billing_term})` : ''}`,
          quantity: s.quantity,
          unitAmount: unit,
          buyUnit: s.p_buy ?? s.buy_price ?? 0,
          accountCode: licenceAcct
        });
      }
    }

    for (const t of timeFor.all(client.id)) {
      const rate = t.rate_override ?? client.hourly_rate ?? defaultRate;
      const billed = billableMinutes(t.minutes);
      const hours = billed / 60;
      if (hours <= 0) continue;
      lines.push({
        lineKey: `t:${t.id}`,
        kind: 'labour',
        sourceType: 'time',
        sourceId: t.id,
        editable: true,
        description: labourLineDescription(t),
        editMinutes: t.minutes,
        editDescription: t.description || '',
        editRate: rate,
        billedMinutes: billed,
        quantity: hours,
        unitAmount: rate,
        accountCode: labourAcct
      });
      timeEntryIds.push(t.id);
    }

    for (const c of chargesFor.all(client.id)) {
      const qty = c.quantity ?? 1;
      const unit = c.unit_amount;
      if (qty <= 0 || unit <= 0) continue;
      lines.push({
        lineKey: `m:${c.id}`,
        kind: 'manual',
        sourceType: 'manual',
        sourceId: c.id,
        editable: true,
        description: c.description,
        editAmount: unit,
        quantity: qty,
        unitAmount: unit,
        accountCode: c.account_code || labourAcct
      });
      manualChargeIds.push(c.id);
    }

    if (client.bill_pax8) {
      for (const p of prorataFor.all(client.id, period)) {
        const sell = p.sell_amount ?? p.buy_amount;
        if (sell <= 0) continue;
        lines.push({
          lineKey: `p:${p.id}`,
          kind: p.item_type === 'renewal' ? 'renewal' : 'prorate',
          sourceType: 'prorate',
          sourceId: p.id,
          editable: true,
          description: p.description,
          editAmount: sell,
          editBuy: p.buy_amount,
          quantity: 1,
          unitAmount: sell,
          accountCode: licenceAcct
        });
        prorataIds.push(p.id);
      }
    }

    if (!lines.length) continue;
    const total = lines.reduce((sum, l) => sum + l.quantity * l.unitAmount, 0);
    run.push({
      client,
      lines,
      timeEntryIds,
      manualChargeIds,
      prorataIds,
      total,
      alreadyInvoiced: Boolean(alreadyInvoiced.get(client.id, period))
    });
  }
  return { period, label, items: run, attention };
}

function lineKeysFromBody(body) {
  const raw = [].concat(body.line_keys || []);
  const byClient = new Map();
  for (const entry of raw) {
    const s = String(entry);
    const sep = s.indexOf(':');
    if (sep < 1) continue;
    const id = Number(s.slice(0, sep));
    const lineKey = s.slice(sep + 1);
    if (!id || !lineKey) continue;
    if (!byClient.has(id)) byClient.set(id, new Set());
    byClient.get(id).add(lineKey);
  }
  return byClient;
}

// Push the run to Xero as drafts. Only includes selected line_keys per client.
export async function pushRun(period, clientIds, selectedByClient = null) {
  const { items, label } = buildRun(period);
  const results = [];
  const markTime = db.prepare("UPDATE time_entries SET invoiced_at = datetime('now') WHERE id = ?");
  const markCharge = db.prepare("UPDATE manual_charges SET invoiced_at = datetime('now') WHERE id = ?");
  const markProrata = db.prepare("UPDATE pax8_prorata_items SET invoiced_at = datetime('now') WHERE id = ?");
  const recordInvoice = db.prepare(`
    INSERT INTO invoices (client_id, period, xero_invoice_id, xero_number, total, status, invoice_date)
    VALUES (?, ?, ?, ?, ?, 'draft', ?)
  `);

  for (const item of items) {
    if (!clientIds.includes(item.client.id)) continue;
    if (item.alreadyInvoiced) {
      results.push({ client: item.client.name, ok: false, error: `Already invoiced for ${period}` });
      continue;
    }
    const selected = selectedByClient?.get(item.client.id);
    const lines = selected
      ? item.lines.filter((l) => selected.has(l.lineKey))
      : item.lines;
    if (!lines.length) {
      results.push({ client: item.client.name, ok: false, error: 'No lines selected' });
      continue;
    }
    const total = lines.reduce((sum, l) => sum + l.quantity * l.unitAmount, 0);
    const timeIds = lines.filter((l) => l.sourceType === 'time').map((l) => l.sourceId);
    const chargeIds = lines.filter((l) => l.sourceType === 'manual').map((l) => l.sourceId);
    const prorataLineIds = lines.filter((l) => l.sourceType === 'prorate').map((l) => l.sourceId);
    try {
      const inv = await createDraftInvoice(item.client, lines, {
        reference: `Services — ${label}`
      });
      const tx = db.transaction(() => {
        recordInvoice.run(item.client.id, period, inv.invoiceId, inv.number, inv.total ?? total, inv.date);
        for (const id of timeIds) markTime.run(id);
        for (const id of chargeIds) markCharge.run(id);
        for (const id of prorataLineIds) markProrata.run(id);
      });
      tx();
      results.push({ client: item.client.name, ok: true, number: inv.number, total: inv.total ?? total });
    } catch (err) {
      results.push({ client: item.client.name, ok: false, error: err.message });
    }
  }
  return results;
}

export { lineKeysFromBody };
