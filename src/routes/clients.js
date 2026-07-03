import { Router } from 'express';
import { db, getNumberSetting } from '../db.js';
import { sellPrice, listCachedCompanies, unlinkedPax8Companies } from '../integrations/pax8.js';
import { listContacts, getContact, syncLocalInvoices, xeroConnected } from '../integrations/xero.js';
import { buildRun, billableMinutes, subBillingInfo, subProrataQuote, mrrByClient, computeUserBilling, clientLicenseProducts } from '../billing.js';
import { fmtDate, todayIsoInTz } from '../dates.js';

const r = Router();

const CLIENT_TABS = new Set(['overview', 'billing', 'time', 'contacts', 'settings']);

function clientTab(req) {
  const t = String(req.query.tab || 'overview');
  return CLIENT_TABS.has(t) ? t : 'overview';
}

function clientUrl(id, tab, extra = '') {
  const parts = [];
  if (tab && tab !== 'overview') parts.push(`tab=${tab}`);
  if (extra) parts.push(extra);
  return `/clients/${id}${parts.length ? `?${parts.join('&')}` : ''}`;
}

function linkPax8Subscriptions(clientId, pax8CompanyId) {
  if (!pax8CompanyId) return;
  db.prepare('UPDATE pax8_subscriptions SET client_id = ? WHERE pax8_company_id = ?').run(clientId, pax8CompanyId);
  db.prepare('UPDATE pax8_prorata_items SET client_id = ? WHERE pax8_company_id = ? AND invoiced_at IS NULL')
    .run(clientId, pax8CompanyId);
}

function upsertPrimaryContact(clientId, name, email, phone) {
  if (!email && !phone) return;
  const existing = db.prepare('SELECT id FROM contacts WHERE client_id = ? AND is_primary = 1').get(clientId);
  if (existing) {
    db.prepare(`
      UPDATE contacts SET name = ?, email = COALESCE(?, email), phone = COALESCE(?, phone)
      WHERE id = ?
    `).run(name, email || null, phone || null, existing.id);
  } else {
    db.prepare(
      'INSERT INTO contacts (client_id, name, email, phone, is_primary) VALUES (?, ?, ?, ?, 1)'
    ).run(clientId, name, email || null, phone || null);
  }
}

r.get('/', (req, res) => {
  const show = req.query.show === 'archived' ? 'archived' : 'active';
  const q = String(req.query.q || '').trim();
  const sort = String(req.query.sort || 'name');

  const clients = db.prepare(`
    SELECT c.*,
      (SELECT COUNT(*) FROM tickets t WHERE t.client_id = c.id AND t.status != 'closed') AS open_tickets,
      (SELECT COALESCE(SUM(minutes), 0) FROM time_entries te WHERE te.client_id = c.id AND te.billable = 1 AND te.invoiced_at IS NULL) AS unbilled_minutes,
      (SELECT COUNT(*) FROM pax8_subscriptions s WHERE s.client_id = c.id AND s.status = 'Active') AS subs
    FROM clients c WHERE c.active = ? ORDER BY c.name
  `).all(show === 'active' ? 1 : 0);

  const mrrMap = mrrByClient();
  const defaultRate = getNumberSetting('default_hourly_rate', 150);
  for (const c of clients) {
    c.mrr = mrrMap.get(c.id) ?? (c.monthly_fee || 0);
    c.unbilled_value = (c.unbilled_minutes / 60) * (c.hourly_rate ?? defaultRate);
  }

  const totals = {
    clients: clients.length,
    mrr: clients.reduce((s, c) => s + c.mrr, 0),
    unbilledMinutes: clients.reduce((s, c) => s + c.unbilled_minutes, 0),
    unbilledValue: clients.reduce((s, c) => s + c.unbilled_value, 0),
    openTickets: clients.reduce((s, c) => s + c.open_tickets, 0)
  };

  let list = q
    ? clients.filter((c) => `${c.name} ${c.agreement_name || ''}`.toLowerCase().includes(q.toLowerCase()))
    : clients;
  const sorters = {
    name: (a, b) => a.name.localeCompare(b.name),
    mrr: (a, b) => b.mrr - a.mrr,
    unbilled: (a, b) => b.unbilled_minutes - a.unbilled_minutes,
    tickets: (a, b) => b.open_tickets - a.open_tickets
  };
  list = [...list].sort(sorters[sort] || sorters.name);

  res.render('clients', { title: 'Clients', clients: list, totals, q, sort, show });
});

