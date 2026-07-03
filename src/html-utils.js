// Lightweight HTML helpers for email display and outbound formatting.

const BLOCKED_TAGS = /<\/?(?:script|style|iframe|object|embed|form|input|button|link|meta|base)[^>]*>/gi;
const EVENT_ATTRS = /\s+on\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;
const JS_URL = /\s+(?:href|src|xlink:href)\s*=\s*(?:"javascript:[^"]*"|'javascript:[^']*')/gi;

export function sanitizeHtml(html = '') {
  if (!html) return '';
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(BLOCKED_TAGS, '')
    .replace(EVENT_ATTRS, '')
    .replace(JS_URL, '')
    .trim();
}

export function looksLikeHtml(text = '') {
  return /<[a-z][\s\S]*>/i.test(text);
}

export function escapeHtml(text = '') {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function textToHtml(text = '') {
  return escapeHtml(text).replace(/\n/g, '<br>\n');
}

export function stripHtml(html = '') {
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function prepareOutboundHtml(body = '') {
  const trimmed = body.trim();
  if (!trimmed) return '';
  return looksLikeHtml(trimmed) ? sanitizeHtml(trimmed) : textToHtml(trimmed);
}

export function parseEmailList(raw = '') {
  return String(raw)
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter((s) => s && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s));
}

export function toGraphRecipients(emails) {
  return emails.map((address) => ({ emailAddress: { address } }));
}
