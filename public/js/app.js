import { $, $$, esc, icon, initials, session, api, closeModal, toast } from './core.js';
import { renderHome, renderWhatsApp, stopWhatsAppPolling, connectWhatsApp, disconnectWhatsApp, renderSettings, renderAccount } from './admin.js';
import { renderMembers, openMember, memberById, loadMember, openAddMember, openEditMember, openRenew, openDeleteMember, deleteMember, sendWhatsApp, shareQr } from './members.js';
import { renderTrainers, openAddTrainer, openEditTrainer, resetTrainerPassword, toggleTrainer, confirmDeleteTrainer, deleteTrainer } from './trainers.js';
import { renderScan, stopCamera } from './scan.js';

const NAV = {
  owner: [
    ['home', 'Home', 'home', renderHome], ['trainers', 'Trainers', 'trainers', renderTrainers], ['members', 'Members', 'members', renderMembers],
    ['scan', 'Scan', 'scan', renderScan], ['whatsapp', 'WhatsApp', 'chat', renderWhatsApp], ['settings', 'Settings', 'gear', renderSettings],
  ],
  trainer: [
    ['home', 'Home', 'home', renderHome], ['members', 'My members', 'members', renderMembers], ['scan', 'Scan', 'scan', renderScan],
    ['whatsapp', 'WhatsApp', 'chat', renderWhatsApp], ['account', 'Account', 'gear', renderAccount],
  ],
};
const BOTTOM = { owner: ['home', 'trainers', 'members', 'scan', 'whatsapp'], trainer: ['home', 'members', 'scan', 'whatsapp', 'account'] };
let current = null, params = {};

function navItems() { return NAV[session.me.user.role]; }

function updateNav() {
  const me = session.me, items = navItems();
  $$('[data-gym]').forEach(el => { el.textContent = me.gymName; });
  $('#me-name').textContent = me.user.name;
  $('#me-role').textContent = me.user.role === 'owner' ? 'Gym owner' : 'Trainer';
  $('#me-avatar').textContent = initials(me.user.name);
  $('#side-nav').innerHTML = items.map(([id, label, ic]) => `<button class="nav-btn" type="button" data-go="${id}">${icon(ic)}${esc(label)}${id === 'whatsapp' ? `<span class="nav-dot${me.whatsapp.mine ? ' on' : ''}" title="${me.whatsapp.mine ? 'Connected' : 'Not connected'}"></span>` : ''}</button>`).join('');
  $('#bottom-nav').innerHTML = BOTTOM[me.user.role].map(id => { const [, label, ic] = items.find(x => x[0] === id); return `<button class="bn-btn" type="button" data-go="${id}">${icon(ic)}${esc(label === 'My members' ? 'Members' : label)}</button>`; }).join('');
  $('#top-settings').hidden = me.user.role !== 'owner';
  markCurrent();
}
function markCurrent() {
  $$('.nav-btn, .bn-btn').forEach(b => b.dataset.go === current ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current'));
}

async function go(id, p = {}, { keepScroll = false } = {}) {
  const item = navItems().find(x => x[0] === id) || navItems()[0];
  if (current === 'scan' && item[0] !== 'scan') stopCamera();
  if (current === 'whatsapp' && item[0] !== 'whatsapp') stopWhatsAppPolling();
  current = item[0]; params = p;
  markCurrent();
  if (location.hash.slice(1) !== current) history.replaceState(null, '', '#' + current);
  document.title = `${item[1]} · Trainer Pass`;
  const view = document.createElement('div'); view.className = 'view';
  const main = $('#main'), y = window.scrollY;
  main.replaceChildren(view);
  try { await item[3](view, p); }
  catch (err) { view.innerHTML = `<div class="card empty">${esc(err.message)} <button class="btn btn-sm" type="button" data-go="${current}">Try again</button></div>`; }
  window.scrollTo(0, keepScroll ? y : 0);
}

// Updates who is logged in and the WhatsApp state (menu dot, send buttons) without redrawing the page.
async function refreshMe() {
  try { session.me = await api('/me'); updateNav(); } catch { /* keep old */ }
}

// Re-draws the current page after a change (and refreshes the WhatsApp state for buttons).
async function refresh() {
  try { session.me = await api('/me'); updateNav(); } catch { /* keep old */ }
  if (current !== 'scan' && current !== 'whatsapp') go(current, params, { keepScroll: true });
}

const ACTIONS = {
  'logout': async () => { await api('/logout', { method: 'POST' }).catch(() => {}); location.href = '/'; },
  'close': () => closeModal(),
  'add-member': () => openAddMember(),
  'add-member-for': (el) => openAddMember(el.dataset.id),
  'open-member': (el) => openMember(memberById(el.dataset.id)),
  'open-member-load': async (el) => {
    const m = await loadMember(el.dataset.id).catch(() => null);
    if (m) openMember(m); else toast('This member is with another trainer.', { bad: true });
  },
  'send-wa': (el) => sendWhatsApp(el, el.dataset.id),
  'share-qr': (el) => shareQr(el.dataset.id),
  'renew': (el) => openRenew(el.dataset.id),
  'edit-member': (el) => openEditMember(el.dataset.id),
  'delete-member': (el) => openDeleteMember(el.dataset.id),
  'confirm-delete-member': (el) => deleteMember(el, el.dataset.id),
  'add-trainer': () => openAddTrainer(),
  'edit-trainer': (el) => openEditTrainer(el.dataset.id),
  'reset-trainer-pw': (el) => resetTrainerPassword(el, el.dataset.id),
  'toggle-trainer': (el) => toggleTrainer(el, el.dataset.id),
  'delete-trainer': (el) => confirmDeleteTrainer(el.dataset.id),
  'confirm-delete-trainer': (el) => deleteTrainer(el, el.dataset.id),
  'wa-connect': (el) => connectWhatsApp(el),
  'wa-disconnect': (el) => disconnectWhatsApp(el),
};

document.addEventListener('click', e => {
  const nav = e.target.closest('[data-go]');
  if (nav) {
    e.preventDefault(); closeModal();
    go(nav.dataset.go, nav.dataset.trainer ? { trainer: nav.dataset.trainer } : {});
    return;
  }
  const el = e.target.closest('[data-action]');
  if (el && ACTIONS[el.dataset.action]) { e.preventDefault(); ACTIONS[el.dataset.action](el); }
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeModal();
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[role="button"][data-action]')) { e.preventDefault(); e.target.click(); }
});
$('#modal').addEventListener('click', e => { if (e.target === e.currentTarget) closeModal(); });
window.addEventListener('hashchange', () => { const h = location.hash.slice(1); if (h && h !== current) go(h); });
document.addEventListener('visibilitychange', () => { if (document.hidden) stopCamera(); });

(async function start() {
  try { session.me = await api('/me'); }
  catch (err) { $('#main').innerHTML = `<div class="view"><div class="card empty">${esc(err.message)}</div></div>`; return; }
  session.refresh = refresh;
  session.refreshMe = refreshMe;
  session.updateNav = updateNav;
  current = location.hash.slice(1) || 'home';
  updateNav();
  go(current);
})();