r.get('/import', async (req, res) => {
  const pax8Companies = unlinkedPax8Companies();
  let xeroContacts = [];
  let xeroError = null;
  if (xeroConnected()) {
    try {
      const linked = new Set(
        db.prepare('SELECT xero_contact_id FROM clients WHERE active = 1 AND xero_contact_id IS NOT NULL')
          .all().map((r) => r.xero_contact_id)
      );
      xeroContacts = (await listContacts()).filter((c) => !linked.has(c.id));
    } catch (err) {
      xeroError = err.message;
    }
  }
  res.render('import-clients', {
    title: 'Import clients',
    pax8Companies,
    xeroContacts,
    xeroConnected: xeroConnected(),
    xeroError,
    pax8Configured: Boolean(process.env.PAX8_CLIENT_ID)
  });
});

r.post('/import/pax8', (req, res) => {
  const { pax8_company_id } = req.body;
  const company = db.prepare('SELECT * FROM pax8_companies WHERE id = ?').get(pax8_company_id);
  if (!company) return res.redirect('/clients/import?flash=Pax8 company not found — run a sync first&kind=err');
  const existing = db.prepare('SELECT id FROM clients WHERE pax8_company_id = ? AND active = 1').get(company.id);
  if (existing) return res.redirect(`/clients/${existing.id}?flash=Client already linked to this Pax8 company`);
  const info = db.prepare('INSERT INTO clients (name, pax8_company_id) VALUES (?, ?)').run(company.name, company.id);
  linkPax8Subscriptions(info.lastInsertRowid, company.id);
  res.redirect(`/clients/${info.lastInsertRowid}?flash=Client created from Pax8`);
});

r.post('/import/xero', async (req, res) => {
  const { xero_contact_id } = req.body;
  if (!xero_contact_id) return res.redirect('/clients/import?flash=Select a Xero contact&kind=err');
  const existing = db.prepare('SELECT id FROM clients WHERE xero_contact_id = ? AND active = 1').get(xero_contact_id);
  if (existing) return res.redirect(`/clients/${existing.id}?flash=Client already linked to this Xero contact`);
  try {
    const xc = await getContact(xero_contact_id);
    const info = db.prepare('INSERT INTO clients (name, xero_contact_id) VALUES (?, ?)')
      .run(xc.name, xc.id);
    upsertPrimaryContact(info.lastInsertRowid, xc.name, xc.email, xc.phone);
    res.redirect(`/clients/${info.lastInsertRowid}?flash=Client created from Xero`);
  } catch (err) {
    res.redirect(`/clients/import?flash=${encodeURIComponent('Xero import failed: ' + err.message)}&kind=err`);
  }
});

r.post('/', (req, res) => {
  const { name } = req.body;
  if (!name?.trim()) return res.redirect('/clients?flash=Client name is required&kind=err');
  const info = db.prepare('INSERT INTO clients (name) VALUES (?)').run(name.trim());
  res.redirect(`/clients/${info.lastInsertRowid}`);
});

