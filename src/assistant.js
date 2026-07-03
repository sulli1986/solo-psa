// Natural-language assistant shared by the web chat widget and Telegram.
// Claude (tool use) translates free English into PSA actions: tickets, time,
// charges, recurring services, billing summaries. Requires ANTHROPIC_API_KEY.
import Anthropic from '@anthropic-ai/sdk';
import { db, getSetting, getNumberSetting } from './db.js';
import { buildRun, billableMinutes, mrrByClient, outstandingReceivables } from './billing.js';
import { logTicketEvent, allocateTicketNumber, findTicketByNumberOrId, formatTicketRef, isBillingResolved } from './ticket-utils.js';

export function assistantConfigured() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

const SYSTEM = `You are the assistant inside "Solo PSA", the practice-management app of a one-person Australian MSP (managed service provider). You act on the operator's behalf by calling tools — creating tickets, logging time, adding invoice charges, and answering questions about clients and billing.

Rules:
- All amounts are AUD ex GST. Time is logged in minutes; invoiced labour rounds up to 15-minute blocks.
- Resolve client names with list_clients before acting — never guess a client_id. If a name matches more than one client, ask which one.
- "Bill/charge/invoice X dollars" → add_charge (a one-off invoice line). "Bill/charge N hours or minutes of work" → log_time. Recurring amounts ("every month", "hosting", "per year") → add_recurring_service.
- If something essential is missing (client, amount, subject), ask one short question. Otherwise act immediately and confirm what you did, including the reference (TKT-00051, charge #12) so the operator can find it.
- Keep replies short and conversational — they render in Telegram or a small chat panel. Plain text only: no markdown tables, headers or code blocks.
- Never invent data. If a tool returns an error, relay it plainly and suggest the fix.`;

const TOOLS = [
  {
    name: 'list_clients',
    description: 'List all active clients with ids, agreement info and monthly recurring revenue. Call this to resolve a client name mentioned by the operator into a client_id.',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'get_client_summary',
    description: 'Full picture of one client: agreement, MRR, unbilled time and charges, open tickets, contacts.',
    input_schema: {
      type: 'object',
      properties: { client_id: { type: 'integer' } },
      required: ['client_id']
    }
  },
  {
    name: 'list_tickets',
    description: 'List tickets, optionally filtered. Call this when the operator asks what is open, mentions a ticket by subject, or before updating a ticket whose number you do not know.',
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['open', 'in_progress', 'waiting', 'closed', 'active'], description: '"active" = everything not closed (default)' },
        client_id: { type: 'integer' },
        search: { type: 'string', description: 'Substring match on the subject' }
      }
    }
  },
  {
    name: 'create_ticket',
    description: 'Create a new ticket. client_id optional (unassigned ticket).',
    input_schema: {
      type: 'object',
      properties: {
        subject: { type: 'string' },
        client_id: { type: 'integer' },
        priority: { type: 'string', enum: ['low', 'normal', 'high', 'critical'] },
        description: { type: 'string', description: 'Optional initial internal note' }
      },
      required: ['subject']
    }
  },
  {
    name: 'update_ticket',
    description: 'Change a ticket status and/or priority by ticket number. Closing requires billing to be resolved (time logged or marked non-billable).',
    input_schema: {
      type: 'object',
      properties: {
        ticket_number: { type: 'integer' },
        status: { type: 'string', enum: ['open', 'in_progress', 'waiting', 'closed'] },
        priority: { type: 'string', enum: ['low', 'normal', 'high', 'critical'] }
      },
      required: ['ticket_number']
    }
  },
  {
    name: 'add_ticket_note',
    description: 'Add an internal note to a ticket (never emailed to the client).',
    input_schema: {
      type: 'object',
      properties: {
        ticket_number: { type: 'integer' },
        note: { type: 'string' }
      },
      required: ['ticket_number', 'note']
    }
  },
  {
    name: 'log_time',
    description: 'Log work time (billable by default). Attach to a ticket by ticket_number, or directly to a client with client_id. One of the two is required.',
    input_schema: {
      type: 'object',
      properties: {
        minutes: { type: 'integer', description: 'Minutes worked (convert hours to minutes)' },
        description: { type: 'string', description: 'What was done — appears on the invoice' },
        ticket_number: { type: 'integer' },
        client_id: { type: 'integer' },
        billable: { type: 'boolean', description: 'Default true' }
      },
      required: ['minutes', 'description']
    }
  },
  {
    name: 'add_charge',
    description: 'Add a one-off manual invoice line (fixed dollar amount, ex GST) for a client. It is billed on the next invoice run.',
    input_schema: {
      type: 'object',
      properties: {
        client_id: { type: 'integer' },
        description: { type: 'string', description: 'Line text as it should appear on the Xero invoice' },
        amount: { type: 'number', description: 'Ex-GST amount in AUD' }
      },
      required: ['client_id', 'description', 'amount']
    }
  },
  {
    name: 'add_recurring_service',
    description: 'Add a recurring service (hosting, backup, domain…) billed monthly or annually. Prices are per unit ex GST.',
    input_schema: {
      type: 'object',
      properties: {
        client_id: { type: 'integer' },
        name: { type: 'string' },
        sell_price: { type: 'number' },
        cost_price: { type: 'number', description: 'Your cost, for margin tracking (default 0)' },
        quantity: { type: 'number', description: 'Default 1' },
        months: { type: 'integer', enum: [1, 12], description: '1 = monthly (default), 12 = annual' },
        bill_month: { type: 'integer', description: 'Renewal month 1-12, required when months = 12' },
        description: { type: 'string', description: 'Optional extra invoice line text' }
      },
      required: ['client_id', 'name', 'sell_price']
    }
  },
  {
    name: 'billing_summary',
    description: 'Billing overview: what is ready to bill this period per client, total MRR, and outstanding unpaid invoices.',
    input_schema: {
      type: 'object',
      properties: { period: { type: 'string', description: 'YYYY-MM, defaults to the current month' } }
    }
  }
];

