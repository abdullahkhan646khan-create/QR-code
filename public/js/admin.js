import { $, esc, icon, fmtTime, statusView, pill, session, api, toast, busy } from './core.js';

const RESULT = {
  valid: ['valid', 'check', 'Valid'], expired: ['expired', 'x', 'Expired'], replaced: ['replaced', 'x', 'Old QR code'],
  upcoming: ['upcoming', 'help', 'Not started'], unknown: ['unknown', 'help', 'Not recognised'],
};
export function scanItem(s) {
  const [cls, ic, label] = RESULT[s.result] || RESULT.unknown;
  const sub = [s.trainer_name, s.scanned_by ? `by ${s.scanned_by}` : '', fmtTime(s.created_at)].filter(Boolean).map(esc).join(' · ');
  return `<div class="li"><div class="res-icon ${cls}">${icon(ic)}</div>
    <div class="who"><strong>${esc(s.member_name || 'Unknown QR code')}</strong><span>${sub}</span></div>
    <span class="pill ${cls === 'upcoming' ? 'replaced' : cls}">${label}</span></div>`;
}

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

/* ---------- home ---------- */
export async function renderHome(view) {
  const owner = session.me.user.role === 'owner';
  const o = await api('/overview');
  const stat = (label, color, n, sub) => `<div class="card stat"><div class="stat-top"><i style="background:${color}"></i>${label}</div><div class="stat-n">${n}</div><div class="stat-sub">${sub}</div></div>`;
  view.innerHTML = `
    <div class="page-head"><div><h1>${greeting()}${owner ? '' : `, ${esc(session.me.user.name.split(' ')[0])}`}</h1><p>${owner ? `Here's what is happening at ${esc(session.me.gymName)} today.` : `Your members at ${esc(session.me.gymName)}.`}</p></div></div>
    ${o.whatsapp.mine ? '' : `<div class="banner"><p>${owner
      ? "<strong>WhatsApp is not connected</strong>Connect the gym's WhatsApp so QR codes are sent to members automatically."
      : `<strong>Connect your WhatsApp</strong>${o.whatsapp.gym ? "QR codes go out from the gym's WhatsApp for now. Connect yours to send them from your own number." : 'Connect your WhatsApp so your members get their QR codes from your number.'}`}</p>
      <button class="btn btn-wa" type="button" data-go="whatsapp">${icon('chat')}Connect WhatsApp</button></div>`}
    <div class="stats${owner ? ' six' : ''}">
      ${owner ? stat('Trainers', 'var(--primary)', o.trainers, 'with a login') : ''}
      ${stat(owner ? 'Members' : 'My members', 'var(--primary)', o.members, 'with a trainer')}
      ${stat('Valid QR codes', 'var(--ok)', o.valid, 'can train today')}
      ${stat('Ending soon', 'var(--warn)', o.expiringSoon, 'in the next 5 days')}
      ${stat('Expired', 'var(--bad)', o.expired, 'need a new month')}
      ${owner ? stat('Scans today', 'var(--faint)', o.scansToday, 'at the gym') : ''}
    </div>
    <div class="quick">
      <button class="quick-btn" type="button" data-go="scan"><span class="qi">${icon('scan')}</span><span><strong>Scan a QR code</strong><span>Check a member's trainer and expiry</span></span></button>
      ${owner
        ? `<button class="quick-btn" type="button" data-action="add-trainer"><span class="qi">${icon('trainers')}</span><span><strong>Add a trainer</strong><span>Create a login for a trainer</span></span></button>`
        : `<button class="quick-btn" type="button" data-action="add-member"><span class="qi">${icon('plus')}</span><span><strong>Add a member</strong><span>Make their QR code and send it</span></span></button>`}
    </div>
    <div class="cols">
      <section class="card">
        <div class="card-head"><h2>Ending soon</h2><button class="btn btn-sm btn-quiet" type="button" data-go="members">All members</button></div>
        <div class="list">${o.expiring.length ? o.expiring.map(m => `
          <div class="li li-click" data-action="open-member-load" data-id="${m.id}">
            <div class="avatar">${esc(m.name.split(' ').map(w => w[0]).slice(0, 2).join(''))}</div>
            <div class="who"><strong>${esc(m.name)}</strong><span>${owner ? esc(m.trainer.name) + ' · ' : ''}${esc(statusView(m.status).note)}</span></div>
            ${pill(m.status)}
          </div>`).join('') : '<div class="empty">No QR codes end in the next 5 days.</div>'}</div>
      </section>
      <section class="card">
        <div class="card-head"><h2>Recent scans</h2></div>
        <div class="list">${o.recentScans.length ? o.recentScans.map(scanItem).join('') : '<div class="empty">No scans yet. Use <b>Scan</b> to check a member.</div>'}</div>
      </section>
    </div>`;
}

/* ---------- WhatsApp (owner) ---------- */
let pollTimer = 0;
export function stopWhatsAppPolling() { clearTimeout(pollTimer); }

const isOwner = () => session.me.user.role === 'owner';

export async function renderWhatsApp(view) {
  const owner = isOwner();
  view.innerHTML = `
    <div class="page-head"><div><h1>${owner ? 'WhatsApp' : 'My WhatsApp'}</h1><p>${owner
      ? "Link the gym's WhatsApp once. Trainers can also link their own number from their login."
      : 'Link your WhatsApp once. Your members get their QR codes from your number.'}</p></div></div>
    <div class="wa-grid">
      <section class="card card-pad" id="wa-main"><div class="result-wait"><div class="spinner"></div>Checking WhatsApp…</div></section>
      ${owner ? `<section class="card card-pad form">
        <h2 style="font-size:16px;font-weight:750">Sending</h2>
        <label class="check"><input type="checkbox" id="wa-auto"${session.me.autoSend ? ' checked' : ''}> Send the QR code automatically when a member is added or gets a new month</label>
        <div class="note">A trainer who linked their own WhatsApp sends from their number. Otherwise QR codes go from the gym's number.</div>
        <div class="list" id="wa-trainers" style="border:1px solid var(--line);border-radius:var(--r-sm)"><div class="empty">Loading trainers…</div></div>
        <div class="note">Use numbers you own. This links like WhatsApp Web, which WhatsApp does not officially support. If many messages go to people who never saved the number, WhatsApp can block it.</div>
      </section>` : `<section class="card card-pad form">
        <h2 style="font-size:16px;font-weight:750">How sending works</h2>
        <ul class="steps">
          <li><b>Your WhatsApp linked:</b> QR codes go to your members from your number.</li>
          <li><b>Not linked:</b> they go from the gym's WhatsApp${session.me.whatsapp.gym ? ' (connected)' : ' (not connected right now)'}.</li>
          <li><b>Neither:</b> open the member and press <b>Send on WhatsApp</b> to send it yourself.</li>
        </ul>
        <div class="note">This links like WhatsApp Web, which WhatsApp does not officially support. Send only to your own members.</div>
      </section>`}
    </div>`;
  if (owner) {
    api('/trainers').then(list => {
      const box = $('#wa-trainers'); if (!box) return;
      box.innerHTML = list.length ? list.map(t => `<div class="li"><div class="avatar">${esc(t.name.split(' ').map(w => w[0]).slice(0, 2).join(''))}</div>
        <div class="who"><strong>${esc(t.name)}</strong><span>@${esc(t.username)}</span></div>
        <span class="pill ${t.whatsapp ? 'valid' : 'off'}">${t.whatsapp ? 'WhatsApp linked' : 'Not linked'}</span></div>`).join('') : '<div class="empty">No trainers yet.</div>';
    }).catch(() => {});
  }
  $('#wa-auto')?.addEventListener('change', async e => {
    try { await api('/settings', { method: 'PATCH', body: { autoSend: e.target.checked } }); session.me.autoSend = e.target.checked; toast('Saved'); }
    catch (err) { toast(err.message, { bad: true }); e.target.checked = !e.target.checked; }
  });
  await pollWhatsApp();
}

async function pollWhatsApp() {
  clearTimeout(pollTimer);
  if (!$('#wa-main')) return;
  let s;
  try { s = await api('/whatsapp'); } catch (err) { s = { status: 'error', error: err.message }; }
  if (!$('#wa-main')) return;
  drawWhatsApp(s);
  const nowOn = s.status === 'connected';
  if (nowOn !== session.me.whatsapp.mine) {
    if (nowOn) toast('WhatsApp connected');
    session.refreshMe(); // updates who sends, the menu dot and the buttons on member cards
  }
  pollTimer = setTimeout(pollWhatsApp, ['connecting', 'reconnecting', 'qr'].includes(s.status) ? 2000 : 10000);
}

function drawWhatsApp(s) {
  const box = $('#wa-main');
  const head = (dot, title, sub) => `<div class="wa-status"><span class="dot ${dot}"></span><div><strong>${title}</strong><span class="muted">${sub}</span></div></div>`;
  if (s.status === 'connected') {
    if (box.dataset.state === 'connected') return; // keep the test form as typed
    box.dataset.state = 'connected';
    box.innerHTML = `<div class="form">
      ${head('on', 'Connected', `Sending from +${esc(s.number || '')}${s.name ? ` (${esc(s.name)})` : ''}`)}
      <form class="form" id="wa-test">
        <div class="field"><label for="wa-test-phone">Send a test message</label>
          <div class="input-group"><input type="tel" id="wa-test-phone" inputmode="tel" placeholder="Your number, e.g. 0300 1234567"><button class="btn btn-wa" type="submit" id="wa-test-btn">${icon('send')}Send</button></div></div>
      </form>
      <div><button class="btn btn-quiet btn-danger" type="button" data-action="wa-disconnect">Disconnect WhatsApp</button></div>
    </div>`;
    $('#wa-test').addEventListener('submit', async e => {
      e.preventDefault();
      const r = await busy($('#wa-test-btn'), () => api('/whatsapp/test', { method: 'POST', body: { phone: $('#wa-test-phone').value } }));
      if (r) toast('Test message sent. Check WhatsApp.');
    });
    return;
  }
  box.dataset.state = s.status;
  if (s.status === 'qr' && s.qr) {
    box.innerHTML = `<div class="form">
      ${head('wait', `Scan this code with ${isOwner() ? "the gym's phone" : 'your phone'}`, 'The code changes every 20 seconds. Keep this page open.')}
      <div class="wa-qr"><img src="${s.qr}" alt="WhatsApp link code" width="360" height="360"></div>
      <ol class="steps">
        <li>Open <b>WhatsApp</b> on ${isOwner() ? "the gym's phone" : 'your phone'}.</li>
        <li>Tap <b>Settings</b> (iPhone) or the <b>⋮ menu</b> (Android).</li>
        <li>Tap <b>Linked devices</b>, then <b>Link a device</b>.</li>
        <li>Point the phone at this code.</li>
      </ol>
      <div><button class="btn btn-quiet" type="button" data-action="wa-disconnect">Cancel</button></div>
    </div>`;
    return;
  }
  if (['connecting', 'reconnecting'].includes(s.status)) {
    box.innerHTML = `${head('wait', s.status === 'reconnecting' ? 'Reconnecting…' : 'Connecting…', 'Talking to WhatsApp. This takes a few seconds.')}<div class="result-wait"><div class="spinner"></div></div>`;
    return;
  }
  box.innerHTML = `<div class="form">
    ${head('', 'Not connected', 'QR codes are not sent automatically yet.')}
    ${s.error ? `<div class="form-error">${esc(s.error)}</div>` : ''}
    <p>${isOwner() ? "You need the gym's phone with WhatsApp on it." : 'You need your phone with WhatsApp on it.'} Press the button and scan the code that appears.</p>
    <div><button class="btn btn-wa btn-lg" type="button" data-action="wa-connect">${icon('chat')}Connect WhatsApp</button></div>
  </div>`;
}

export async function connectWhatsApp(btn) {
  const r = await busy(btn, () => api('/whatsapp/connect', { method: 'POST' }));
  if (r) pollWhatsApp();
}
export async function disconnectWhatsApp(btn) {
  const r = await busy(btn, () => api('/whatsapp/disconnect', { method: 'POST' }));
  if (!r) return;
  toast('WhatsApp disconnected'); session.refreshMe(); pollWhatsApp();
}

/* ---------- settings (owner) & account ---------- */
function passwordCard() {
  return `<section class="card card-pad">
    <form class="form" id="pw-form" novalidate>
      <h2 style="font-size:16px;font-weight:750">Change my password</h2>
      <div class="form-error" id="pw-err" hidden></div>
      <div class="row-2">
        <div class="field"><label for="pw-cur">Current password</label><input type="password" id="pw-cur" autocomplete="current-password"></div>
        <div class="field"><label for="pw-new">New password</label><input type="password" id="pw-new" autocomplete="new-password"><span class="hint">At least 6 characters.</span></div>
      </div>
      <div><button class="btn btn-primary" type="submit" id="pw-btn">Change password</button></div>
    </form></section>`;
}
function bindPassword() {
  $('#pw-form').addEventListener('submit', async e => {
    e.preventDefault();
    const r = await busy($('#pw-btn'), () => api('/me/password', { method: 'POST', body: { current: $('#pw-cur').value, next: $('#pw-new').value } }), $('#pw-err'));
    if (r) { e.target.reset(); toast('Password changed'); }
  });
}

export function renderSettings(view) {
  view.innerHTML = `
    <div class="page-head"><div><h1>Settings</h1><p>Gym details and your login.</p></div></div>
    <section class="card card-pad">
      <form class="form" id="gym-form" novalidate>
        <h2 style="font-size:16px;font-weight:750">Gym</h2>
        <div class="form-error" id="gym-err" hidden></div>
        <div class="row-2">
          <div class="field"><label for="s-gym">Gym name</label><input type="text" id="s-gym" value="${esc(session.me.gymName)}"><span class="hint">Shown in WhatsApp messages and on members' QR page.</span></div>
          <div class="field"><label for="s-cc">Country code</label><input type="text" id="s-cc" inputmode="numeric" value="${esc(session.me.countryCode)}"><span class="hint">Added to numbers that start with 0. Pakistan is 92.</span></div>
        </div>
        <div><button class="btn btn-primary" type="submit" id="gym-btn">Save</button></div>
      </form>
    </section>
    ${passwordCard()}`;
  $('#gym-form').addEventListener('submit', async e => {
    e.preventDefault();
    const body = { gymName: $('#s-gym').value, countryCode: $('#s-cc').value };
    const r = await busy($('#gym-btn'), () => api('/settings', { method: 'PATCH', body }), $('#gym-err'));
    if (!r) return;
    session.me.gymName = body.gymName.trim(); session.me.countryCode = body.countryCode.replace(/\D/g, '');
    session.updateNav(); toast('Saved');
  });
  bindPassword();
}

export function renderAccount(view) {
  view.innerHTML = `
    <div class="page-head"><div><h1>My account</h1><p>Logged in as <b>@${esc(session.me.user.username)}</b>. If you forget your password, ask the gym owner for a new one.</p></div></div>
    ${passwordCard()}`;
  bindPassword();
}