r.get('/:id', async (req, res) => {
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id);
  if (!client) return res.status(404).send('Client not found');
  const contacts = db.prepare('SELECT * FROM contacts WHERE client_id = ? ORDER BY is_primary DESC, name').all(client.id);
  const tickets = db.prepare("SELECT * FROM tickets WHERE client_id = ? ORDER BY updated_at DESC LIMIT 15").all(client.id);
  const openTickets = db.prepare(
    "SELECT COUNT(*) AS n FROM tickets WHERE client_id = ? AND status != 'closed'"
  ).get(client.id).n;
  const openTicketOptions = db.prepare(
    "SELECT id, subject, ticket_number FROM tickets WHERE client_id = ? AND status != 'closed' ORDER BY updated_at DESC"
  ).all(client.id);
  const subs = db.prepare(`
    SELECT s.*, p.name AS product_name, p.buy_price AS p_buy, p.sell_price AS p_sell
    FROM pax8_subscriptions s LEFT JOIN pax8_products p ON p.id = s.product_id
    WHERE s.client_id = ? ORDER BY p.name
  `).all(client.id).map((s) => {
    const sell = sellPrice({ sell_price: s.p_sell, buy_price: s.p_buy ?? s.buy_price });
    return {
      ...s,
      sell,
      billing: subBillingInfo(s),
      prorata: s.status === 'Active' && s.quantity > 0 ? subProrataQuote(s, sell) : null
    };
  });
  const prorata = db.prepare(`
    SELECT * FROM pax8_prorata_items WHERE client_id = ? AND invoiced_at IS NULL ORDER BY synced_at DESC
  `).all(client.id);

  const defaultRate = getNumberSetting('default_hourly_rate', 150);
  const effectiveRate = client.hourly_rate ?? defaultRate;
  const timeEntries = db.prepare(`
    SELECT te.*, t.subject AS ticket_subject, t.ticket_number
    FROM time_entries te LEFT JOIN tickets t ON t.id = te.ticket_id
    WHERE te.client_id = ? AND te.invoiced_at IS NULL
    ORDER BY te.worked_at DESC
  `).all(client.id);
  const unbilledMinutes = timeEntries.reduce((s, e) => s + (e.billable ? e.minutes : 0), 0);
  const unbilledValue = timeEntries.reduce(
    (s, e) => s + (e.billable ? (billableMinutes(e.minutes) / 60) * (e.rate_override ?? effectiveRate) : 0), 0
  );

  const services = db.prepare('SELECT * FROM recurring_services WHERE client_id = ? ORDER BY name').all(client.id);

  // MRR = agreement (base + per-user) + recurring services + active Pax8 subs
  const userBilling = computeUserBilling(client);
  const mrr = (client.monthly_fee || 0) + userBilling.billable * userBilling.perUserFee
    + services.filter((s) => s.active).reduce((t, s) => t + (s.quantity * s.sell_price) / (s.months || 1), 0)
    + (client.bill_pax8
      ? subs.filter((s) => s.status === 'Active' && s.quantity > 0)
          .reduce((t, s) => t + (s.billing.months ? (s.quantity * s.sell) / s.billing.months : 0), 0)
      : 0);

  const period = new Date().toISOString().slice(0, 7);
  const nextInvoice = client.active
    ? buildRun(period).items.find((i) => i.client.id === client.id) || null
    : null;

  const activity = [
    ...db.prepare(`
      SELECT e.created_at AS at, e.action, e.detail, t.id AS ticket_id, t.subject, t.ticket_number
      FROM ticket_events e JOIN tickets t ON t.id = e.ticket_id
      WHERE t.client_id = ? ORDER BY e.created_at DESC LIMIT 12
    `).all(client.id).map((e) => ({ ...e, type: 'ticket' })),
    ...db.prepare(
      'SELECT created_at AS at, xero_number, period, total FROM invoices WHERE client_id = ? ORDER BY created_at DESC LIMIT 6'
    ).all(client.id).map((i) => ({ ...i, type: 'invoice' })),
    ...db.prepare(
      'SELECT worked_at AS at, minutes, description FROM time_entries WHERE client_id = ? ORDER BY worked_at DESC LIMIT 8'
    ).all(client.id).map((t) => ({ ...t, type: 'time' }))
  ].sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 12);

  const invoices = await syncLocalInvoices(
    db.prepare('SELECT * FROM invoices WHERE client_id = ? ORDER BY invoice_date DESC, created_at DESC LIMIT 12').all(client.id)
  );
  const pax8Companies = listCachedCompanies();
  let xeroContacts = [];
  if (xeroConnected()) {
    try { xeroContacts = await listContacts(); } catch { /* settings will show connect */ }
  }
  const manualCharges = db.prepare(`
    SELECT * FROM manual_charges
    WHERE client_id = ? AND invoiced_at IS NULL
    ORDER BY created_at DESC
  `).all(client.id);
  const licenseProducts = clientLicenseProducts(client.id);
  res.render('client', {
    title: client.name,
    cust: client, contacts, tickets, subs, services, invoices, manualCharges, prorata,
    pax8Companies, xeroContacts,
    timeEntries, unbilledMinutes, unbilledValue, mrr, nextInvoice, activity,
    openTickets, openTicketOptions, period,
    defaultRate,
    tab: clientTab(req),
    userBilling,
    licenseProducts
  });
});

function parseUserCountSource(raw) {
  return raw === 'manual' ? 'manual' : 'pax8';
}

