import { Router } from 'express';
import { db } from '../db.js';
import * as graph from '../integrations/graph.js';
import {
  TICKET_CATEGORIES,
  TICKET_STATUSES,
  PAGE_SIZE,
  LAST_ACTIVITY_SQL,
  IS_STALE_SQL,
  logTicketEvent,
  logTicketFieldChanges,
  allocateTicketNumber,
  parseTicketRef,
  formatTicketRef,
  findTicketByNumberOrId,
  isBillingResolved
} from '../ticket-utils.js';
import { todayIsoInTz, localInputToUtcSql } from '../dates.js';
import { mergeTickets } from '../ticket-merge.js';
import {
  listTicketAttachments,
  getAttachmentRecord,
  readAttachmentFile,
  formatFileSize,
  replyUpload,
  saveAttachment,
  MAX_ATTACHMENT_BYTES,
  MAX_REPLY_ATTACHMENTS
} from '../attachments.js';
import { stripHtml } from '../html-utils.js';

const r = Router();

function buildListQuery({ status, q, clientId, page }) {
  const conditions = [];
  const params = {};

  if (status === 'all') {
    /* no filter */
  } else if (status === 'active') {
    conditions.push("t.status != 'closed'");
  } else {
    conditions.push('t.status = @status');
    params.status = status;
  }

  if (clientId) {
    conditions.push('t.client_id = @clientId');
    params.clientId = clientId;
  }

  if (q) {
    const ticketNum = parseTicketRef(q);
    if (ticketNum != null) {
      conditions.push('(t.ticket_number = @ticketNumber OR t.id = @ticketNumber)');
      params.ticketNumber = ticketNum;
    } else {
      conditions.push(`(
        t.subject LIKE @qLike OR
        t.requester_email LIKE @qLike OR
        c.name LIKE @qLike
      )`);
      params.qLike = `%${q}%`;
    }
  }

  const where = conditions.length ? conditions.join(' AND ') : '1=1';
  const offset = (page - 1) * PAGE_SIZE;

  const count = db.prepare(`
    SELECT COUNT(*) AS n FROM tickets t
    LEFT JOIN clients c ON c.id = t.client_id
    WHERE ${where}
  `).get(params).n;

  const tickets = db.prepare(`
    SELECT t.*, c.name AS client_name,
      (SELECT COALESCE(SUM(minutes), 0) FROM time_entries te WHERE te.ticket_id = t.id) AS minutes,
      ${LAST_ACTIVITY_SQL} AS last_activity,
      ${IS_STALE_SQL} AS is_stale,
      CASE
        WHEN t.follow_up_at IS NOT NULL AND date(t.follow_up_at) < date(@today) AND t.status != 'closed' THEN 1
        ELSE 0
      END AS follow_up_overdue,
      CASE
        WHEN t.follow_up_at IS NOT NULL AND date(t.follow_up_at) = date(@today) AND t.status != 'closed' THEN 1
        ELSE 0
      END AS follow_up_today
    FROM tickets t
    LEFT JOIN clients c ON c.id = t.client_id
    WHERE ${where}
    ORDER BY
      CASE t.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
      CASE WHEN t.follow_up_at IS NOT NULL AND date(t.follow_up_at) <= date(@today) AND t.status != 'closed' THEN 0 ELSE 1 END,
      t.updated_at DESC
    LIMIT ${PAGE_SIZE} OFFSET ${offset}
  `).all({ ...params, today: todayIsoInTz() });

  return { tickets, count, totalPages: Math.max(1, Math.ceil(count / PAGE_SIZE)) };
}

r.get('/', (req, res) => {
  const status = req.query.status || 'active';
  const q = (req.query.q || '').trim();
  const clientId = req.query.client_id ? Number(req.query.client_id) : null;
  const page = Math.max(1, Number(req.query.page) || 1);
  const { tickets, count, totalPages } = buildListQuery({ status, q, clientId, page });
  const clients = db.prepare('SELECT id, name FROM clients WHERE active = 1 ORDER BY name').all();
  res.render('tickets', {
    title: 'Tickets',
    tickets,
    clients,
    status,
    q,
    clientId,
    page,
    totalPages,
    count,
    categories: TICKET_CATEGORIES,
    statuses: TICKET_STATUSES,
    listQuery: `status=${encodeURIComponent(status)}${q ? `&q=${encodeURIComponent(q)}` : ''}${clientId ? `&client_id=${clientId}` : ''}${page > 1 ? `&page=${page}` : ''}`
  });
});

