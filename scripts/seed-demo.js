#!/usr/bin/env node
// Reset the database and load fictional demo data for screenshots / GitHub.
import { unlinkSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const dbPath = process.env.DB_PATH || join(root, 'psa.sqlite');

for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
  if (existsSync(f)) unlinkSync(f);
}

const { db, setSetting } = await import('../src/db.js');

const clearTables = [
  'ticket_attachments', 'ticket_events', 'ticket_messages', 'tickets',
  'time_entries', 'manual_charges', 'recurring_services', 'invoices',
  'pax8_prorata_items', 'pax8_subscriptions', 'pax8_products', 'pax8_companies',
  'contacts', 'clients', 'job_log'
];
for (const t of clearTables) db.exec(`DELETE FROM ${t}`);

setSetting('default_hourly_rate', '150');
setSetting('default_markup_pct', '20');
setSetting('xero_labour_account', '200');
setSetting('xero_licence_account', '200');
setSetting('xero_agreement_account', '200');
setSetting('xero_tax_type', 'OUTPUT');
setSetting('mail_poll_minutes', '2');
setSetting('pax8_sync_hours', '4');
setSetting('telegram_digest_hour', '8');
setSetting('app_timezone', 'Australia/Perth');
setSetting('ticket_auto_close_days', '0');

const insertClient = db.prepare(`
  INSERT INTO clients (name, agreement_name, monthly_fee, hourly_rate, notes, active)
  VALUES (?, ?, ?, ?, ?, 1)
`);
const insertContact = db.prepare(`
  INSERT INTO contacts (client_id, name, email, phone, is_primary)
  VALUES (?, ?, ?, ?, ?)
`);
const insertTicket = db.prepare(`
  INSERT INTO tickets (ticket_number, client_id, contact_id, subject, status, priority, category, source, requester_email, follow_up_at, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', ?), datetime('now', ?))
`);
const insertMessage = db.prepare(`
  INSERT INTO ticket_messages (ticket_id, direction, author, body, created_at)
  VALUES (?, ?, ?, ?, datetime('now', ?))
`);
const insertEvent = db.prepare(`
  INSERT INTO ticket_events (ticket_id, action, detail) VALUES (?, ?, ?)
`);
const insertTime = db.prepare(`
  INSERT INTO time_entries (ticket_id, client_id, minutes, description, billable, worked_at)
  VALUES (?, ?, ?, ?, 1, datetime('now', ?))
`);
const insertCharge = db.prepare(`
  INSERT INTO manual_charges (client_id, description, quantity, unit_amount)
  VALUES (?, ?, ?, ?)
`);
const insertService = db.prepare(`
  INSERT INTO recurring_services (client_id, name, description, quantity, cost_price, sell_price, months, active)
  VALUES (?, ?, ?, ?, ?, ?, ?, 1)
`);
const insertProduct = db.prepare(`
  INSERT INTO pax8_products (id, name, vendor, buy_price, sell_price) VALUES (?, ?, ?, ?, ?)
`);
const insertSub = db.prepare(`
  INSERT INTO pax8_subscriptions (id, client_id, pax8_company_id, product_id, quantity, buy_price, billing_term, status, synced_at)
  VALUES (?, ?, ?, ?, ?, ?, 'Monthly', 'Active', datetime('now'))
`);
const insertCompany = db.prepare(`
  INSERT INTO pax8_companies (id, name, synced_at) VALUES (?, ?, datetime('now'))
`);

const clients = [
  { name: 'Acme Dental Practice', agreement: 'Managed Essentials', fee: 450, rate: 165,
    contact: { name: 'Dr Sarah Chen', email: 'sarah.chen@acmedental.demo', phone: '08 9123 4500' },
    notes: '12 workstations, M365 Business Premium, nightly cloud backup.' },
  { name: 'Bluewave Accounting', agreement: 'Managed Professional', fee: 850, rate: 175,
    contact: { name: 'James Morrison', email: 'james@bluewave.demo', phone: '08 9234 5600' },
    notes: 'Hybrid workforce — 8 on-prem, 14 remote. Xero practice management.' },
  { name: 'Coastal Legal Group', agreement: 'Managed Essentials', fee: 550, rate: 185,
    contact: { name: 'Emma Walsh', email: 'emma.walsh@coastlegal.demo', phone: '08 9345 6700' },
    notes: 'Document management on SharePoint. Strict security requirements.' },
  { name: 'Summit Construction', agreement: 'Managed Lite', fee: 320, rate: 150,
    contact: { name: 'Mark Stevens', email: 'mark@summitbuild.demo', phone: '08 9456 7800' },
    notes: 'Site tablets and project managers on laptops. Field connectivity issues common.' }
];

const clientIds = {};
const contactIds = {};
for (const c of clients) {
  const r = insertClient.run(c.name, c.agreement, c.fee, c.rate, c.notes);
  clientIds[c.name] = r.lastInsertRowid;
  const cr = insertContact.run(r.lastInsertRowid, c.contact.name, c.contact.email, c.contact.phone, 1);
  contactIds[c.name] = cr.lastInsertRowid;
}

const products = [
  ['demo-m365-bp', 'Microsoft 365 Business Premium', 'Microsoft', 28.5, 38.0],
  ['demo-m365-be', 'Microsoft 365 Business Basic', 'Microsoft', 8.2, 12.5],
  ['demo-defender', 'Microsoft Defender for Business', 'Microsoft', 3.1, 5.0],
  ['demo-backup', 'Acronis Cyber Protect Cloud', 'Acronis', 4.5, 8.0]
];
for (const p of products) insertProduct.run(...p);

