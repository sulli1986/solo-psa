import { db } from './db.js';

export const TICKET_CATEGORIES = ['Network', 'M365', 'Hardware', 'Security', 'Billing', 'Other'];
export const TICKET_STATUSES = ['open', 'in_progress', 'waiting', 'closed'];
export const PAGE_SIZE = 50;
export const STALE_DAYS = 7;
export const TICKET_NUMBER_START = 50;

export function formatTicketRef(ticketOrNumber) {
  const n = typeof ticketOrNumber === 'object' ? ticketOrNumber.ticket_number : ticketOrNumber;
  if (n == null) return 'TKT-?????';
  return `TKT-${String(n).padStart(5, '0')}`;
}

export function parseTicketRef(q) {
  const s = String(q).trim();
  const tkt = s.match(/^TKT-0*(\d+)$/i);
  if (tkt) return Number(tkt[1]);
  const psa = s.match(/^PSA-?(\d+)$/i);
  if (psa) return Number(psa[1]);
  return null;
}

export function allocateTicketNumber() {
  const row = db.prepare('SELECT COALESCE(MAX(ticket_number), ?) AS n FROM tickets')
    .get(TICKET_NUMBER_START - 1);
  return row.n + 1;
}

export function findTicketByNumberOrId(n) {
  const num = Number(n);
  if (!num) return null;
  return db.prepare('SELECT * FROM tickets WHERE ticket_number = ?').get(num)
    || db.prepare('SELECT * FROM tickets WHERE id = ?').get(num);
}

export function isBillingResolved(ticket) {
  if (!ticket?.client_id) return true;
  if (ticket.billing_status === 'not_billable') return true;
  return Boolean(db.prepare('SELECT 1 FROM time_entries WHERE ticket_id = ? LIMIT 1').get(ticket.id));
}

const insertEvent = db.prepare(
  'INSERT INTO ticket_events (ticket_id, action, detail) VALUES (?, ?, ?)'
);

export function logTicketEvent(ticketId, action, detail = null) {
  insertEvent.run(ticketId, action, detail);
}

function displayClient(id) {
  if (!id) return '—';
  const row = db.prepare('SELECT name FROM clients WHERE id = ?').get(id);
  return row?.name || `#${id}`;
}

function displayContact(id) {
  if (!id) return '—';
  const row = db.prepare('SELECT name FROM contacts WHERE id = ?').get(id);
  return row?.name || `#${id}`;
}

export function logTicketFieldChanges(ticketId, before, fields) {
  const resolvers = {
    client_id: displayClient,
    contact_id: displayContact
  };
  const labels = {
    status: 'Status',
    priority: 'Priority',
    client_id: 'Client',
    contact_id: 'Contact',
    subject: 'Subject',
    category: 'Category',
    follow_up_at: 'Follow-up'
  };
  for (const [key, label] of Object.entries(labels)) {
    if (fields[key] === undefined) continue;
    const oldVal = before[key] ?? '';
    const newVal = fields[key] ?? '';
    if (String(oldVal) !== String(newVal)) {
      const fmt = resolvers[key] || ((v) => v || '—');
      logTicketEvent(ticketId, 'changed', `${label}: ${fmt(oldVal)} → ${fmt(newVal)}`);
    }
  }
}

// Last activity = latest message, time entry, or ticket update.
export const LAST_ACTIVITY_SQL = `COALESCE(
  (SELECT MAX(created_at) FROM ticket_messages tm WHERE tm.ticket_id = t.id),
  (SELECT MAX(worked_at) FROM time_entries te WHERE te.ticket_id = t.id),
  t.updated_at
)`;

export const IS_STALE_SQL = `(
  t.status != 'closed'
  AND julianday('now') - julianday(${LAST_ACTIVITY_SQL}) >= ${STALE_DAYS}
)`;

export function autoCloseStaleTickets(days) {
  if (!days || days <= 0) return 0;
  const rows = db.prepare(`
    SELECT t.id FROM tickets t
    WHERE t.status = 'waiting'
      AND julianday('now') - julianday(${LAST_ACTIVITY_SQL}) >= ?
  `).all(days);
  const close = db.prepare("UPDATE tickets SET status = 'closed', updated_at = datetime('now') WHERE id = ?");
  for (const row of rows) {
    close.run(row.id);
    logTicketEvent(row.id, 'auto_closed', `No activity for ${days} days while waiting`);
  }
  return rows.length;
}
