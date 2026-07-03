import crypto from 'node:crypto';

const SESSION_COOKIE = 'psa_session';
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;

export function authEnabled() {
  return Boolean(process.env.APP_PASSWORD);
}

function sessionSecret() {
  return process.env.SESSION_SECRET || process.env.APP_PASSWORD;
}

function hashPassword(value) {
  return crypto.createHash('sha256').update(value || '').digest();
}

export function verifyPassword(input) {
  const expected = process.env.APP_PASSWORD;
  if (!expected) return false;
  return crypto.timingSafeEqual(hashPassword(input), hashPassword(expected));
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    const key = part.slice(0, i).trim();
    out[key] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function signSession(exp) {
  const payload = String(exp);
  const sig = crypto.createHmac('sha256', sessionSecret()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verifySessionToken(token) {
  if (!authEnabled() || !token) return false;
  const dot = token.lastIndexOf('.');
  if (dot === -1) return false;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const exp = Number(payload);
  if (!Number.isFinite(exp) || Date.now() > exp) return false;
  const expected = crypto.createHmac('sha256', sessionSecret()).update(payload).digest('base64url');
  try {
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch {
    return false;
  }
}

function cookieSecure() {
  if (process.env.COOKIE_SECURE === '1') return true;
  if (process.env.COOKIE_SECURE === '0') return false;
  return (process.env.XERO_REDIRECT_URI || '').startsWith('https://');
}

function setSessionCookie(res, token) {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(SESSION_MS / 1000)}`
  ];
  if (cookieSecure()) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

export function clearSessionCookie(res) {
  const parts = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (cookieSecure()) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

export function createSession(res) {
  const token = signSession(Date.now() + SESSION_MS);
  setSessionCookie(res, token);
}

function isAuthenticated(req) {
  const cookies = parseCookies(req.headers.cookie);
  return verifySessionToken(cookies[SESSION_COOKIE]);
}

function isPublic(req) {
  if (req.path === '/login') return true;
  if (req.path.startsWith('/auth/xero/callback')) return true;
  return false;
}

export function requireAuth(req, res, next) {
  res.locals.authEnabled = authEnabled();
  if (!authEnabled()) return next();
  if (isPublic(req) || isAuthenticated(req)) return next();
  if (req.method === 'GET') {
    const nextUrl = req.originalUrl === '/login' ? '/' : req.originalUrl;
    return res.redirect(`/login?next=${encodeURIComponent(nextUrl)}`);
  }
  return res.status(401).send('Login required');
}

export function safeNextPath(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return '/';
  return value;
}
