// Microsoft Graph (app-only): poll a support mailbox into tickets, send replies.
// Requires an Entra app registration with application permissions:
//   Mail.ReadWrite, Mail.Send (admin consented), ideally scoped to the support
//   mailbox with an ApplicationAccessPolicy in Exchange Online.
import { db } from '../db.js';
import { logTicketEvent, allocateTicketNumber, formatTicketRef } from '../ticket-utils.js';
import { sanitizeHtml, prepareOutboundHtml, parseEmailList, toGraphRecipients, stripHtml } from '../html-utils.js';
import { saveAttachment, MAX_ATTACHMENT_BYTES } from '../attachments.js';

const GRAPH = 'https://graph.microsoft.com/v1.0';

let cached = { token: null, exp: 0 };

export function graphConfigured() {
  return Boolean(
    process.env.MS_TENANT_ID && process.env.MS_CLIENT_ID &&
    process.env.MS_CLIENT_SECRET && process.env.SUPPORT_MAILBOX
  );
}

async function token() {
  if (cached.token && Date.now() < cached.exp) return cached.token;
  const res = await fetch(
    `https://login.microsoftonline.com/${process.env.MS_TENANT_ID}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.MS_CLIENT_ID,
        client_secret: process.env.MS_CLIENT_SECRET,
        scope: 'https://graph.microsoft.com/.default',
        grant_type: 'client_credentials'
      })
    }
  );
  if (!res.ok) throw new Error(`Graph auth failed (${res.status}): ${await res.text()}`);
  const tok = await res.json();
  cached = { token: tok.access_token, exp: Date.now() + (tok.expires_in - 60) * 1000 };
  return cached.token;
}

async function graphFetch(path, opts = {}) {
  const res = await fetch(`${GRAPH}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${await token()}`,
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      ...(opts.headers || {})
    }
  });
  if (!res.ok) throw new Error(`Graph ${path} failed (${res.status}): ${await res.text()}`);
  // sendMail returns 202 Accepted with an empty body; PATCH may return 204 — don't parse those as JSON
  if (res.status === 202 || res.status === 204) return null;
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Graph ${path} returned unparseable response (${res.status})`);
  }
}

function parseInboundBody(message) {
  const contentType = (message.body?.contentType || 'text').toLowerCase();
  const raw = message.body?.content || message.bodyPreview || '';
  if (contentType === 'html') {
    return { body: stripHtml(raw), body_html: sanitizeHtml(raw) };
  }
  return { body: raw, body_html: null };
}

async function ingestMessageAttachments(mailbox, graphMessageId, ticketId, messageId) {
  const list = await graphFetch(
    `/users/${encodeURIComponent(mailbox)}/messages/${graphMessageId}/attachments`
  );
  const items = list?.value || [];
  let saved = 0;
  for (const att of items) {
    try {
      if (att.isInline) continue;
      const odataType = att['@odata.type'] || '';
      if (odataType && !odataType.includes('fileAttachment')) {
        console.warn(`[mail] skip non-file attachment ${att.name || att.id} (${odataType})`);
        continue;
      }
      if (att.size > MAX_ATTACHMENT_BYTES) {
        console.warn(`[mail] skip attachment ${att.name} (${att.size} bytes) — over limit`);
        continue;
      }
      const full = await graphFetch(
        `/users/${encodeURIComponent(mailbox)}/messages/${graphMessageId}/attachments/${att.id}`
      );
      if (!full?.contentBytes) {
        console.warn(`[mail] no contentBytes for attachment ${att.name || att.id}`);
        continue;
      }
      const buffer = Buffer.from(full.contentBytes, 'base64');
      if (buffer.length > MAX_ATTACHMENT_BYTES) continue;
      saveAttachment({
        ticketId,
        messageId,
        filename: full.name || att.name || 'attachment',
        contentType: full.contentType || att.contentType,
        buffer,
        graphAttachmentId: att.id
      });
      saved++;
    } catch (err) {
      console.error('[mail] attachment failed', att.name || att.id, err.message);
    }
  }
  if (items.length && !saved) {
    console.warn(`[mail] message ${graphMessageId}: ${items.length} attachment(s) listed, none saved`);
  }
  return saved;
}

