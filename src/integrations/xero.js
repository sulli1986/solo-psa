// Xero integration: OAuth2 authorization-code flow with rotating refresh tokens,
// contact resolution, and ACCREC draft invoice creation.
import { db, getSetting, setSetting } from '../db.js';

const AUTH_URL = 'https://login.xero.com/identity/connect/authorize';
const TOKEN_URL = 'https://identity.xero.com/connect/token';
const CONNECTIONS_URL = 'https://api.xero.com/connections';
const API = 'https://api.xero.com/api.xro/2.0';
// Granular scopes required for Xero apps created after 2 Mar 2026.
const SCOPES = 'offline_access accounting.contacts accounting.invoices';

function creds() {
  return {
    clientId: process.env.XERO_CLIENT_ID,
    clientSecret: process.env.XERO_CLIENT_SECRET,
    redirectUri: process.env.XERO_REDIRECT_URI // e.g. https://psa.yourdomain/auth/xero/callback
  };
}

export function xeroConfigured() {
  const c = creds();
  return Boolean(c.clientId && c.clientSecret && c.redirectUri);
}

export function xeroConnected() {
  return Boolean(getSetting('xero_refresh_token') && getSetting('xero_tenant_id'));
}

export function authorizeUrl(state) {
  const c = creds();
  const p = new URLSearchParams({
    response_type: 'code',
    client_id: c.clientId,
    redirect_uri: c.redirectUri,
    scope: SCOPES,
    state
  });
  return `${AUTH_URL}?${p}`;
}

async function tokenRequest(body) {
  const c = creds();
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: 'Basic ' + Buffer.from(`${c.clientId}:${c.clientSecret}`).toString('base64')
    },
    body: new URLSearchParams(body)
  });
  if (!res.ok) throw new Error(`Xero token request failed (${res.status}): ${await res.text()}`);
  return res.json();
}

export async function handleCallback(code) {
  const c = creds();
  const tok = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: c.redirectUri });
  setSetting('xero_refresh_token', tok.refresh_token);
  setSetting('xero_access_token', tok.access_token);
  setSetting('xero_access_expires', String(Date.now() + (tok.expires_in - 60) * 1000));

  // Pick the first tenant (single-operator: one org)
  const conns = await fetch(CONNECTIONS_URL, {
    headers: { Authorization: `Bearer ${tok.access_token}` }
  }).then((r) => r.json());
  if (!Array.isArray(conns) || !conns.length) throw new Error('Xero returned no connected organisations');
  setSetting('xero_tenant_id', conns[0].tenantId);
  setSetting('xero_tenant_name', conns[0].tenantName || '');
  return conns[0];
}

async function accessToken() {
  const exp = Number(getSetting('xero_access_expires', '0'));
  if (getSetting('xero_access_token') && Date.now() < exp) return getSetting('xero_access_token');
  const refresh = getSetting('xero_refresh_token');
  if (!refresh) throw new Error('Xero not connected. Open Settings and connect Xero.');
  const tok = await tokenRequest({ grant_type: 'refresh_token', refresh_token: refresh });
  // Xero rotates refresh tokens: always persist the new one immediately.
  setSetting('xero_refresh_token', tok.refresh_token);
  setSetting('xero_access_token', tok.access_token);
  setSetting('xero_access_expires', String(Date.now() + (tok.expires_in - 60) * 1000));
  return tok.access_token;
}

async function xeroFetch(path, opts = {}) {
  const token = await accessToken();
  const res = await fetch(`${API}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      'Xero-Tenant-Id': getSetting('xero_tenant_id'),
      Accept: 'application/json',
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      ...(opts.headers || {})
    }
  });
  if (!res.ok) throw new Error(`Xero ${path} failed (${res.status}): ${await res.text()}`);
  return res.json();
}

// Resolve a Xero ContactID for a client: stored id -> lookup by name -> create.
export async function resolveContact(client) {
  if (client.xero_contact_id) return client.xero_contact_id;

  const q = encodeURIComponent(`Name=="${client.name.replace(/"/g, '')}"`);
  const found = await xeroFetch(`/Contacts?where=${q}`);
  let contactId = found?.Contacts?.[0]?.ContactID;

  if (!contactId) {
    const created = await xeroFetch('/Contacts', {
      method: 'POST',
      body: JSON.stringify({ Contacts: [{ Name: client.name }] })
    });
    contactId = created?.Contacts?.[0]?.ContactID;
  }
  if (!contactId) throw new Error(`Could not resolve Xero contact for ${client.name}`);
  db.prepare('UPDATE clients SET xero_contact_id = ? WHERE id = ?').run(contactId, client.id);
  return contactId;
}

// lines: [{ description, quantity, unitAmount, accountCode }]
export async function createDraftInvoice(client, lines, { reference, dueDays = 14 } = {}) {
  const contactId = await resolveContact(client);
  const taxType = getSetting('xero_tax_type', 'OUTPUT');
  const today = new Date();
  const due = new Date(today.getTime() + dueDays * 86400000);
  const iso = (d) => d.toISOString().slice(0, 10);

  const payload = {
    Invoices: [
      {
        Type: 'ACCREC',
        Status: 'DRAFT',
        Contact: { ContactID: contactId },
        Date: iso(today),
        DueDate: iso(due),
        Reference: reference || '',
        LineAmountTypes: 'Exclusive',
        LineItems: lines.map((l) => ({
          Description: l.description,
          Quantity: l.quantity,
          UnitAmount: Number(l.unitAmount.toFixed(4)),
          AccountCode: l.accountCode,
          TaxType: taxType
        }))
      }
    ]
  };

  const out = await xeroFetch('/Invoices', { method: 'POST', body: JSON.stringify(payload) });
  const inv = out?.Invoices?.[0];
  if (!inv?.InvoiceID) throw new Error(`Xero did not return an invoice for ${client.name}`);
  return {
    invoiceId: inv.InvoiceID,
    number: inv.InvoiceNumber || '',
    total: inv.Total,
    date: xeroInvoiceDate(inv) || iso(today)
  };
}

