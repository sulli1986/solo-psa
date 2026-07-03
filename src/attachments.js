import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import multer from 'multer';
import { db } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ATTACHMENTS_ROOT = process.env.ATTACHMENTS_PATH
  || join(__dirname, '..', 'data', 'attachments');
export const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;
export const MAX_REPLY_ATTACHMENTS = 10;

export const replyUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_ATTACHMENT_BYTES, files: MAX_REPLY_ATTACHMENTS }
});

export function ensureAttachmentsRoot() {
  if (!existsSync(ATTACHMENTS_ROOT)) mkdirSync(ATTACHMENTS_ROOT, { recursive: true });
}

export function safeFilename(name = 'file') {
  const base = String(name).replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^\.+/, '');
  return (base || 'file').slice(0, 180);
}

export function formatFileSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

const insertAttachment = db.prepare(`
  INSERT INTO ticket_attachments
    (ticket_id, message_id, filename, content_type, size_bytes, storage_path, graph_attachment_id)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

export function saveAttachment({ ticketId, messageId, filename, contentType, buffer, graphAttachmentId }) {
  ensureAttachmentsRoot();
  if (graphAttachmentId) {
    const existing = db.prepare(
      'SELECT id FROM ticket_attachments WHERE graph_attachment_id = ? AND message_id = ?'
    ).get(graphAttachmentId, messageId);
    if (existing) return existing.id;
  }

  const info = insertAttachment.run(
    ticketId,
    messageId,
    filename,
    contentType || null,
    buffer.length,
    '', // filled after we know id
    graphAttachmentId || null
  );
  const id = info.lastInsertRowid;
  const dir = join(ATTACHMENTS_ROOT, String(ticketId));
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const storagePath = join(String(ticketId), `${id}_${safeFilename(filename)}`);
  writeFileSync(join(ATTACHMENTS_ROOT, storagePath), buffer);
  db.prepare('UPDATE ticket_attachments SET storage_path = ? WHERE id = ?').run(storagePath, id);
  return id;
}

export function getAttachmentRecord(ticketId, attachmentId) {
  return db.prepare(
    'SELECT * FROM ticket_attachments WHERE id = ? AND ticket_id = ?'
  ).get(attachmentId, ticketId);
}

export function readAttachmentFile(record) {
  return readFileSync(join(ATTACHMENTS_ROOT, record.storage_path));
}

export function listTicketAttachments(ticketId) {
  return db.prepare(`
    SELECT a.*, m.created_at AS message_at, m.author AS message_author
    FROM ticket_attachments a
    LEFT JOIN ticket_messages m ON m.id = a.message_id
    WHERE a.ticket_id = ?
    ORDER BY a.created_at, a.id
  `).all(ticketId);
}