const companies = [
  ['demo-co-acme', 'Acme Dental Practice'],
  ['demo-co-blue', 'Bluewave Accounting'],
  ['demo-co-coast', 'Coastal Legal Group'],
  ['demo-co-summit', 'Summit Construction']
];
for (const co of companies) insertCompany.run(...co);

insertSub.run('demo-sub-1', clientIds['Acme Dental Practice'], 'demo-co-acme', 'demo-m365-bp', 12, 28.5);
insertSub.run('demo-sub-2', clientIds['Acme Dental Practice'], 'demo-co-acme', 'demo-defender', 12, 3.1);
insertSub.run('demo-sub-3', clientIds['Bluewave Accounting'], 'demo-co-blue', 'demo-m365-bp', 22, 28.5);
insertSub.run('demo-sub-4', clientIds['Bluewave Accounting'], 'demo-co-blue', 'demo-backup', 22, 4.5);
insertSub.run('demo-sub-5', clientIds['Coastal Legal Group'], 'demo-co-coast', 'demo-m365-bp', 18, 28.5);
insertSub.run('demo-sub-6', clientIds['Summit Construction'], 'demo-co-summit', 'demo-m365-be', 8, 8.2);

insertService.run(clientIds['Acme Dental Practice'], 'Cloud backup — server', 'Nightly offsite backup', 1, 45, 89, 1);
insertService.run(clientIds['Bluewave Accounting'], 'Managed firewall', 'FortiGate 60F + monitoring', 1, 120, 195, 1);
insertService.run(clientIds['Coastal Legal Group'], 'Domain & DNS', 'coastlegal.demo annual renewal', 1, 25, 45, 12);

insertCharge.run(clientIds['Summit Construction'], 'USB-C dock supply and install', 2, 145);
insertCharge.run(clientIds['Bluewave Accounting'], 'Emergency after-hours server recovery', 1, 450);

const tickets = [
  { num: 50, client: 'Acme Dental Practice', subject: 'Reception PC very slow after Windows update', status: 'in_progress', priority: 'high', category: 'Hardware', offset: '-2 days', msgs: [
    ['in', 'Dr Sarah Chen', 'Since Tuesday the reception computer takes 5+ minutes to boot. Patient check-in is backing up.'],
    ['out', 'Support', 'Remote session booked for 2pm. Will check startup apps and disk space.'],
    ['note', 'Support', 'Disk at 94% — clearing temp files and reviewing OneDrive sync scope.']
  ], time: [{ mins: 45, desc: 'Remote diagnostics and cleanup', offset: '-1 days' }] },
  { num: 51, client: 'Bluewave Accounting', subject: 'Outlook keeps asking for password on laptops', status: 'waiting', priority: 'normal', category: 'M365', offset: '-4 days', followUp: '+1 day', msgs: [
    ['in', 'James Morrison', 'Three staff laptops prompt for credentials every morning. Modern auth seems broken.'],
    ['out', 'Support', 'Applied registry fix and re-registered WAM. Please confirm tomorrow morning whether prompts persist.'],
    ['note', 'Support', 'Waiting on client confirmation before closing.']
  ], time: [{ mins: 60, desc: 'WAM / Entra ID troubleshooting', offset: '-3 days' }] },
  { num: 52, client: 'Coastal Legal Group', subject: 'SharePoint permissions audit requested', status: 'open', priority: 'normal', category: 'Security', offset: '-1 days', msgs: [
    ['in', 'Emma Walsh', 'Partners want a report of who has access to the Matters library before month end.']
  ] },
  { num: 53, client: 'Summit Construction', subject: 'Site tablet cannot connect to VPN', status: 'open', priority: 'critical', category: 'Network', offset: '-6 hours', msgs: [
    ['in', 'Mark Stevens', 'Foreman tablet at Henderson site shows VPN error 809. Blocking daily site reports.'],
    ['note', 'Support', 'Likely UDP 500/4500 blocked on site router — need ISP details from Mark.']
  ] },
  { num: 54, client: 'Acme Dental Practice', subject: 'New hygienist mailbox and Teams setup', status: 'closed', priority: 'low', category: 'M365', offset: '-12 days', msgs: [
    ['in', 'Dr Sarah Chen', 'Please create mailbox for Mia Torres starting Monday.'],
    ['out', 'Support', 'Mailbox created, Teams voice enabled, added to Hygienists group.'],
    ['note', 'Support', 'Closed — 30 min onboarding logged.']
  ], time: [{ mins: 30, desc: 'New user onboarding', offset: '-11 days' }] }
];

for (const t of tickets) {
  const cid = clientIds[t.client];
  const ctid = contactIds[t.client];
  const tr = insertTicket.run(
    t.num, cid, ctid, t.subject, t.status, t.priority, t.category, 'email',
    clients.find(c => c.name === t.client).contact.email,
    t.followUp || null, t.offset, t.offset
  );
  const tid = tr.lastInsertRowid;
  insertEvent.run(tid, 'created', 'Demo seed');
  for (const [dir, author, body] of t.msgs || []) {
    insertMessage.run(tid, dir, author, body, t.offset);
  }
  for (const te of t.time || []) {
    insertTime.run(tid, cid, te.mins, te.desc, te.offset);
  }
}

insertTime.run(null, clientIds['Coastal Legal Group'], 90, 'Monthly server patching', '-5 days');
insertTime.run(null, clientIds['Bluewave Accounting'], 120, 'Quarterly backup restore test', '-8 days');

console.log('Demo database seeded at', dbPath);
console.log('  Clients:', clients.length);
console.log('  Tickets:', tickets.length);
console.log('  Pax8 subscriptions: 6');
console.log('Start the app: npm start');
