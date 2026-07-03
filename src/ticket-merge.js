import { db } from './db.js';
import { formatTicketRef, logTicketEvent } from './ticket-utils.js';

const PRIORITY_RANK = { critical: 0, high: 1, normal: 2, low: 3 };

export function mergeTickets(primaryId, secondaryId) {
  if (primaryId === secondaryId) throw new Error('Cannot merge a ticket into itself');

  const primary = db.prepare('SELECT * FROM tickets WHERE id = ?').get(primaryId);
  const secondary = db.prepare('SELECT * FROM tickets WHERE id = ?').get(secondaryId);
  if (!primary || !secondary) throw new Error('Ticket not found');
  if (secondary.status === 'closed' && primary.status === 'closed') {
    throw new Error('Both tickets are already closed');
  }

  const tx = db.transaction(() => {
    db.prepare('UPDATE ticket_messages SET ticket_id = ? WHERE ticket_id = ?').run(primaryId, secondaryId);
    db.prepare('UPDATE time_entries SET ticket_id = ? WHERE ticket_id = ?').run(primaryId, secondaryId);
    db.prepare('UPDATE ticket_events SET ticket_id = ? WHERE ticket_id = ?').run(primaryId, secondaryId);
    db.prepare('UPDATE ticket_attachments SET ticket_id = ? WHERE ticket_id = ?').run(primaryId, secondaryId);

    const client_id = primary.client_id || secondary.client_id || null;
    const contact_id = primary.contact_id || secondary.contact_id || null;
    const requester_email = primary.requester_email || secondary.requester_email || null;
    const conversation_id = primary.conversation_id || secondary.conversation_id || null;
    const follow_up_at = primary.follow_up_at || secondary.follow_up_at || null;
    const category = primary.category || secondary.category || null;
    const pri = (PRIORITY_RANK[secondary.priority] ?? 9) < (PRIORITY_RANK[primary.priority] ?? 9)
      ? secondary.priority
      : primary.priority;

    db.prepare(`
      UPDATE tickets SET
        client_id = ?, contact_id = ?, requester_email = ?, conversation_id = ?,
        follow_up_at = ?, category = ?, priority = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `).run(client_id, contact_id, requester_email, conversation_id, follow_up_at, category, pri, primaryId);

    db.prepare("UPDATE tickets SET status = 'closed', updated_at = datetime('now') WHERE id = ?").run(secondaryId);

    db.prepare(`
      INSERT INTO ticket_messages (ticket_id, direction, author, body)
      VALUES (?, 'note', 'system', ?)
    `).run(primaryId, `Merged ${formatTicketRef(secondary)} (${secondary.subject}) into this ticket.`);

    logTicketEvent(primaryId, 'merged', `Merged ${formatTicketRef(secondary)}`);
    logTicketEvent(secondaryId, 'merged', `Merged into ${formatTicketRef(primary)}`);
  });
  tx();

  return db.prepare('SELECT * FROM tickets WHERE id = ?').get(primaryId);
}
