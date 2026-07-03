// Pax8 integration: client-credentials auth, company + subscription sync.
// Read-only: subscriptions become invoice lines at your sell price.
import { db, getNumberSetting } from '../db.js';

// Guess whether a Pax8 product represents a billable M365 user seat.
export function defaultCountsAsUser(name = '', vendor = '') {
  const n = String(name).toLowerCase();
  const v = String(vendor).toLowerCase();
  if (!n.includes('microsoft') && !n.includes('office 365') && !n.includes('m365') && v !== 'microsoft') {
    return 0;
  }
  const exclude = [
    'defender', 'azure', 'backup', 'acronis', 'teams phone', 'teams rooms', 'teams premium',
    'sharepoint plan', 'exchange online plan', 'exchange online (', 'visio', 'project ',
    'planner', 'power bi', 'copilot', 'windows ', 'intune plan', 'audio conferencing',
    'cloud app security', 'purview', 'entra', 'identity'
  ];
  if (exclude.some((p) => n.includes(p))) return 0;
  const include = [
    'business premium', 'business standard', 'business basic', 'business essentials',
    'microsoft 365 e', 'office 365 e', 'microsoft 365 f', 'microsoft 365 apps',
    'office 365 business', 'microsoft 365 business'
  ];
  return include.some((p) => n.includes(p)) ? 1 : 0;
}

const TOKEN_URL = 'https://api.pax8.com/v1/token';
const API = 'https://api.pax8.com/v1';
const API_V2 = 'https://api.pax8.com/v2';

let cached = { token: null, exp: 0 };

export function pax8Configured() {
  return Boolean(process.env.PAX8_CLIENT_ID && process.env.PAX8_CLIENT_SECRET);
}

async function token() {
  if (cached.token && Date.now() < cached.exp) return cached.token;
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: process.env.PAX8_CLIENT_ID,
      client_secret: process.env.PAX8_CLIENT_SECRET,
      audience: 'https://api.pax8.com',
      grant_type: 'client_credentials'
    })
  });
  if (!res.ok) throw new Error(`Pax8 auth failed (${res.status}): ${await res.text()}`);
  const tok = await res.json();
  cached = { token: tok.access_token, exp: Date.now() + (tok.expires_in - 60) * 1000 };
  return cached.token;
}

