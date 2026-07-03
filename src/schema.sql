-- Solo PSA schema (SQLite)

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS clients (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL,
  xero_contact_id TEXT,
  pax8_company_id TEXT,
  agreement_name  TEXT,            -- e.g. "Managed Essentials"
  monthly_fee     REAL DEFAULT 0,  -- flat agreement fee (ex GST)
  hourly_rate     REAL,            -- NULL = use default from settings
  bill_pax8       INTEGER DEFAULT 1,
  notes           TEXT,
  active          INTEGER DEFAULT 1,
  created_at      TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS contacts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id  INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  email      TEXT,
  phone      TEXT,
  is_primary INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_contacts_email ON contacts(email);

CREATE TABLE IF NOT EXISTS tickets (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_number   INTEGER UNIQUE,                 -- display ref TKT-00050 (starts at 50)
  client_id       INTEGER REFERENCES clients(id) ON DELETE SET NULL,
  contact_id      INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
  subject         TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'open',   -- open | in_progress | waiting | closed
  priority        TEXT NOT NULL DEFAULT 'normal', -- low | normal | high | critical
  category        TEXT,                           -- Network | M365 | Hardware | Security | Billing | Other
  source          TEXT NOT NULL DEFAULT 'manual', -- manual | email
  requester_email TEXT,
  conversation_id TEXT,                           -- Graph conversationId for threading
  follow_up_at    TEXT,                           -- optional reminder, UTC datetime (legacy rows may be date-only)
  follow_up_nudge TEXT,                           -- Telegram nudge stage: NULL | pre (15-min warning sent) | due
  billing_status  TEXT,                           -- not_billable when explicitly marked (time entries also resolve billing)
  created_at      TEXT DEFAULT (datetime('now')),
  updated_at      TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);
CREATE INDEX IF NOT EXISTS idx_tickets_conversation ON tickets(conversation_id);
CREATE INDEX IF NOT EXISTS idx_tickets_client ON tickets(client_id);
CREATE INDEX IF NOT EXISTS idx_tickets_follow_up ON tickets(follow_up_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tickets_number ON tickets(ticket_number);

CREATE TABLE IF NOT EXISTS ticket_messages (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id        INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  direction        TEXT NOT NULL,   -- in | out | note
  author           TEXT,
  body             TEXT,            -- plain-text fallback / search
  body_html        TEXT,            -- sanitized HTML when available
  cc               TEXT,            -- comma-separated (outbound)
  bcc              TEXT,            -- comma-separated (outbound)
  graph_message_id TEXT,
  created_at       TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_ticket ON ticket_messages(ticket_id);

CREATE TABLE IF NOT EXISTS ticket_attachments (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id           INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  message_id          INTEGER REFERENCES ticket_messages(id) ON DELETE CASCADE,
  filename            TEXT NOT NULL,
  content_type        TEXT,
  size_bytes          INTEGER,
  storage_path        TEXT NOT NULL,
  graph_attachment_id TEXT,
  created_at          TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_attachments_ticket ON ticket_attachments(ticket_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_attachments_graph ON ticket_attachments(graph_attachment_id, message_id);

CREATE TABLE IF NOT EXISTS ticket_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id  INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  action     TEXT NOT NULL,   -- created | changed | note | reply | closed | auto_closed
  detail     TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ticket_events_ticket ON ticket_events(ticket_id);

CREATE TABLE IF NOT EXISTS time_entries (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id     INTEGER REFERENCES tickets(id) ON DELETE SET NULL,
  client_id     INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  minutes       INTEGER NOT NULL,
  description   TEXT,
  billable      INTEGER DEFAULT 1,
  rate_override REAL,              -- NULL = client rate, else default rate
  worked_at     TEXT DEFAULT (datetime('now')),
  invoiced_at   TEXT               -- set when pushed to a Xero draft
);
CREATE INDEX IF NOT EXISTS idx_time_client ON time_entries(client_id, invoiced_at);

CREATE TABLE IF NOT EXISTS manual_charges (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id    INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  description  TEXT NOT NULL,
  quantity     REAL NOT NULL DEFAULT 1,
  unit_amount  REAL NOT NULL,
  account_code TEXT,
  created_at   TEXT DEFAULT (datetime('now')),
  invoiced_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_manual_charges_client ON manual_charges(client_id, invoiced_at);

-- Manually-managed recurring services (hosting, backup, domains, …), billed like subscriptions
CREATE TABLE IF NOT EXISTS recurring_services (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id   INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT,                        -- optional extra invoice line text
  quantity    REAL NOT NULL DEFAULT 1,
  cost_price  REAL DEFAULT 0,              -- per unit ex GST (margin reporting only)
  sell_price  REAL NOT NULL,               -- per unit ex GST
  months      INTEGER NOT NULL DEFAULT 1,  -- 1 = monthly, 12 = annual
  bill_month  INTEGER,                     -- 1-12 renewal month when months > 1
  active      INTEGER DEFAULT 1,
  created_at  TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_services_client ON recurring_services(client_id, active);

CREATE TABLE IF NOT EXISTS pax8_products (
  id         TEXT PRIMARY KEY,     -- Pax8 productId
  name       TEXT,
  vendor     TEXT,
  buy_price  REAL,                 -- partner buy rate (partnerBuyRate from Pax8 pricing API)
  sell_price REAL                  -- sell price; synced from Pax8 RRP, or manual override
);

CREATE TABLE IF NOT EXISTS pax8_subscriptions (
  id            TEXT PRIMARY KEY,  -- Pax8 subscriptionId
  client_id     INTEGER REFERENCES clients(id) ON DELETE SET NULL,
  pax8_company_id TEXT,
  product_id    TEXT REFERENCES pax8_products(id),
  quantity      REAL DEFAULT 0,
  buy_price     REAL,
  billing_term  TEXT,              -- Pax8 invoicing cadence: Monthly | Annual | 2-Year | 3-Year | One-Time | Trial | Activation
  status        TEXT,
  start_date    TEXT,
  billing_start TEXT,
  end_date      TEXT,
  commitment_term TEXT,            -- e.g. Microsoft NCE commitment (annual commit billed monthly)
  bill_mode     TEXT DEFAULT 'auto', -- auto | monthly | annual | skip (manual billing override)
  bill_month    INTEGER,           -- 1-12 renewal month override for annual/multi-year terms
  synced_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_subs_client ON pax8_subscriptions(client_id);

CREATE TABLE IF NOT EXISTS pax8_companies (
  id        TEXT PRIMARY KEY,
  name      TEXT,
  synced_at TEXT
);

CREATE TABLE IF NOT EXISTS pax8_prorata_items (
  id              TEXT PRIMARY KEY,
  pax8_company_id TEXT NOT NULL,
  client_id       INTEGER REFERENCES clients(id) ON DELETE SET NULL,
  product_id      TEXT,
  description     TEXT NOT NULL,
  quantity        REAL DEFAULT 1,
  buy_amount      REAL NOT NULL,
  sell_amount     REAL,
  item_type       TEXT,
  billing_period  TEXT NOT NULL,
  synced_at       TEXT,
  invoiced_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_prorata_client ON pax8_prorata_items(client_id, invoiced_at);
CREATE INDEX IF NOT EXISTS idx_prorata_period ON pax8_prorata_items(billing_period, invoiced_at);

CREATE TABLE IF NOT EXISTS job_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  job        TEXT NOT NULL,       -- mail | pax8
  ok         INTEGER NOT NULL,
  detail     TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_job_log_recent ON job_log(id DESC);

CREATE TABLE IF NOT EXISTS invoices (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id       INTEGER NOT NULL REFERENCES clients(id),
  period          TEXT NOT NULL,   -- YYYY-MM
  xero_invoice_id TEXT,
  xero_number     TEXT,
  total           REAL,
  status          TEXT DEFAULT 'draft',
  amount_due      REAL,
  invoice_date    TEXT,
  status_synced_at TEXT,
  created_at      TEXT DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_invoice_period ON invoices(client_id, period);