r.post('/:id/license-counts', (req, res) => {
  const client = db.prepare('SELECT id FROM clients WHERE id = ?').get(req.params.id);
  if (!client) return res.status(404).send('Client not found');
  const products = clientLicenseProducts(client.id);
  const upsert = db.prepare(`
    INSERT INTO client_license_count (client_id, product_id, counts_as_user)
    VALUES (?, ?, ?)
    ON CONFLICT(client_id, product_id) DO UPDATE SET counts_as_user = excluded.counts_as_user
  `);
  const tx = db.transaction(() => {
    for (const p of products) {
      upsert.run(client.id, p.productId, req.body[`lic_${p.productId}`] ? 1 : 0);
    }
  });
  tx();
  res.redirect(clientUrl(req.params.id, 'settings', 'flash=License counts saved'));
});

r.post('/:id', async (req, res) => {
  const {
    name, agreement_name, monthly_fee, per_user_fee, excluded_users,
    user_count_source, user_count, hourly_rate, bill_pax8, notes,
    pax8_company_id, xero_contact_id
  } = req.body;
  const source = parseUserCountSource(user_count_source);
  const prev = db.prepare('SELECT xero_contact_id FROM clients WHERE id = ?').get(req.params.id);
  db.prepare(`
    UPDATE clients SET name = ?, agreement_name = ?, monthly_fee = ?, per_user_fee = ?,
      excluded_users = ?, user_count_source = ?, user_count = ?,
      hourly_rate = ?, bill_pax8 = ?, notes = ?, pax8_company_id = ?, xero_contact_id = ?
    WHERE id = ?
  `).run(
    name.trim(),
    agreement_name || null,
    Number(monthly_fee) || 0,
    Number(per_user_fee) || 0,
    Math.max(0, Number(excluded_users) || 0),
    source,
    source === 'manual' && user_count !== '' ? Math.max(0, Number(user_count) || 0) : null,
    hourly_rate ? Number(hourly_rate) : null,
    bill_pax8 ? 1 : 0,
    notes || null,
    pax8_company_id || null,
    xero_contact_id || null,
    req.params.id
  );
  if (pax8_company_id) linkPax8Subscriptions(req.params.id, pax8_company_id);
  if (xero_contact_id && xero_contact_id !== prev?.xero_contact_id) {
    try {
      const xc = await getContact(xero_contact_id);
      upsertPrimaryContact(req.params.id, xc.name, xc.email, xc.phone);
    } catch { /* client saved; contact sync optional */ }
  }
  res.redirect(clientUrl(req.params.id, 'settings', 'flash=Client saved'));
});

r.post('/:id/archive', (req, res) => {
  db.prepare('UPDATE clients SET active = 0 WHERE id = ?').run(req.params.id);
  res.redirect('/clients?flash=Client archived');
});

r.post('/:id/restore', (req, res) => {
  db.prepare('UPDATE clients SET active = 1 WHERE id = ?').run(req.params.id);
  res.redirect(clientUrl(req.params.id, 'overview', 'flash=Client restored'));
});

r.post('/:id/contacts', (req, res) => {
  const { name, email, phone, is_primary } = req.body;
  if (name?.trim()) {
    db.prepare('INSERT INTO contacts (client_id, name, email, phone, is_primary) VALUES (?, ?, ?, ?, ?)')
      .run(req.params.id, name.trim(), email || null, phone || null, is_primary ? 1 : 0);
  }
  res.redirect(clientUrl(req.params.id, 'contacts', 'flash=Contact added'));
});

r.post('/:id/contacts/:contactId/delete', (req, res) => {
  db.prepare('DELETE FROM contacts WHERE id = ? AND client_id = ?').run(req.params.contactId, req.params.id);
  res.redirect(clientUrl(req.params.id, 'contacts', 'flash=Contact removed'));
});

r.post('/:id/contacts/:contactId', (req, res) => {
  const { name, email, phone, is_primary } = req.body;
  if (!name?.trim()) return res.redirect(clientUrl(req.params.id, 'contacts', 'flash=Contact name is required&kind=err'));
  if (is_primary) {
    db.prepare('UPDATE contacts SET is_primary = 0 WHERE client_id = ?').run(req.params.id);
  }
  db.prepare('UPDATE contacts SET name = ?, email = ?, phone = ?, is_primary = ? WHERE id = ? AND client_id = ?')
    .run(name.trim(), email || null, phone || null, is_primary ? 1 : 0, req.params.contactId, req.params.id);
  res.redirect(clientUrl(req.params.id, 'contacts', 'flash=Contact saved'));
});