async function pax8Get(path) {
  const res = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${await token()}`, Accept: 'application/json' }
  });
  if (!res.ok) throw new Error(`Pax8 ${path} failed (${res.status}): ${await res.text()}`);
  return res.json();
}

async function pagedList(path, key = 'content') {
  const all = [];
  let page = 0;
  for (;;) {
    const sep = path.includes('?') ? '&' : '?';
    const data = await pax8Get(`${path}${sep}page=${page}&size=200`);
    const items = data?.[key] || [];
    all.push(...items);
    const totalPages = data?.page?.totalPages ?? 1;
    if (++page >= totalPages || !items.length) break;
  }
  return all;
}

const pricingCache = new Map();

async function pricingFor(productId, companyId) {
  const key = `${productId}:${companyId}`;
  if (!pricingCache.has(key)) {
    try {
      const data = await pax8Get(`/products/${productId}/pricing?companyId=${companyId}`);
      pricingCache.set(key, data?.content || []);
    } catch {
      pricingCache.set(key, []);
    }
  }
  return pricingCache.get(key);
}

// Match subscription billing term to a pricing row; pick the per-unit rate.
function ratesForTerm(pricingRows, billingTerm) {
  const term = (billingTerm || '').toLowerCase();
  const row = pricingRows.find((p) => (p.billingTerm || '').toLowerCase() === term)
    || pricingRows.find((p) => (p.billingTerm || '').toLowerCase().includes(term))
    || pricingRows[0];
  const rate = row?.rates?.find((r) => r.chargeType === 'Per Unit') || row?.rates?.[0];
  if (!rate) return null;
  return { buy: rate.partnerBuyRate ?? null, sell: rate.suggestedRetailPrice ?? null };
}

async function pax8GetV2(path) {
  const res = await fetch(`${API_V2}${path}`, {
    headers: { Authorization: `Bearer ${await token()}`, Accept: 'application/json' }
  });
  if (!res.ok) throw new Error(`Pax8 ${path} failed (${res.status}): ${await res.text()}`);
  return res.json();
}

async function pagedListV2(path, key = 'content') {
  const all = [];
  let page = 0;
  for (;;) {
    const sep = path.includes('?') ? '&' : '?';
    const data = await pax8GetV2(`${path}${sep}page=${page}&size=200`);
    const items = data?.[key] || [];
    all.push(...items);
    const totalPages = data?.page?.totalPages ?? 1;
    if (++page >= totalPages || !items.length) break;
  }
  return all;
}

function currentBillingPeriod() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// How many months a Pax8 billing term covers per invoice.
// 1 = bill every month, 12/24/36 = bill once per term, 0 = never recurs (trial/one-time/activation).
export function subTermMonths(billingTerm) {
  const t = String(billingTerm || '').toLowerCase();
  if (t.includes('3-year') || t.includes('3 year')) return 36;
  if (t.includes('2-year') || t.includes('2 year')) return 24;
  if (t.includes('annual') || t.includes('year')) return 12;
  if (t.includes('trial') || t.includes('one-time') || t.includes('one time') || t.includes('activation')) return 0;
  return 1; // Monthly, or unknown → monthly
}

// Classify a Pax8 draft-invoice item: prorata charge, an annual/multi-year renewal
// (regular charge line belonging to a multi-month-term subscription), or neither.
export function classifyDraftItem(item, subBillingTerm) {
  if (isProrataItem(item)) return 'prorata';
  if (subBillingTerm != null && subTermMonths(subBillingTerm) > 1) return 'renewal';
  return null;
}

function addMonthsISO(dateStr, months) {
  const d = new Date(String(dateStr).slice(0, 10));
  if (Number.isNaN(d.getTime())) return null;
  d.setMonth(d.getMonth() + months);
  return d.toISOString().slice(0, 10);
}

function isProrataItem(item) {
  const type = String(item.type || item.lineItemType || item.itemType || '').toLowerCase();
  if (type.includes('prorat')) return true;
  const desc = String(item.description || item.name || '').toLowerCase();
  return desc.includes('prorat') || desc.includes('pro-rat') || desc.includes('pro rat');
}

function draftItemAmount(item) {
  const buy = item.costTotal ?? item.cost ?? item.partnerSubtotal ?? item.subTotal ?? item.total ?? 0;
  return Number(buy) || 0;
}

function prorataSellAmount(buyAmount, product) {
  if (!buyAmount || buyAmount <= 0) return 0;
  if (product?.sell_price != null && product.buy_price > 0) {
    return buyAmount * (product.sell_price / product.buy_price);
  }
  const markup = getNumberSetting('default_markup_pct', 20) / 100;
  return buyAmount * (1 + markup);
}

export function listCachedCompanies() {
  return db.prepare('SELECT * FROM pax8_companies ORDER BY name').all();
}

export function unlinkedPax8Companies() {
  return db.prepare(`
    SELECT pc.* FROM pax8_companies pc
    LEFT JOIN clients c ON c.pax8_company_id = pc.id AND c.active = 1
    WHERE c.id IS NULL
    ORDER BY pc.name
  `).all();
}

async function syncCompanyCache(companies) {
  const upsert = db.prepare(`
    INSERT INTO pax8_companies (id, name, synced_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, synced_at = excluded.synced_at
  `);
  for (const c of companies) upsert.run(c.id, c.name || c.id);
}

async function syncProrataItems(companies) {
  const period = currentBillingPeriod();
  const clientByCompany = db.prepare('SELECT id FROM clients WHERE pax8_company_id = ?');
  const productBuy = db.prepare('SELECT buy_price, sell_price FROM pax8_products WHERE id = ?');
  // subscription id → billing term, to recognise annual/multi-year renewal charges
  const termBySub = new Map(
    db.prepare('SELECT id, billing_term FROM pax8_subscriptions').all().map((r) => [r.id, r.billing_term])
  );
  const upsert = db.prepare(`
    INSERT INTO pax8_prorata_items (
      id, pax8_company_id, client_id, product_id, description, quantity,
      buy_amount, sell_amount, item_type, billing_period, synced_at
    ) VALUES (
      @id, @pax8_company_id, @client_id, @product_id, @description, @quantity,
      @buy_amount, @sell_amount, @item_type, @billing_period, datetime('now')
    )
    ON CONFLICT(id) DO UPDATE SET
      client_id = excluded.client_id, description = excluded.description,
      quantity = excluded.quantity, buy_amount = excluded.buy_amount,
      sell_amount = COALESCE(pax8_prorata_items.sell_amount, excluded.sell_amount),
      item_type = excluded.item_type, synced_at = excluded.synced_at
    WHERE pax8_prorata_items.invoiced_at IS NULL
  `);

  const seenIds = new Set();
  let count = 0;

  for (const company of companies) {
    let items;
    try {
      items = await pagedListV2(`/draft-invoice-items?companyId=${company.id}&monthOffset=0`);
    } catch {
      continue;
    }
    const client = clientByCompany.get(company.id);
    for (const item of items) {
      const subTerm = item.subscriptionId ? termBySub.get(item.subscriptionId) ?? null : null;
      const kind = classifyDraftItem(item, subTerm);
      if (!kind) continue;
      const buy = draftItemAmount(item);
      if (buy <= 0) continue;
      const productId = item.productId || item.product?.id || null;
      const product = productId ? productBuy.get(productId) : null;
      const id = String(item.id || `${company.id}:${item.subscriptionId || productId}:${item.description}:${buy}`);
      seenIds.add(id);
      upsert.run({
        id,
        pax8_company_id: company.id,
        client_id: client?.id ?? null,
        product_id: productId,
        description: (item.description || item.name || 'Pax8 charge')
          + (kind === 'renewal' ? ` (${subTerm} renewal)` : ''),
        quantity: item.quantity ?? 1,
        buy_amount: buy,
        sell_amount: prorataSellAmount(buy, product),
        item_type: kind === 'renewal' ? 'renewal' : (item.type || item.lineItemType || 'prorate'),
        billing_period: period
      });
      count++;
    }
  }

  const stale = db.prepare(
    'SELECT id FROM pax8_prorata_items WHERE billing_period = ? AND invoiced_at IS NULL'
  ).all(period);
  const del = db.prepare('DELETE FROM pax8_prorata_items WHERE id = ?');
  for (const row of stale) {
    if (!seenIds.has(row.id)) del.run(row.id);
  }
  return count;
}

export async function listCompanies() {
  return pagedList('/companies');
}

// Full sync: companies cache, subscriptions, prorata draft items, auto-link by name.
export async function syncSubscriptions() {
  const companies = await listCompanies();
  await syncCompanyCache(companies);
  const linkByName = db.prepare(
    "UPDATE clients SET pax8_company_id = ? WHERE pax8_company_id IS NULL AND lower(name) = lower(?)"
  );
  for (const c of companies) linkByName.run(c.id, c.name || '');

  const clientByCompany = db.prepare('SELECT id FROM clients WHERE pax8_company_id = ?');
  const upsertProduct = db.prepare(`
    INSERT INTO pax8_products (id, name, vendor, buy_price, sell_price, counts_as_user)
    VALUES (@id, @name, @vendor, @buy_price, @sell_price, @counts_as_user)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, vendor = excluded.vendor,
      buy_price = COALESCE(excluded.buy_price, pax8_products.buy_price),
      sell_price = COALESCE(pax8_products.sell_price, excluded.sell_price),
      counts_as_user = COALESCE(pax8_products.counts_as_user, excluded.counts_as_user)
  `);
  const upsertSub = db.prepare(`
    INSERT INTO pax8_subscriptions (
      id, client_id, pax8_company_id, product_id, quantity, buy_price, billing_term, status,
      start_date, billing_start, end_date, commitment_term, synced_at
    )
    VALUES (
      @id, @client_id, @pax8_company_id, @product_id, @quantity, @buy_price, @billing_term, @status,
      @start_date, @billing_start, @end_date, @commitment_term, datetime('now')
    )
    ON CONFLICT(id) DO UPDATE SET client_id = excluded.client_id, quantity = excluded.quantity,
      buy_price = excluded.buy_price, billing_term = excluded.billing_term,
      status = excluded.status, start_date = excluded.start_date,
      billing_start = excluded.billing_start, end_date = excluded.end_date,
      commitment_term = excluded.commitment_term, synced_at = excluded.synced_at
  `);

  const productNames = new Map();
  let count = 0;
  pricingCache.clear();

  for (const company of companies) {
    const subs = await pagedList(`/subscriptions?companyId=${company.id}`);
    for (const s of subs) {
      const productId = s.productId;
      if (productId && !productNames.has(productId)) {
        try {
          const p = await pax8Get(`/products/${productId}`);
          productNames.set(productId, { name: p.name || productId, vendor: p.vendorName || '' });
        } catch {
          productNames.set(productId, { name: productId, vendor: '' });
        }
      }
      const meta = productNames.get(productId) || { name: productId, vendor: '' };
      const pricing = productId ? await pricingFor(productId, company.id) : [];
      const rates = ratesForTerm(pricing, s.billingTerm);
      // Subscription price is Pax8 RRP ex; partner cost comes from the pricing API.
      const sell = s.price ?? rates?.sell ?? null;
      const buy = rates?.buy ?? null;

      upsertProduct.run({
        id: productId,
        name: meta.name,
        vendor: meta.vendor,
        buy_price: buy,
        sell_price: sell,
        counts_as_user: defaultCountsAsUser(meta.name, meta.vendor)
      });

      const client = clientByCompany.get(company.id);
      // Commitment term shape varies across Pax8 API versions: string or { term }
      const commitment = s.commitmentTerm?.term ?? (typeof s.commitmentTerm === 'string' ? s.commitmentTerm : null)
        ?? s.commitment?.term ?? null;
      // Renewal date: Pax8's endDate when present, else start + term length
      const termM = subTermMonths(s.billingTerm);
      const endDate = s.endDate
        || (termM > 1 && (s.billingStart || s.startDate) ? addMonthsISO(s.billingStart || s.startDate, termM) : null);
      upsertSub.run({
        id: s.id,
        client_id: client?.id ?? null,
        pax8_company_id: company.id,
        product_id: productId,
        quantity: s.quantity ?? 0,
        buy_price: buy,
        billing_term: s.billingTerm || '',
        status: s.status || '',
        start_date: s.startDate || null,
        billing_start: s.billingStart || null,
        end_date: endDate,
        commitment_term: commitment
      });
      count++;
    }
  }

  const prorataCount = await syncProrataItems(companies);
  // Relink prorata rows when client mapping changes
  db.prepare(`
    UPDATE pax8_prorata_items SET client_id = (
      SELECT id FROM clients WHERE pax8_company_id = pax8_prorata_items.pax8_company_id AND active = 1 LIMIT 1
    ) WHERE invoiced_at IS NULL
  `).run();

  return { companies: companies.length, subscriptions: count, prorata: prorataCount };
}

// Effective sell price: manual override → Pax8 RRP → buy * (1 + markup%).
export function sellPrice(product) {
  if (product.sell_price != null) return product.sell_price;
  const markup = getNumberSetting('default_markup_pct', 20) / 100;
  return (product.buy_price ?? 0) * (1 + markup);
}