function parseTicketIds(body) {
  return [...new Set([].concat(body.ids || []).map(Number).filter((n) => n > 0))];
}

function listRedirect(body) {
  const path = body.redirect?.trim();
  return path?.startsWith('/tickets') ? path : '/tickets';
}

r.post('/bulk', (req, res) => {
  const ids = parseTicketIds(req.body);
  const back = listRedirect(req.body);
  const sep = back.includes('?') ? '&' : '?';
  const action = req.body.action;

  if (!ids.length) {
    return res.redirect(`${back}${sep}flash=${encodeURIComponent('No tickets selected')}&kind=err`);
  }

  if (action === 'delete') {
    const canDelete = db.prepare(`
      SELECT id FROM tickets WHERE id = ?
        AND NOT EXISTS (SELECT 1 FROM time_entries WHERE ticket_id = ? AND invoiced_at IS NOT NULL)
    `);
    const del = db.prepare('DELETE FROM tickets WHERE id = ?');
    let deleted = 0;
    let skipped = 0;
    for (const id of ids) {
      if (!canDelete.get(id, id)) {
        skipped++;
        continue;
      }
      del.run(id);
      deleted++;
    }
    const msg = skipped
      ? `Deleted ${deleted} ticket(s). Skipped ${skipped} with invoiced time.`
      : `Deleted ${deleted} ticket(s).`;
    return res.redirect(`${back}${sep}flash=${encodeURIComponent(msg)}${skipped ? '&kind=err' : ''}`);
  }

  if (action === 'close') {
    const close = db.prepare("UPDATE tickets SET status = 'closed', updated_at = datetime('now') WHERE id = ?");
    let n = 0;
    let skipped = 0;
    for (const id of ids) {
      const t = db.prepare('SELECT * FROM tickets WHERE id = ?').get(id);
      if (!t || t.status === 'closed') continue;
      if (!isBillingResolved(t)) {
        skipped++;
        continue;
      }
      close.run(id);
      logTicketEvent(id, 'closed', 'Bulk close');
      n++;
    }
    const msg = skipped
      ? `Closed ${n} ticket(s). Skipped ${skipped} without billing (log time or mark not billable first).`
      : `Closed ${n} ticket(s).`;
    return res.redirect(`${back}${sep}flash=${encodeURIComponent(msg)}${skipped ? '&kind=err' : ''}`);
  }

  if (action === 'set_status') {
    const status = req.body.status;
    if (!TICKET_STATUSES.includes(status)) {
      return res.redirect(`${back}${sep}flash=${encodeURIComponent('Invalid status')}&kind=err`);
    }
    const update = db.prepare("UPDATE tickets SET status = ?, updated_at = datetime('now') WHERE id = ?");
    let n = 0;
    let skipped = 0;
    for (const id of ids) {
      const t = db.prepare('SELECT * FROM tickets WHERE id = ?').get(id);
      if (!t || t.status === status) continue;
      if (status === 'closed' && !isBillingResolved(t)) {
        skipped++;
        continue;
      }
      update.run(status, id);
      logTicketEvent(id, 'changed', `Bulk: ${t.status} → ${status}`);
      if (status === 'closed') logTicketEvent(id, 'closed', 'Bulk close');
      n++;
    }
    const msg = skipped
      ? `Updated ${n} ticket(s) to ${status.replace('_', ' ')}. Skipped ${skipped} without billing.`
      : `Updated ${n} ticket(s) to ${status.replace('_', ' ')}`;
    return res.redirect(`${back}${sep}flash=${encodeURIComponent(msg)}${skipped ? '&kind=err' : ''}`);
  }

  res.redirect(`${back}${sep}flash=${encodeURIComponent('Unknown action')}&kind=err`);
});