function requireClient(clientId) {
  const client = db.prepare('SELECT * FROM clients WHERE id = ? AND active = 1').get(clientId);
  if (!client) throw new Error(`No active client with id ${clientId} — use list_clients`);
  return client;
}

function requireTicket(ticketNumber) {
  const ticket = findTicketByNumberOrId(ticketNumber);
  if (!ticket) throw new Error(`No ticket ${formatTicketRef(ticketNumber)}`);
  return ticket;
}

const executors = {
  list_clients() {
    const mrr = mrrByClient();
    return db.prepare('SELECT id, name, agreement_name, monthly_fee, hourly_rate FROM clients WHERE active = 1 ORDER BY name')
      .all()
      .map((c) => ({ ...c, mrr: Math.round((mrr.get(c.id) ?? 0) * 100) / 100 }));
  },

  get_client_summary({ client_id }) {
    const client = requireClient(client_id);
    const unbilledMinutes = db.prepare(
      'SELECT COALESCE(SUM(minutes),0) AS m FROM time_entries WHERE client_id = ? AND billable = 1 AND invoiced_at IS NULL'
    ).get(client.id).m;
    const charges = db.prepare(
      'SELECT id, description, unit_amount FROM manual_charges WHERE client_id = ? AND invoiced_at IS NULL'
    ).all(client.id);
    const services = db.prepare(
      'SELECT id, name, quantity, sell_price, months, active FROM recurring_services WHERE client_id = ?'
    ).all(client.id);
    const openTickets = db.prepare(
      "SELECT ticket_number, subject, status, priority FROM tickets WHERE client_id = ? AND status != 'closed' ORDER BY updated_at DESC"
    ).all(client.id).map((t) => ({ ...t, ref: formatTicketRef(t) }));
    const contacts = db.prepare('SELECT name, email, phone, is_primary FROM contacts WHERE client_id = ?').all(client.id);
    return {
      id: client.id,
      name: client.name,
      agreement: client.agreement_name,
      monthly_fee: client.monthly_fee,
      hourly_rate: client.hourly_rate ?? getNumberSetting('default_hourly_rate', 150),
      mrr: Math.round((mrrByClient().get(client.id) ?? 0) * 100) / 100,
      unbilled_minutes: unbilledMinutes,
      unbilled_manual_charges: charges,
      recurring_services: services,
      open_tickets: openTickets,
      contacts
    };
  },

  list_tickets({ status = 'active', client_id, search } = {}) {
    const where = [];
    const params = [];
    if (status === 'active') where.push("t.status != 'closed'");
    else if (status) { where.push('t.status = ?'); params.push(status); }
    if (client_id) { where.push('t.client_id = ?'); params.push(client_id); }
    if (search) { where.push('t.subject LIKE ?'); params.push(`%${search}%`); }
    return db.prepare(`
      SELECT t.ticket_number, t.subject, t.status, t.priority, c.name AS client
      FROM tickets t LEFT JOIN clients c ON c.id = t.client_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY t.updated_at DESC LIMIT 25
    `).all(...params).map((t) => ({ ...t, ref: formatTicketRef(t) }));
  },

  create_ticket({ subject, client_id, priority, description }) {
    if (!subject?.trim()) throw new Error('Subject is required');
    if (client_id) requireClient(client_id);
    const ticketNo = allocateTicketNumber();
    const info = db.prepare(
      "INSERT INTO tickets (ticket_number, client_id, subject, priority, source, status) VALUES (?, ?, ?, ?, 'manual', 'open')"
    ).run(ticketNo, client_id ?? null, subject.trim(), priority || 'normal');
    logTicketEvent(info.lastInsertRowid, 'created', 'Created via assistant');
    if (description?.trim()) {
      db.prepare("INSERT INTO ticket_messages (ticket_id, direction, author, body) VALUES (?, 'note', 'assistant', ?)")
        .run(info.lastInsertRowid, description.trim());
    }
    return { ref: formatTicketRef(ticketNo), ticket_number: ticketNo };
  },

  update_ticket({ ticket_number, status, priority }) {
    const ticket = requireTicket(ticket_number);
    if (status === 'closed' && !isBillingResolved(ticket)) {
      throw new Error(`${formatTicketRef(ticket)} has unresolved billing — log time first or mark it non-billable in the web UI`);
    }
    if (status) {
      db.prepare("UPDATE tickets SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, ticket.id);
      logTicketEvent(ticket.id, status === 'closed' ? 'closed' : 'changed', `Status: ${ticket.status} → ${status} (assistant)`);
    }
    if (priority) {
      db.prepare("UPDATE tickets SET priority = ?, updated_at = datetime('now') WHERE id = ?").run(priority, ticket.id);
      logTicketEvent(ticket.id, 'changed', `Priority: ${ticket.priority} → ${priority} (assistant)`);
    }
    return { ref: formatTicketRef(ticket), status: status || ticket.status, priority: priority || ticket.priority };
  },

  add_ticket_note({ ticket_number, note }) {
    const ticket = requireTicket(ticket_number);
    if (!note?.trim()) throw new Error('Note text is required');
    db.prepare("INSERT INTO ticket_messages (ticket_id, direction, author, body) VALUES (?, 'note', 'assistant', ?)")
      .run(ticket.id, note.trim());
    db.prepare("UPDATE tickets SET updated_at = datetime('now') WHERE id = ?").run(ticket.id);
    return { ref: formatTicketRef(ticket), noted: true };
  },

  log_time({ minutes, description, ticket_number, client_id, billable = true }) {
    const mins = Number(minutes);
    if (!mins || mins <= 0) throw new Error('Minutes must be a positive number');
    let ticket = null;
    let clientId = client_id ?? null;
    if (ticket_number) {
      ticket = requireTicket(ticket_number);
      clientId = ticket.client_id ?? clientId;
    }
    if (!clientId) throw new Error('Provide a client_id or a ticket_number that has a client assigned');
    const client = requireClient(clientId);
    db.prepare(
      'INSERT INTO time_entries (ticket_id, client_id, minutes, description, billable) VALUES (?, ?, ?, ?, ?)'
    ).run(ticket?.id ?? null, client.id, mins, description?.trim() || null, billable ? 1 : 0);
    if (ticket) db.prepare("UPDATE tickets SET updated_at = datetime('now') WHERE id = ?").run(ticket.id);
    const billed = billableMinutes(mins);
    const rate = client.hourly_rate ?? getNumberSetting('default_hourly_rate', 150);
    return {
      client: client.name,
      minutes_logged: mins,
      minutes_billed: billable ? billed : 0,
      estimated_value_ex_gst: billable ? Math.round((billed / 60) * rate * 100) / 100 : 0,
      ticket: ticket ? formatTicketRef(ticket) : null
    };
  },

  add_charge({ client_id, description, amount }) {
    const client = requireClient(client_id);
    const amt = Number(amount);
    if (!description?.trim()) throw new Error('Description is required');
    if (!amt || amt <= 0) throw new Error('Amount must be a positive number');
    const info = db.prepare(
      'INSERT INTO manual_charges (client_id, description, quantity, unit_amount) VALUES (?, ?, 1, ?)'
    ).run(client.id, description.trim(), amt);
    return { charge_id: info.lastInsertRowid, client: client.name, amount_ex_gst: amt };
  },

  add_recurring_service({ client_id, name, sell_price, cost_price = 0, quantity = 1, months = 1, bill_month, description }) {
    const client = requireClient(client_id);
    if (!name?.trim()) throw new Error('Service name is required');
    if (!(Number(sell_price) > 0)) throw new Error('Sell price must be positive');
    const m = months === 12 ? 12 : 1;
    const bm = Number(bill_month);
    if (m === 12 && !(bm >= 1 && bm <= 12)) throw new Error('Annual services need bill_month (1-12) — ask which month it renews');
    const info = db.prepare(`
      INSERT INTO recurring_services (client_id, name, description, quantity, cost_price, sell_price, months, bill_month)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(client.id, name.trim(), description?.trim() || null, Number(quantity) > 0 ? Number(quantity) : 1,
      Number(cost_price) >= 0 ? Number(cost_price) : 0, Number(sell_price), m, m === 12 ? bm : null);
    return { service_id: info.lastInsertRowid, client: client.name, billing: m === 1 ? 'monthly' : `annual (renews month ${bm})` };
  },

  billing_summary({ period } = {}) {
    const p = /^\d{4}-\d{2}$/.test(period || '') ? period : new Date().toISOString().slice(0, 7);
    const run = buildRun(p);
    const pending = run.items.filter((i) => !i.alreadyInvoiced).map((i) => ({
      client: i.client.name,
      total_ex_gst: Math.round(i.total * 100) / 100,
      lines: i.lines.length
    }));
    const mrrTotal = [...mrrByClient().values()].reduce((s, v) => s + v, 0);
    const outstanding = outstandingReceivables();
    return {
      period: p,
      ready_to_bill: pending,
      ready_total_ex_gst: Math.round(pending.reduce((s, i) => s + i.total_ex_gst, 0) * 100) / 100,
      monthly_recurring_revenue: Math.round(mrrTotal * 100) / 100,
      outstanding_unpaid: { total: outstanding.due, invoices: outstanding.n },
      needs_attention: run.attention.map((a) => `${a.clientName}: ${a.productName} (${a.billingTerm}) has no renewal month`)
    };
  }
};

// Execute one turn of conversation. `history` is [{role, content: string}] with the
// latest user message last. Returns { reply, actions } — actions lists the tools run.
export async function runAssistant(history) {
  if (!assistantConfigured()) throw new Error('Assistant not configured — set ANTHROPIC_API_KEY in .env');
  const client = new Anthropic();
  const model = getSetting('assistant_model', 'claude-opus-4-8');
  const messages = history.map((m) => ({ role: m.role, content: m.content }));
  const actions = [];

  for (let step = 0; step < 8; step++) {
    const response = await client.messages.create({
      model,
      max_tokens: 4096,
      system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
      tools: TOOLS,
      messages
    });

    if (response.stop_reason === 'tool_use') {
      messages.push({ role: 'assistant', content: response.content });
      const results = [];
      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;
        let result;
        try {
          const fn = executors[block.name];
          if (!fn) throw new Error(`Unknown tool ${block.name}`);
          result = fn(block.input || {});
          actions.push(block.name);
          results.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result ?? {}) });
        } catch (err) {
          results.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify({ error: err.message }), is_error: true });
        }
      }
      messages.push({ role: 'user', content: results });
      continue;
    }

    const reply = response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    return { reply: reply || 'Done.', actions };
  }
  return { reply: 'That took too many steps — try a more specific request.', actions };
}
