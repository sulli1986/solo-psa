import { getSetting } from './db.js';

// Timezone precedence: Settings page → APP_TIMEZONE env → Perth default.
// Read per call so a settings change applies without a restart.
function TZ() {
  return getSetting('app_timezone') || process.env.APP_TIMEZONE || 'Australia/Perth';
}

export function parseDbDate(value) {
  if (!value) return null;
  let s = String(value).trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) s += 'T00:00:00';
  else if (!s.includes('T')) s = s.replace(' ', 'T');
  if (!/([zZ]|[+-]\d{2}(:?\d{2})?)$/.test(s)) s += 'Z';
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function fmtDate(value) {
  const d = parseDbDate(value);
  if (!d) return '—';
  return d.toLocaleDateString('en-AU', {
    timeZone: TZ(),
    day: '2-digit',
    month: '2-digit',
    year: 'numeric'
  });
}

export function fmtDateTime(value) {
  const d = parseDbDate(value);
  if (!d) return '—';
  return d.toLocaleString('en-AU', {
    timeZone: TZ(),
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
}

export function fmtDateTimeShort(value) {
  const d = parseDbDate(value);
  if (!d) return '—';
  return d.toLocaleString('en-AU', {
    timeZone: TZ(),
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
}

export function fmtDateInput(value) {
  const d = parseDbDate(value);
  if (!d) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ(),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(d);
  const y = parts.find((p) => p.type === 'year')?.value;
  const m = parts.find((p) => p.type === 'month')?.value;
  const day = parts.find((p) => p.type === 'day')?.value;
  return y && m && day ? `${y}-${m}-${day}` : '';
}

export function todayIsoInTz() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ(),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date());
}

export function hourNowInTz() {
  return Number(new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ(),
    hour: 'numeric',
    hour12: false
  }).format(new Date())) % 24;
}

export function appTimezone() {
  return TZ();
}

export function isDateBeforeToday(value) {
  const s = String(value || '');
  // Datetimes are stored UTC — convert to the local date before comparing
  const d = s.length > 10 ? fmtDateInput(s) : s.slice(0, 10);
  return Boolean(d && d < todayIsoInTz());
}

// Offset of TZ from UTC at a given instant (ms). Handles DST-observing zones too.
function tzOffsetMs(utcMs) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ(),
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).formatToParts(utcMs);
  const get = (t) => Number(parts.find((p) => p.type === t)?.value || 0);
  const wallAsUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  return wallAsUtc - utcMs;
}

// Convert a datetime-local input value ('YYYY-MM-DDTHH:MM', wall time in TZ) to the
// UTC 'YYYY-MM-DD HH:MM:SS' format used by the database. Date-only input → midnight TZ.
export function localInputToUtcSql(value) {
  let s = String(value || '').trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) s += 'T00:00';
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  if (!m) return null;
  const naive = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  const utc = naive - tzOffsetMs(naive - tzOffsetMs(naive)); // two-pass for DST edges
  return new Date(utc).toISOString().slice(0, 19).replace('T', ' ');
}

// Format a stored UTC datetime for a datetime-local input (wall time in TZ).
export function fmtDateTimeLocalInput(value) {
  const d = parseDbDate(value);
  if (!d) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ(),
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  const h = String(Number(get('hour')) % 24).padStart(2, '0');
  return `${get('year')}-${get('month')}-${get('day')}T${h}:${get('minute')}`;
}
