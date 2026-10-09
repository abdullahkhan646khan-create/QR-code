import crypto from 'node:crypto';

// Dates are calendar days stored as 'YYYY-MM-DD' text, counted in the gym's time zone.
export const TIMEZONE = process.env.APP_TIMEZONE || 'Asia/Karachi';

export function todayISO() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

const toUTC = iso => { const [y, m, d] = iso.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const fromUTC = d => d.toISOString().slice(0, 10);

export function addDays(iso, n) {
  const d = toUTC(iso); d.setUTCDate(d.getUTCDate() + n); return fromUTC(d);
}

export function diffDays(a, b) {
  return Math.round((toUTC(a) - toUTC(b)) / 86400000);
}

// Last valid day of a package that starts on `startIso` and runs `months` months: 8 Oct -> 7 Nov.
export function packageEnd(startIso, months = 1) {
  const s = toUTC(startIso);
  const y = s.getUTCFullYear(), m = s.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const e = new Date(Date.UTC(y, m, Math.min(s.getUTCDate(), lastDay)));
  e.setUTCDate(e.getUTCDate() - 1);
  return fromUTC(e);
}

export function passStatus(pass, today = todayISO()) {
  if (!pass) return { key: 'none', label: 'No QR code', days: 0 };
  if (pass.revoked) return { key: 'replaced', label: 'Replaced', days: 0 };
  if (today < pass.start_date) return { key: 'upcoming', label: 'Not started', days: diffDays(pass.start_date, today) };
  if (today > pass.end_date) return { key: 'expired', label: 'Expired', days: diffDays(today, pass.end_date) };
  return { key: 'valid', label: 'Valid', days: diffDays(pass.end_date, today) };
}

export function fmtDate(iso) {
  return toUTC(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

export const newToken = () => crypto.randomBytes(12).toString('base64url');

// '0300 1234567' -> '923001234567' with country code 92. Returns digits only, or null when too short.
export function normalizePhone(raw, countryCode = '92') {
  let d = String(raw || '').replace(/\D/g, '');
  if (!d) return null;
  if (String(raw).trim().startsWith('+')) return d.length >= 10 ? d : null;
  if (d.startsWith('00')) d = d.slice(2);
  else if (d.startsWith('0')) d = countryCode + d.slice(1);
  else if (d.length <= 10) d = countryCode + d;
  return d.length >= 10 && d.length <= 15 ? d : null;
}

export const formatPhone = digits => digits ? '+' + digits : '';

export function cleanText(v, max = 80) {
  return String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}
