// SQLite via node:sqlite (built into Node >= 22) — no native build step.
// Exposes a better-sqlite3-style surface: prepare(), exec(), transaction().
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DB_PATH || join(__dirname, '..', 'psa.sqlite');

const raw = new DatabaseSync(dbPath);
raw.exec('PRAGMA journal_mode = WAL');
raw.exec('PRAGMA foreign_keys = ON');

// Lightweight migrations for existing databases (must run before schema.sql indexes new columns)
for (const sql of [
  'ALTER TABLE invoices ADD COLUMN amount_due REAL',
  'ALTER TABLE invoices ADD COLUMN status_synced_at TEXT',
  'ALTER TABLE invoices ADD COLUMN invoice_date TEXT',
  'ALTER TABLE tickets ADD COLUMN follow_up_at TEXT',
  'ALTER TABLE tickets ADD COLUMN follow_up_nudge TEXT',
  'ALTER TABLE tickets ADD COLUMN category TEXT',
  'ALTER TABLE tickets ADD COLUMN ticket_number INTEGER',
  'ALTER TABLE tickets ADD COLUMN billing_status TEXT',
  'ALTER TABLE ticket_messages ADD COLUMN body_html TEXT',
  'ALTER TABLE ticket_messages ADD COLUMN cc TEXT',
  'ALTER TABLE ticket_messages ADD COLUMN bcc TEXT',
  'ALTER TABLE pax8_subscriptions ADD COLUMN start_date TEXT',
  'ALTER TABLE pax8_subscriptions ADD COLUMN billing_start TEXT',
  'ALTER TABLE pax8_subscriptions ADD COLUMN end_date TEXT',
  'ALTER TABLE pax8_subscriptions ADD COLUMN commitment_term TEXT',
  'ALTER TABLE pax8_subscriptions ADD COLUMN bill_mode TEXT DEFAULT \'auto\'',
  'ALTER TABLE pax8_subscriptions ADD COLUMN bill_month INTEGER',
  'ALTER TABLE clients ADD COLUMN per_user_fee REAL DEFAULT 0',
  'ALTER TABLE clients ADD COLUMN included_users INTEGER DEFAULT 0',
  'ALTER TABLE clients ADD COLUMN excluded_users INTEGER DEFAULT 0',
  "ALTER TABLE clients ADD COLUMN user_count_source TEXT DEFAULT 'pax8'",
  'ALTER TABLE clients ADD COLUMN user_count INTEGER',
  'ALTER TABLE clients ADD COLUMN ms_tenant_id TEXT',
  'ALTER TABLE pax8_products ADD COLUMN counts_as_user INTEGER'
]) {
  try { raw.exec(sql); } catch { /* column already exists */ }
}
try {
  raw.exec(`UPDATE tickets SET ticket_number = 49 + (
    SELECT COUNT(*) FROM tickets t2 WHERE t2.id <= tickets.id
  ) WHERE ticket_number IS NULL`);
  raw.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_tickets_number ON tickets(ticket_number)');
} catch { /* ignore */ }
try {
  raw.exec("UPDATE invoices SET invoice_date = date(created_at) WHERE invoice_date IS NULL");
} catch { /* ignore */ }
try {
  raw.exec(`CREATE TABLE IF NOT EXISTS ticket_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id  INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    action     TEXT NOT NULL,
    detail     TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  raw.exec('CREATE INDEX IF NOT EXISTS idx_ticket_events_ticket ON ticket_events(ticket_id)');
} catch { /* ignore */ }
try {
  raw.exec(`CREATE TABLE IF NOT EXISTS ticket_attachments (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id           INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    message_id          INTEGER REFERENCES ticket_messages(id) ON DELETE CASCADE,
    filename            TEXT NOT NULL,
    content_type        TEXT,
    size_bytes          INTEGER,
    storage_path        TEXT NOT NULL,
    graph_attachment_id TEXT,
    created_at          TEXT DEFAULT (datetime('now'))
  )`);
  raw.exec('CREATE INDEX IF NOT EXISTS idx_attachments_ticket ON ticket_attachments(ticket_id)');
  raw.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_attachments_graph ON ticket_attachments(graph_attachment_id, message_id)');
} catch { /* ignore */ }

try {
  raw.exec(`CREATE TABLE IF NOT EXISTS client_license_count (
    client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    product_id TEXT NOT NULL,
    counts_as_user INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (client_id, product_id)
  )`);
} catch { /* ignore */ }
try {
  raw.exec("UPDATE clients SET user_count_source = 'pax8' WHERE user_count_source = 'selected'");
} catch { /* ignore */ }

raw.exec(readFileSync(join(__dirname, 'schema.sql'), 'utf8'));
try {
  raw.exec('UPDATE clients SET excluded_users = included_users WHERE COALESCE(excluded_users, 0) = 0 AND COALESCE(included_users, 0) > 0');
} catch { /* ignore */ }

export const db = {
  prepare: (sql) => raw.prepare(sql),
  exec: (sql) => raw.exec(sql),
  transaction(fn) {
    return (...args) => {
      raw.exec('BEGIN');
      try {
        const out = fn(...args);
        raw.exec('COMMIT');
        return out;
      } catch (err) {
        raw.exec('ROLLBACK');
        throw err;
      }
    };
  }
};

// --- settings helpers -------------------------------------------------------
const getStmt = raw.prepare('SELECT value FROM settings WHERE key = ?');
const setStmt = raw.prepare(
  'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
);

export function getSetting(key, fallback = null) {
  const row = getStmt.get(key);
  return row && row.value != null ? row.value : fallback;
}

export function setSetting(key, value) {
  setStmt.run(key, value == null ? null : String(value));
}

export function getNumberSetting(key, fallback = 0) {
  const v = getSetting(key);
  const n = Number(v);
  return v == null || Number.isNaN(n) ? fallback : n;
}

// Seed sensible defaults on first boot
const defaults = {
  default_hourly_rate: '150',
  default_markup_pct: '20',
  xero_labour_account: '200',
  xero_licence_account: '200',
  xero_agreement_account: '200',
  xero_tax_type: 'OUTPUT',
  mail_poll_minutes: '2',
  pax8_sync_hours: '4',
  telegram_digest_hour: '8',
  follow_up_pre_nudge_minutes: '15',
  app_timezone: process.env.APP_TIMEZONE || 'Australia/Perth',
  ticket_auto_close_days: '0'
};
for (const [k, v] of Object.entries(defaults)) {
  if (getSetting(k) == null) setSetting(k, v);
}