r.post('/:id/time', (req, res) => {
  const mins = Number(req.body.minutes);
  if (!mins || mins <= 0) return res.redirect(clientUrl(req.params.id, 'time', 'flash=Minutes must be a positive number&kind=err'));
  const ticketId = req.body.ticket_id
    ? db.prepare('SELECT id FROM tickets WHERE id = ? AND client_id = ?').get(req.body.ticket_id, req.params.id)?.id ?? null
    : null;
  db.prepare(
    'INSERT INTO time_entries (ticket_id, client_id, minutes, description, billable) VALUES (?, ?, ?, ?, ?)'
  ).run(ticketId, req.params.id, mins, req.body.description?.trim() || null, req.body.billable ? 1 : 0);
  if (ticketId) db.prepare("UPDATE tickets SET updated_at = datetime('now') WHERE id = ?").run(ticketId);
  res.redirect(clientUrl(req.params.id, 'time', 'flash=Time logged'));
});

r.post('/:id/time/:entryId', (req, res) => {
  const entry = db.prepare(
    'SELECT id FROM time_entries WHERE id = ? AND client_id = ? AND invoiced_at IS NULL'
  ).get(req.params.entryId, req.params.id);
  if (!entry) return res.redirect(clientUrl(req.params.id, 'time', 'flash=Time entry not found or already invoiced&kind=err'));
  const mins = Number(req.body.minutes);
  if (!mins || mins <= 0) return res.redirect(clientUrl(req.params.id, 'time', 'flash=Minutes must be a positive number&kind=err'));
  db.prepare('UPDATE time_entries SET minutes = ?, description = ?, billable = ? WHERE id = ?')
    .run(mins, String(req.body.description || '').trim() || null, req.body.billable ? 1 : 0, entry.id);
  res.redirect(clientUrl(req.params.id, 'time', 'flash=Time entry saved'));
});

r.post('/:id/time/:entryId/delete', (req, res) => {
  db.prepare('DELETE FROM time_entries WHERE id = ? AND client_id = ? AND invoiced_at IS NULL')
    .run(req.params.entryId, req.params.id);
  res.redirect(clientUrl(req.params.id, 'time', 'flash=Time entry removed'));
});

function parseServiceBody(body) {
  const months = body.months === '12' ? 12 : 1;
  const m = Number(body.bill_month);
  return {
    name: String(body.name || '').trim(),
    description: String(body.description || '').trim() || null,
    quantity: Number(body.quantity) > 0 ? Number(body.quantity) : 1,
    cost_price: Number(body.cost_price) >= 0 ? Number(body.cost_price) || 0 : 0,
    sell_price: Number(body.sell_price),
    months,
    bill_month: months > 1 && m >= 1 && m <= 12 ? m : null
  };
}

function serviceError(svc) {
  if (!svc.name) return 'Service name is required';
  if (!svc.sell_price || svc.sell_price <= 0) return 'Sell price must be positive';
  if (svc.months > 1 && !svc.bill_month) return 'Pick a renewal month for annual services';
  return null;
}