r.post('/', (req, res) => {
  const { client_id, subject, priority, body, category } = req.body;
  if (!subject?.trim()) return res.redirect('/tickets?flash=Subject is required&kind=err');
  const ticketNo = allocateTicketNumber();
  const info = db.prepare(`
    INSERT INTO tickets (ticket_number, client_id, subject, priority, category, source, status)
    VALUES (?, ?, ?, ?, ?, 'manual', 'open')
  `).run(
    ticketNo,
    client_id || null,
    subject.trim(),
    priority || 'normal',
    category || null
  );
  const ticketId = info.lastInsertRowid;
  logTicketEvent(ticketId, 'created', 'Manual ticket');
  if (body?.trim()) {
    db.prepare("INSERT INTO ticket_messages (ticket_id, direction, author, body) VALUES (?, 'note', 'me', ?)")
      .run(ticketId, body.trim());
  }
  res.redirect(`/tickets/${ticketId}`);
});

r.get('/:id/attachments/:attachmentId', (req, res) => {
  const record = getAttachmentRecord(req.params.id, req.params.attachmentId);
  if (!record) return res.status(404).send('Attachment not found');
  try {
    const data = readAttachmentFile(record);
    res.setHeader('Content-Type', record.content_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(record.filename)}"`);
    res.send(data);
  } catch {
    res.status(404).send('File missing on disk');
  }
});

r.get('/:id', (req, res) => {
  const ticket = db.prepare(`
    SELECT t.*, c.name AS client_name FROM tickets t
    LEFT JOIN clients c ON c.id = t.client_id WHERE t.id = ?
  `).get(req.params.id);
  if (!ticket) return res.status(404).send('Ticket not found');
  const messages = db.prepare('SELECT * FROM ticket_messages WHERE ticket_id = ? ORDER BY created_at').all(ticket.id);
  const time = db.prepare('SELECT * FROM time_entries WHERE ticket_id = ? ORDER BY worked_at DESC').all(ticket.id);
  const events = db.prepare('SELECT * FROM ticket_events WHERE ticket_id = ? ORDER BY created_at DESC LIMIT 30').all(ticket.id);
  const clients = db.prepare('SELECT id, name FROM clients WHERE active = 1 ORDER BY name').all();
  const contacts = ticket.client_id
    ? db.prepare('SELECT id, name, email FROM contacts WHERE client_id = ? ORDER BY name').all(ticket.client_id)
    : [];
  const contact = ticket.contact_id ? db.prepare('SELECT * FROM contacts WHERE id = ?').get(ticket.contact_id) : null;
  const mergeCandidates = db.prepare(`
    SELECT t.id, t.ticket_number, t.subject, t.status, c.name AS client_name
    FROM tickets t LEFT JOIN clients c ON c.id = t.client_id
    WHERE t.id != ? AND t.status != 'closed'
    ORDER BY t.updated_at DESC LIMIT 50
  `).all(ticket.id);

  const lastActivity = db.prepare(`
    SELECT
      COALESCE(
        (SELECT MAX(created_at) FROM ticket_messages tm WHERE tm.ticket_id = t.id),
        (SELECT MAX(worked_at) FROM time_entries te WHERE te.ticket_id = t.id),
        t.updated_at
      ) AS last_activity,
      CASE
        WHEN t.status != 'closed'
          AND julianday('now') - julianday(COALESCE(
            (SELECT MAX(created_at) FROM ticket_messages tm WHERE tm.ticket_id = t.id),
            (SELECT MAX(worked_at) FROM time_entries te WHERE te.ticket_id = t.id),
            t.updated_at
          )) >= 7
        THEN 1 ELSE 0
      END AS is_stale
    FROM tickets t WHERE t.id = ?
  `).get(ticket.id);

  const attachments = listTicketAttachments(ticket.id);
  const attachmentsByMessage = {};
  for (const a of attachments) {
    if (a.message_id) (attachmentsByMessage[a.message_id] ||= []).push(a);
  }

  res.render('ticket', {
    title: formatTicketRef(ticket),
    ticket,
    messages,
    attachments,
    attachmentsByMessage,
    formatFileSize,
    time,
    events,
    clients,
    contacts,
    contact,
    mergeCandidates,
    categories: TICKET_CATEGORIES,
    statuses: TICKET_STATUSES,
    totalMinutes: time.reduce((s, t) => s + t.minutes, 0),
    mailReady: graph.graphConfigured(),
    replyTo: ticket.requester_email || contact?.email || '',
    isStale: Boolean(lastActivity?.is_stale),
    lastActivity: lastActivity?.last_activity,
    billingResolved: isBillingResolved(ticket)
  });
});

