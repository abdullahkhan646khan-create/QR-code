export const $ = (sel, el = document) => el.querySelector(sel);
export const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const icon = (id, size) => `<svg class="i"${size ? ` style="width:${size}px;height:${size}px"` : ''} aria-hidden="true"><use href="#i-${id}"/></svg>`;
export const initials = name => String(name || '').trim().split(/\s+/).slice(0, 2).map(w => w[0] || '').join('').toUpperCase();
export const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

export function fmtDate(iso) {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}
export function fmtTime(ts) {
  const d = new Date(ts), now = new Date();
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return `Today ${time}`;
  const y = new Date(now); y.setDate(y.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `Yesterday ${time}`;
  return `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} ${time}`;
}

// Pass status from the server -> pill class + words people use at the front desk.
export function statusView(s) {
  if (!s) return { cls: 'none', label: 'No QR code', note: '' };
  if (s.key === 'valid') {
    const note = s.days === 0 ? 'Last day today' : `${plural(s.days, 'day')} left`;
    return s.days <= 5 ? { cls: 'soon', label: 'Ending soon', note } : { cls: 'valid', label: 'Valid', note };
  }
  if (s.key === 'expired') return { cls: 'expired', label: 'Expired', note: s.days === 0 ? 'Ended today' : `Ended ${plural(s.days, 'day')} ago` };
  if (s.key === 'replaced') return { cls: 'replaced', label: 'Old QR code', note: 'A newer one was sent' };
  if (s.key === 'upcoming') return { cls: 'upcoming', label: 'Not started', note: `Starts in ${plural(s.days, 'day')}` };
  return { cls: 'none', label: 'No QR code', note: '' };
}
export const pill = s => { const v = statusView(s); return `<span class="pill ${v.cls}">${esc(v.label)}</span>`; };

export const session = { me: null };

export async function api(path, { method = 'GET', body } = {}) {
  let r;
  try {
    r = await fetch('/api' + path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  } catch {
    throw new Error('No connection. Check the internet and try again.');
  }
  if (r.status === 401) { location.href = '/'; throw new Error('Please log in again.'); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Something went wrong. Try again.');
  return data;
}

/* ---------- modal ---------- */
let lastFocus = null, onCloseFn = null;
export function openModal(title, html, { wide = false, onClose = null } = {}) {
  if ($('#modal').hidden) lastFocus = document.activeElement;
  onCloseFn?.(); onCloseFn = onClose;
  $('#dialog-title').textContent = title;
  $('#dialog-body').innerHTML = html;
  $('#dialog').classList.toggle('wide', wide);
  $('#modal').hidden = false;
  document.body.style.overflow = 'hidden';
  ($('#dialog-body input:not([type=checkbox]), #dialog-body select') || $('#dialog .dialog-head button')).focus();
}
export function closeModal() {
  if ($('#modal').hidden) return;
  $('#modal').hidden = true;
  document.body.style.overflow = '';
  onCloseFn?.(); onCloseFn = null;
  if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
}

/* ---------- toast ---------- */
let toastTimer = 0;
export function toast(msg, { bad = false } = {}) {
  const t = $('#toast');
  t.textContent = msg; t.classList.toggle('bad', bad); t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, bad ? 5000 : 3000);
}

// Runs an async action from a button: disables it, shows errors as a toast or in a form box.
export async function busy(btn, fn, errBox) {
  const label = btn?.innerHTML;
  if (btn) { btn.disabled = true; btn.innerHTML = 'Please wait…'; }
  if (errBox) errBox.hidden = true;
  try { return await fn(); }
  catch (err) {
    if (errBox) { errBox.textContent = err.message; errBox.hidden = false; } else toast(err.message, { bad: true });
    return undefined;
  } finally {
    if (btn && document.contains(btn)) { btn.disabled = false; btn.innerHTML = label; }
  }
}

export function makePassword() {
  const words = ['gym', 'fit', 'lift', 'run', 'core', 'iron', 'power', 'move'];
  const w = words[Math.floor(Math.random() * words.length)];
  return w + String(Math.floor(1000 + Math.random() * 9000));
}

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('Copied'); }
  catch { toast('Copy did not work. Select the text and copy it.', { bad: true }); }
}