r.post('/:id/services', (req, res) => {
  const svc = parseServiceBody(req.body);
  const err = serviceError(svc);
  if (err) return res.redirect(clientUrl(req.params.id, 'billing', `flash=${encodeURIComponent(err)}&kind=err&open=recurring`));
  db.prepare(`
    INSERT INTO recurring_services (client_id, name, description, quantity, cost_price, sell_price, months, bill_month)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(req.params.id, svc.name, svc.description, svc.quantity, svc.cost_price, svc.sell_price, svc.months, svc.bill_month);
  res.redirect(clientUrl(req.params.id, 'billing', 'flash=Recurring service added'));
});

r.post('/:id/services/:serviceId', (req, res) => {
  const row = db.prepare('SELECT id FROM recurring_services WHERE id = ? AND client_id = ?')
    .get(req.params.serviceId, req.params.id);
  if (!row) return res.redirect(clientUrl(req.params.id, 'billing', 'flash=Service not found&kind=err'));
  const svc = parseServiceBody(req.body);
  const err = serviceError(svc);
  if (err) return res.redirect(clientUrl(req.params.id, 'billing', `flash=${encodeURIComponent(err)}&kind=err`));
  db.prepare(`
    UPDATE recurring_services
    SET name = ?, description = ?, quantity = ?, cost_price = ?, sell_price = ?, months = ?, bill_month = ?, active = ?
    WHERE id = ?
  `).run(svc.name, svc.description, svc.quantity, svc.cost_price, svc.sell_price, svc.months, svc.bill_month,
    req.body.active ? 1 : 0, row.id);
  res.redirect(clientUrl(req.params.id, 'billing', 'flash=Recurring service saved'));
});

r.post('/:id/services/:serviceId/delete', (req, res) => {
  db.prepare('DELETE FROM recurring_services WHERE id = ? AND client_id = ?')
    .run(req.params.serviceId, req.params.id);
  res.redirect(clientUrl(req.params.id, 'billing', 'flash=Recurring service removed'));
});

// One-click pro-rata: bill the remainder of an annual/multi-year term (to its end date)
// as a manual invoice line — for mid-term onboarding or missed renewals.
r.post('/:id/subs/:subId/prorata', (req, res) => {
  const sub = db.prepare(`
    SELECT s.*, p.name AS product_name, p.buy_price AS p_buy, p.sell_price AS p_sell
    FROM pax8_subscriptions s LEFT JOIN pax8_products p ON p.id = s.product_id
    WHERE s.id = ? AND s.client_id = ?
  `).get(req.params.subId, req.params.id);
  if (!sub) return res.redirect(clientUrl(req.params.id, 'billing', 'flash=Subscription not found&kind=err'));
  const sell = sellPrice({ sell_price: sub.p_sell, buy_price: sub.p_buy ?? sub.buy_price });
  const quote = subProrataQuote(sub, sell);
  if (!quote) {
    return res.redirect(clientUrl(req.params.id, 'billing', `flash=${encodeURIComponent(
      'No pro-rata to bill — the subscription has no future end date. Run a Pax8 sync from Settings.'
    )}&kind=err`));
  }
  const today = todayIsoInTz();
  const description = `${sub.product_name || sub.product_id} — pro-rata ${fmtDate(today)} → ${fmtDate(sub.end_date)}\n`
    + `${sub.quantity} × ${sell.toFixed(2)}/term × ${quote.daysLeft} of ${quote.termDays} days`;
  db.prepare(
    'INSERT INTO manual_charges (client_id, description, quantity, unit_amount) VALUES (?, ?, 1, ?)'
  ).run(req.params.id, description, quote.amount);
  res.redirect(clientUrl(req.params.id, 'billing', `flash=${encodeURIComponent(
    `Pro-rata line added (A$${quote.amount.toFixed(2)}) — review under Manual invoice lines`
  )}`));
});

r.post('/:id/charges', (req, res) => {
  const description = String(req.body.description || '').trim();
  const amount = Number(req.body.unit_amount);
  if (!description) return res.redirect(clientUrl(req.params.id, 'billing', 'flash=Description is required&kind=err&open=manual'));
  if (!amount || amount <= 0) return res.redirect(clientUrl(req.params.id, 'billing', 'flash=Amount must be positive&kind=err&open=manual'));
  db.prepare(
    'INSERT INTO manual_charges (client_id, description, quantity, unit_amount) VALUES (?, ?, 1, ?)'
  ).run(req.params.id, description, amount);
  res.redirect(clientUrl(req.params.id, 'billing', 'flash=Manual line added'));
});

r.post('/:id/charges/:chargeId', (req, res) => {
  const description = String(req.body.description || '').trim();
  const amount = Number(req.body.unit_amount);
  const row = db.prepare(
    'SELECT id FROM manual_charges WHERE id = ? AND client_id = ? AND invoiced_at IS NULL'
  ).get(req.params.chargeId, req.params.id);
  if (!row) return res.redirect(clientUrl(req.params.id, 'billing', 'flash=Line not found or already invoiced&kind=err'));
  if (!description) return res.redirect(clientUrl(req.params.id, 'billing', 'flash=Description is required&kind=err'));
  if (!amount || amount <= 0) return res.redirect(clientUrl(req.params.id, 'billing', 'flash=Amount must be positive&kind=err'));
  db.prepare('UPDATE manual_charges SET description = ?, unit_amount = ? WHERE id = ?')
    .run(description, amount, req.params.chargeId);
  res.redirect(clientUrl(req.params.id, 'billing', 'flash=Manual line saved'));
});

r.post('/:id/charges/:chargeId/delete', (req, res) => {
  db.prepare(
    'DELETE FROM manual_charges WHERE id = ? AND client_id = ? AND invoiced_at IS NULL'
  ).run(req.params.chargeId, req.params.id);
  res.redirect(clientUrl(req.params.id, 'billing', 'flash=Manual line removed'));
});

export default r;