function closeTicket(ticket, detail = 'Closed via web UI') {
  db.prepare("UPDATE tickets SET status = 'closed', updated_at = datetime('now') WHERE id = ?").run(ticket.id);
  logTicketEvent(ticket.id, 'closed', detail);
}

r.post('/:id/close', (req, res) => {
  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(req.params.id);
  if (!ticket) return res.status(404).send('Ticket not found');
  if (ticket.status === 'closed') {
    return res.redirect(`/tickets/${ticket.id}?flash=Ticket is already closed&kind=err`);
  }

  const mode = req.body.mode || 'close';

  if (mode === 'log_and_close') {
    const mins = Number(req.body.minutes);
    if (!ticket.client_id) {
      return res.redirect(`/tickets/${ticket.id}?flash=Assign the ticket to a client before logging time&kind=err`);
    }
    if (!mins || mins <= 0) {
      return res.redirect(`/tickets/${ticket.id}?flash=Minutes must be a positive number&kind=err`);
    }
    db.prepare(`
      INSERT INTO time_entries (ticket_id, client_id, minutes, description, billable, rate_override)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      ticket.id,
      ticket.client_id,
      mins,
      req.body.description?.trim() || null,
      req.body.billable ? 1 : 0,
      req.body.rate_override ? Number(req.body.rate_override) : null
    );
    closeTicket(ticket, 'Closed after logging time');
    return res.redirect(`/tickets/${ticket.id}?flash=Time logged and ticket closed`);
  }

  if (mode === 'not_billable') {
    if (!ticket.client_id) {
      return res.redirect(`/tickets/${ticket.id}?flash=Assign a client or close without billing&kind=err`);
    }
    db.prepare("UPDATE tickets SET billing_status = 'not_billable', updated_at = datetime('now') WHERE id = ?").run(ticket.id);
    logTicketEvent(ticket.id, 'changed', 'Marked not billable');
    closeTicket(ticket, 'Closed — not billable');
    return res.redirect(`/tickets/${ticket.id}?flash=Ticket marked not billable and closed`);
  }

  if (!isBillingResolved(ticket)) {
    return res.redirect(`/tickets/${ticket.id}?flash=Log time or mark not billable before closing&kind=err`);
  }

  closeTicket(ticket);
  res.redirect(`/tickets/${ticket.id}?flash=Ticket closed`);
});

r.post('/:id/update', (req, res) => {
  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(req.params.id);
  if (!ticket) return res.status(404).send('Ticket not found');

  const status = TICKET_STATUSES.includes(req.body.status) ? req.body.status : ticket.status;
  const priority = ['low', 'normal', 'high', 'critical'].includes(req.body.priority) ? req.body.priority : ticket.priority;
  const client_id = req.body.client_id ? Number(req.body.client_id) : null;
  const contact_id = req.body.contact_id ? Number(req.body.contact_id) : null;
  const subject = req.body.subject?.trim() || ticket.subject;
  const category = req.body.category || null;
  const follow_up_at = localInputToUtcSql(req.body.follow_up_at) || null;
  const followUpChanged = follow_up_at !== ticket.follow_up_at;

  if (contact_id && client_id) {
    const contact = db.prepare('SELECT client_id FROM contacts WHERE id = ?').get(contact_id);
    if (!contact || contact.client_id !== client_id) {
      return res.redirect(`/tickets/${req.params.id}?flash=Contact does not belong to selected client&kind=err`);
    }
  }

  logTicketFieldChanges(ticket.id, ticket, {
    status,
    priority,
    client_id,
    contact_id: client_id ? contact_id : null,
    subject,
    category,
    follow_up_at
  });

  const effectiveClientId = client_id ?? ticket.client_id;
  if (status === 'closed' && ticket.status !== 'closed') {
    const forBilling = { ...ticket, client_id: effectiveClientId };
    if (!isBillingResolved(forBilling)) {
      return res.redirect(`/tickets/${ticket.id}?flash=Log time or mark not billable before closing&kind=err`);
    }
  }

  db.prepare(`
    UPDATE tickets SET
      status = ?, priority = ?, client_id = ?, contact_id = ?,
      subject = ?, category = ?, follow_up_at = ?,
      follow_up_nudge = CASE WHEN ? THEN NULL ELSE follow_up_nudge END,
      updated_at = datetime('now')
    WHERE id = ?
  `).run(
    status,
    priority,
    client_id,
    client_id ? contact_id : null,
    subject,
    category,
    follow_up_at,
    followUpChanged ? 1 : 0,
    ticket.id
  );

  if (status === 'closed' && ticket.status !== 'closed') {
    logTicketEvent(ticket.id, 'closed', 'Closed via web UI');
  }

  res.redirect(`/tickets/${ticket.id}?flash=Ticket updated`);
});

r.post('/:id/note', (req, res) => {
  if (req.body.body?.trim()) {
    db.prepare("INSERT INTO ticket_messages (ticket_id, direction, author, body) VALUES (?, 'note', 'me', ?)")
      .run(req.params.id, req.body.body.trim());
    db.prepare("UPDATE tickets SET updated_at = datetime('now') WHERE id = ?").run(req.params.id);
    logTicketEvent(req.params.id, 'note', 'Internal note added');
  }
  res.redirect(`/tickets/${req.params.id}`);
});

r.post('/:id/reply', (req, res, next) => {
  replyUpload.array('attachments', MAX_REPLY_ATTACHMENTS)(req, res, (err) => {
    if (err) {
      return res.redirect(`/tickets/${req.params.id}?flash=${encodeURIComponent(err.message)}&kind=err`);
    }
    next();
  });
}, async (req, res) => {
  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(req.params.id);
  const { to, cc, bcc, body } = req.body;
  const files = req.files || [];
  const bodyHtml = body?.trim() || '';
  const bodyText = stripHtml(bodyHtml);
  if (!ticket || !to?.trim() || !bodyText) {
    return res.redirect(`/tickets/${req.params.id}?flash=Reply needs a recipient and a message&kind=err`);
  }
  if (files.some((f) => f.size > MAX_ATTACHMENT_BYTES)) {
    return res.redirect(`/tickets/${req.params.id}?flash=Each attachment must be 15 MB or less&kind=err`);
  }
  try {
    const sent = await graph.sendReply(ticket, {
      to: to.trim(),
      cc,
      bcc,
      body: bodyHtml,
      attachments: files
    });
    const htmlBody = sent.htmlBody;
    const plainBody = stripHtml(htmlBody);
    const msgInfo = db.prepare(`
      INSERT INTO ticket_messages (ticket_id, direction, author, body, body_html, cc, bcc)
      VALUES (?, 'out', 'me', ?, ?, ?, ?)
    `).run(ticket.id, plainBody, htmlBody, sent.cc || null, sent.bcc || null);
    for (const file of files) {
      saveAttachment({
        ticketId: ticket.id,
        messageId: msgInfo.lastInsertRowid,
        filename: file.originalname,
        contentType: file.mimetype,
        buffer: file.buffer
      });
    }
    db.prepare("UPDATE tickets SET status = 'waiting', updated_at = datetime('now') WHERE id = ?").run(ticket.id);
    if (ticket.status !== 'waiting') {
      logTicketEvent(ticket.id, 'changed', `Status: ${ticket.status} → waiting`);
    }
    const recip = [to.trim(), sent.cc, sent.bcc].filter(Boolean).join(' · ');
    const attNote = files.length ? ` · ${files.length} attachment(s)` : '';
    logTicketEvent(ticket.id, 'reply', `Email sent to ${recip}${attNote}`);
    res.redirect(`/tickets/${ticket.id}?flash=Reply sent`);
  } catch (err) {
    res.redirect(`/tickets/${ticket.id}?flash=${encodeURIComponent('Send failed: ' + err.message)}&kind=err`);
  }
});

r.post('/:id/merge', (req, res) => {
  const primaryId = Number(req.params.id);
  const ref = req.body.merge_ref?.trim();
  if (!ref) {
    return res.redirect(`/tickets/${primaryId}?flash=Enter a ticket ref to merge&kind=err`);
  }
  const secondary = findTicketByNumberOrId(parseTicketRef(ref) ?? ref);
  if (!secondary) {
    return res.redirect(`/tickets/${primaryId}?flash=Ticket not found&kind=err`);
  }
  try {
    mergeTickets(primaryId, secondary.id);
    res.redirect(`/tickets/${primaryId}?flash=Merged ${formatTicketRef(secondary)} into this ticket`);
  } catch (err) {
    res.redirect(`/tickets/${primaryId}?flash=${encodeURIComponent(err.message)}&kind=err`);
  }
});

r.post('/:id/time', (req, res) => {
  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(req.params.id);
  const { minutes, description, billable, rate_override } = req.body;
  const mins = Number(minutes);
  if (!ticket?.client_id) {
    return res.redirect(`/tickets/${req.params.id}?flash=Assign the ticket to a client before logging time&kind=err`);
  }
  if (!mins || mins <= 0) {
    return res.redirect(`/tickets/${req.params.id}?flash=Minutes must be a positive number&kind=err`);
  }
  db.prepare(`
    INSERT INTO time_entries (ticket_id, client_id, minutes, description, billable, rate_override)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    ticket.id, ticket.client_id, mins, description?.trim() || null, billable ? 1 : 0,
    rate_override ? Number(rate_override) : null
  );
  db.prepare("UPDATE tickets SET updated_at = datetime('now') WHERE id = ?").run(ticket.id);
  res.redirect(`/tickets/${ticket.id}?flash=Time logged`);
});

r.post('/:id/time/:entryId', (req, res) => {
  const ticket = db.prepare('SELECT id FROM tickets WHERE id = ?').get(req.params.id);
  if (!ticket) return res.status(404).send('Ticket not found');
  const entry = db.prepare(
    'SELECT * FROM time_entries WHERE id = ? AND ticket_id = ? AND invoiced_at IS NULL'
  ).get(req.params.entryId, req.params.id);
  if (!entry) {
    return res.redirect(`/tickets/${req.params.id}?flash=Time entry not found or already invoiced&kind=err`);
  }
  const mins = Number(req.body.minutes);
  const description = String(req.body.description || '').trim();
  if (!mins || mins <= 0) {
    return res.redirect(`/tickets/${req.params.id}?flash=Minutes must be a positive number&kind=err`);
  }
  db.prepare(`
    UPDATE time_entries
    SET minutes = ?, description = ?, billable = ?, rate_override = ?
    WHERE id = ?
  `).run(
    mins,
    description || null,
    req.body.billable ? 1 : 0,
    req.body.rate_override ? Number(req.body.rate_override) : null,
    entry.id
  );
  db.prepare("UPDATE tickets SET updated_at = datetime('now') WHERE id = ?").run(ticket.id);
  res.redirect(`/tickets/${req.params.id}?flash=Time entry saved`);
});

r.post('/:id/time/:entryId/delete', (req, res) => {
  db.prepare('DELETE FROM time_entries WHERE id = ? AND ticket_id = ? AND invoiced_at IS NULL')
    .run(req.params.entryId, req.params.id);
  res.redirect(`/tickets/${req.params.id}?flash=Time entry removed`);
});

export default r;