function xeroInvoiceDate(inv) {
  if (inv?.DateString) return String(inv.DateString).slice(0, 10);
  const d = inv?.Date;
  if (!d) return null;
  if (typeof d === 'string') {
    const ms = d.match(/\/Date\((\d+)/);
    if (ms) return new Date(Number(ms[1])).toISOString().slice(0, 10);
    return d.slice(0, 10);
  }
  return null;
}

export function xeroInvoiceUrl(invoiceId) {
  if (!invoiceId) return null;
  return `https://go.xero.com/AccountsReceivable/View.aspx?InvoiceID=${invoiceId}`;
}

function normalizeInvoiceStatus(inv) {
  const s = (inv.Status || '').toUpperCase();
  if (s === 'PAID') return 'paid';
  if (s === 'VOIDED' || s === 'DELETED') return 'voided';
  if (s === 'DRAFT') return 'draft';
  if (s === 'SUBMITTED') return 'submitted';
  if (s === 'AUTHORISED') {
    const due = Number(inv.AmountDue ?? 0);
    return due > 0 ? 'unpaid' : 'paid';
  }
  return s.toLowerCase() || 'unknown';
}

async function fetchInvoicesByIds(ids) {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return [];
  const out = [];
  for (let i = 0; i < unique.length; i += 50) {
    const chunk = unique.slice(i, i + 50);
    const data = await xeroFetch(`/Invoices?IDs=${chunk.join(',')}`);
    out.push(...(data?.Invoices || []));
  }
  return out;
}

// Refresh local invoice rows from Xero (status, totals, invoice number).
export async function syncLocalInvoices(rows) {
  if (!rows.length) return [];
  const withXero = rows.filter((r) => r.xero_invoice_id);
  if (!xeroConnected() || !withXero.length) {
    return rows.map((row) => ({
      ...row,
      synced: Boolean(row.xero_invoice_id),
      xeroUrl: xeroInvoiceUrl(row.xero_invoice_id)
    }));
  }
  let remote = [];
  try {
    remote = await fetchInvoicesByIds(withXero.map((r) => r.xero_invoice_id));
  } catch {
    return rows.map((row) => ({
      ...row,
      synced: Boolean(row.xero_invoice_id),
      xeroUrl: xeroInvoiceUrl(row.xero_invoice_id)
    }));
  }
  const byId = new Map(remote.map((inv) => [inv.InvoiceID, inv]));
  const update = db.prepare(`
    UPDATE invoices
    SET status = ?, total = ?, xero_number = ?, amount_due = ?, invoice_date = ?, status_synced_at = datetime('now')
    WHERE id = ?
  `);
  return rows.map((row) => {
    const xeroUrl = xeroInvoiceUrl(row.xero_invoice_id);
    if (!row.xero_invoice_id) return { ...row, synced: false, xeroUrl: null };
    const inv = byId.get(row.xero_invoice_id);
    if (!inv) {
      return { ...row, synced: true, xeroUrl, syncError: true };
    }
    const status = normalizeInvoiceStatus(inv);
    const total = inv.Total ?? row.total;
    const amountDue = inv.AmountDue ?? null;
    const number = inv.InvoiceNumber || row.xero_number;
    const invoiceDate = xeroInvoiceDate(inv) || row.invoice_date;
    update.run(status, total, number, amountDue, invoiceDate, row.id);
    return {
      ...row,
      status,
      total,
      xero_number: number,
      amount_due: amountDue,
      invoice_date: invoiceDate,
      synced: true,
      xeroUrl,
      status_synced_at: new Date().toISOString()
    };
  });
}

function contactEmail(c) {
  const direct = (c.EmailAddress || '').trim();
  if (direct) return direct;
  for (const p of c.ContactPersons || []) {
    const e = (p.EmailAddress || '').trim();
    if (e) return e;
  }
  return '';
}

function contactPhone(c) {
  for (const p of c.Phones || []) {
    const num = (p.PhoneNumber || '').trim();
    if (num) return num;
  }
  return '';
}

function mapContact(c) {
  return {
    id: c.ContactID,
    name: c.Name,
    email: contactEmail(c),
    phone: contactPhone(c)
  };
}

// Full contact record (includes ContactPersons emails not always on list).
export async function getContact(contactId) {
  const out = await xeroFetch(`/Contacts/${contactId}`);
  const c = out?.Contacts?.[0];
  if (!c) throw new Error('Xero contact not found');
  return mapContact(c);
}

// List Xero contacts for import/linking (customers only).
export async function listContacts() {
  const out = await xeroFetch('/Contacts?where=IsCustomer==true&order=Name');
  return (out?.Contacts || []).map(mapContact);
}