// Poll unread inbox messages in the support mailbox and file them as tickets.
export async function pollInbox() {
  const mailbox = process.env.SUPPORT_MAILBOX;
  const data = await graphFetch(
    `/users/${encodeURIComponent(mailbox)}/mailFolders/Inbox/messages` +
      `?$filter=isRead eq false&$top=25&$orderby=receivedDateTime asc` +
      `&$select=id,subject,from,body,bodyPreview,conversationId,receivedDateTime,hasAttachments`
  );
  const messages = data?.value || [];
  let created = 0, appended = 0, attachmentsSaved = 0;

  const findByConversation = db.prepare(
    "SELECT * FROM tickets WHERE conversation_id = ? AND status != 'closed' ORDER BY id DESC"
  );
  const contactByEmail = db.prepare(
    'SELECT c.*, cl.id AS client_id_ref FROM contacts c JOIN clients cl ON cl.id = c.client_id WHERE lower(c.email) = lower(?)'
  );
  const insertTicket = db.prepare(`
    INSERT INTO tickets (ticket_number, client_id, contact_id, subject, status, source, requester_email, conversation_id)
    VALUES (?, ?, ?, ?, 'open', 'email', ?, ?)
  `);
  const insertMsg = db.prepare(`
    INSERT INTO ticket_messages (ticket_id, direction, author, body, body_html, graph_message_id)
    VALUES (?, 'in', ?, ?, ?, ?)
  `);
  const seen = db.prepare('SELECT id, ticket_id FROM ticket_messages WHERE graph_message_id = ?');
  const touch = db.prepare(
    "UPDATE tickets SET updated_at = datetime('now'), status = CASE WHEN status = 'waiting' THEN 'open' ELSE status END WHERE id = ?"
  );

  for (const m of messages) {
    try {
      const existingMsg = seen.get(m.id);
      if (existingMsg) {
        const attCount = db.prepare(
          'SELECT COUNT(*) AS n FROM ticket_attachments WHERE message_id = ?'
        ).get(existingMsg.id).n;
        if (attCount === 0) {
          attachmentsSaved += await ingestMessageAttachments(
            mailbox, m.id, existingMsg.ticket_id, existingMsg.id
          );
        }
        await markRead(mailbox, m.id);
        continue;
      }
      const fromEmail = m.from?.emailAddress?.address || '';
      const fromName = m.from?.emailAddress?.name || fromEmail;
      const { body, body_html } = parseInboundBody(m);

      // Thread: explicit [TKT-00050] or legacy [PSA-123] tag beats conversationId matching.
      let ticket = null;
      const refMatch = (m.subject || '').match(/\[(?:TKT|PSA)-0*(\d+)\]/i);
      if (refMatch) {
        const num = Number(refMatch[1]);
        ticket = db.prepare('SELECT * FROM tickets WHERE ticket_number = ?').get(num)
          || db.prepare('SELECT * FROM tickets WHERE id = ?').get(num);
      }
      if (!ticket && m.conversationId) ticket = findByConversation.get(m.conversationId);

      if (ticket) {
        const msgInfo = insertMsg.run(ticket.id, fromName, body, body_html, m.id);
        attachmentsSaved += await ingestMessageAttachments(
          mailbox, m.id, ticket.id, msgInfo.lastInsertRowid
        );
        touch.run(ticket.id);
        appended++;
      } else {
        const contact = fromEmail ? contactByEmail.get(fromEmail) : null;
        const ticketNo = allocateTicketNumber();
        const info = insertTicket.run(
          ticketNo,
          contact?.client_id ?? null,
          contact?.id ?? null,
          m.subject || '(no subject)',
          fromEmail,
          m.conversationId || null
        );
        const msgInfo = insertMsg.run(info.lastInsertRowid, fromName, body, body_html, m.id);
        attachmentsSaved += await ingestMessageAttachments(
          mailbox, m.id, info.lastInsertRowid, msgInfo.lastInsertRowid
        );
        logTicketEvent(info.lastInsertRowid, 'created', `Email from ${fromEmail || fromName}`);
        created++;
      }
      await markRead(mailbox, m.id);
    } catch (err) {
      console.error('[mail] failed to process message', m.id, err.message);
    }
  }
  return { created, appended, scanned: messages.length, attachmentsSaved };
}

async function markRead(mailbox, messageId) {
  await graphFetch(`/users/${encodeURIComponent(mailbox)}/messages/${messageId}`, {
    method: 'PATCH',
    body: JSON.stringify({ isRead: true })
  });
}

// Send a reply from the support mailbox. Subject carries [TKT-00050] for threading.
export async function sendReply(ticket, { to, cc, bcc, body, attachments = [] }) {
  const mailbox = process.env.SUPPORT_MAILBOX;
  const subject = `RE: ${ticket.subject.replace(/\[(?:TKT|PSA)-0*\d+\]\s*/gi, '')} [${formatTicketRef(ticket)}]`;
  const htmlBody = prepareOutboundHtml(body);
  const message = {
    subject,
    body: { contentType: 'HTML', content: htmlBody },
    toRecipients: toGraphRecipients(parseEmailList(to))
  };
  const ccList = parseEmailList(cc);
  const bccList = parseEmailList(bcc);
  if (ccList.length) message.ccRecipients = toGraphRecipients(ccList);
  if (bccList.length) message.bccRecipients = toGraphRecipients(bccList);
  if (attachments.length) {
    message.attachments = attachments.map((file) => ({
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: file.originalname || file.filename || 'attachment',
      contentType: file.mimetype || 'application/octet-stream',
      contentBytes: file.buffer.toString('base64')
    }));
  }

  await graphFetch(`/users/${encodeURIComponent(mailbox)}/sendMail`, {
    method: 'POST',
    body: JSON.stringify({ message, saveToSentItems: true })
  });

  return { htmlBody, cc: ccList.join(', '), bcc: bccList.join(', ') };
}
