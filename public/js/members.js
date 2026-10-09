import { $, esc, icon, initials, fmtDate, fmtTime, statusView, pill, session, api, openModal, closeModal, toast, busy } from './core.js';

let members = [], trainers = [];
const filters = { q: '', trainer: '', status: '' };
const isOwner = () => session.me.user.role === 'owner';
const waOn = () => session.me.whatsapp.connected;

/* ---------- list ---------- */
export async function renderMembers(view, params = {}) {
  if (params.trainer !== undefined) filters.trainer = String(params.trainer);
  const owner = isOwner();
  view.innerHTML = `
    <div class="page-head">
      <div><h1>${owner ? 'Members' : 'My members'}</h1><p>${owner ? 'Everyone training with a trainer. Tap a member to see their QR code.' : 'The members you train. Tap a member to see or send their QR code.'}</p></div>
      <div class="page-actions"><button class="btn btn-primary" type="button" data-action="add-member">${icon('plus')}Add member</button></div>
    </div>
    <div class="toolbar">
      <div class="search">${icon('search')}<input type="search" id="m-search" placeholder="Search by name or phone" aria-label="Search members" value="${esc(filters.q)}"></div>
      ${owner ? '<select id="m-trainer" aria-label="Filter by trainer"><option value="">All trainers</option></select>' : ''}
      <select id="m-status" aria-label="Filter by status"><option value="">All statuses</option><option value="valid">Valid</option><option value="soon">Ending soon</option><option value="expired">Expired</option></select>
    </div>
    <div class="card mtable${owner ? '' : ' no-trainer'}" id="m-table"><div class="empty">Loading members…</div></div>`;
  [members, trainers] = await Promise.all([api('/members'), owner ? api('/trainers') : Promise.resolve([])]);
  if (owner) {
    $('#m-trainer').innerHTML += trainers.map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join('');
    $('#m-trainer').value = filters.trainer;
    $('#m-trainer').addEventListener('change', e => { filters.trainer = e.target.value; drawTable(); });
  }
  $('#m-status').value = filters.status;
  $('#m-status').addEventListener('change', e => { filters.status = e.target.value; drawTable(); });
  $('#m-search').addEventListener('input', e => { filters.q = e.target.value; drawTable(); });
  drawTable();
}

function drawTable() {
  const box = $('#m-table'); if (!box) return;
  const q = filters.q.trim().toLowerCase(), qd = q.replace(/\D/g, '');
  const rows = members.filter(m =>
    (!filters.trainer || String(m.trainer.id) === filters.trainer) &&
    (!filters.status || statusView(m.status).cls === filters.status || (filters.status === 'valid' && statusView(m.status).cls === 'soon')) &&
    (!q || m.name.toLowerCase().includes(q) || (qd.length > 2 && m.phone.replace(/\D/g, '').includes(qd))));
  if (!members.length) { box.innerHTML = `<div class="empty">No members yet. Press <b>Add member</b> to add the first one.</div>`; return; }
  if (!rows.length) { box.innerHTML = '<div class="empty">No members match. Clear the search or change the filter.</div>'; return; }
  const owner = isOwner();
  box.innerHTML = `<div class="mrow mhead label"><div>Member</div>${owner ? '<div>Trainer</div>' : ''}<div>Valid until</div><div></div></div>` + rows.map(m => {
    const v = statusView(m.status);
    return `<div class="mrow" data-action="open-member" data-id="${m.id}" tabindex="0" role="button" aria-label="Open ${esc(m.name)}">
      <div class="who"><div class="avatar">${esc(initials(m.name))}</div><div><strong>${esc(m.name)}</strong><span class="num">${esc(m.phone)}</span></div></div>
      ${owner ? `<div class="trn">${esc(m.trainer.name)}</div>` : ''}
      <div class="until"><strong>${m.pass ? fmtDate(m.pass.end) : '—'}</strong><span>${esc(v.note)}</span></div>
      <div class="acts">${pill(m.status)}<button class="btn btn-sm" type="button" data-action="open-member" data-id="${m.id}">${icon('qr', 16)}QR</button></div>
    </div>`;
  }).join('');
}

export function memberById(id) { return members.find(m => m.id === Number(id)); }

/* ---------- member QR card ---------- */
export function openMember(m, { send = null, created = false } = {}) {
  if (!m) return;
  const v = statusView(m.status), slug = m.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  let sendHtml = '';
  const fromText = s => (s === 'gym' ? " from the gym's WhatsApp" : isOwner() ? " from the trainer's WhatsApp" : ' from your WhatsApp');
  if (send?.sent) sendHtml = `<div class="send-ok">${icon('check')}Sent to ${esc(m.phone)}${esc(fromText(send.from))}</div>`;
  else if (send?.error && waOn()) sendHtml = `<div class="send-err">Not sent: ${esc(send.error)}</div>`;
  const canShare = !!(navigator.canShare && window.File);
  openModal(created ? 'Member added' : m.name, `
    <div class="qr-layout">
      <div class="qr-frame"><img src="/api/members/${m.id}/qr.png?v=${m.pass?.id ?? 0}" alt="QR code for ${esc(m.name)}" width="640" height="640"></div>
      <div style="display:flex;flex-direction:column;gap:16px;min-width:0">
        <div>${pill(m.status)} <span class="muted small" style="margin-left:4px">${esc(v.note)}</span></div>
        <dl class="facts">
          <div><dt>Member</dt><dd>${esc(m.name)}</dd></div>
          <div><dt>Trainer</dt><dd>${esc(m.trainer.name)}</dd></div>
          <div><dt>WhatsApp</dt><dd class="num">${esc(m.phone)}</dd></div>
          <div><dt>Valid until</dt><dd>${m.pass ? fmtDate(m.pass.end) : '—'}</dd></div>
        </dl>
        <div class="send-box">
          ${sendHtml}
          ${waOn()
            ? `<button class="btn btn-wa" type="button" data-action="send-wa" data-id="${m.id}">${icon('send')}${send?.sent || m.pass?.sentAt ? 'Send again on WhatsApp' : 'Send on WhatsApp'}</button>
               <p class="hint">Sends the QR code${esc(fromText(session.me.whatsapp.via === 'mine' ? 'mine' : 'gym'))}.${!isOwner() && session.me.whatsapp.via === 'gym' ? ' <a href="#whatsapp" data-go="whatsapp">Connect yours</a> to send from your number.' : ''}</p>
               <a class="btn btn-sm" href="${esc(m.waLink)}" target="_blank" rel="noopener">${icon('chat', 16)}Open in WhatsApp on this phone instead</a>`
            : `<a class="btn btn-wa" href="${esc(m.waLink)}" target="_blank" rel="noopener">${icon('send')}Send on WhatsApp</a>
               <p class="hint">Opens WhatsApp on this device with the message and QR link ready. Press send. To send automatically, <a href="#whatsapp" data-go="whatsapp">connect ${isOwner() ? "the gym's" : 'your'} WhatsApp</a>.</p>`}
          <p class="hint">${m.pass?.sentAt ? `Last sent ${esc(fmtTime(m.pass.sentAt))}.` : 'Not sent from the app yet.'}</p>
          <div class="btn-row">
            ${canShare ? `<button class="btn btn-sm" type="button" data-action="share-qr" data-id="${m.id}">${icon('share', 16)}Share image</button>` : ''}
            <a class="btn btn-sm" href="/api/members/${m.id}/qr.png" download="qr-${esc(slug)}.png">${icon('download', 16)}Download</a>
          </div>
        </div>
      </div>
    </div>
    <div class="dialog-actions" style="justify-content:space-between">
      <div class="btn-row">
        <button class="btn" type="button" data-action="renew" data-id="${m.id}">${icon('renew')}New month</button>
        <button class="btn btn-quiet" type="button" data-action="edit-member" data-id="${m.id}">${icon('edit')}Edit</button>
      </div>
      <button class="btn btn-quiet btn-danger" type="button" data-action="delete-member" data-id="${m.id}">${icon('trash')}Delete</button>
    </div>`, { wide: true });
  // keep the latest copy so actions inside the card use it
  const i = members.findIndex(x => x.id === m.id);
  if (i >= 0) members[i] = m; else members.push(m);
}

export async function sendWhatsApp(btn, id) {
  const r = await busy(btn, () => api(`/members/${id}/send`, { method: 'POST' }));
  if (!r) return;
  toast(`QR code sent to ${r.member.name}`);
  openMember(r.member, { send: r.send });
  session.refresh();
}

export async function shareQr(id) {
  const m = memberById(id); if (!m) return;
  try {
    const blob = await (await fetch(`/api/members/${id}/qr.png`)).blob();
    const file = new File([blob], `qr-${m.name.replace(/\s+/g, '-')}.png`, { type: 'image/png' });
    if (!navigator.canShare({ files: [file] })) throw new Error('Sharing images is not supported on this device.');
    await navigator.share({ files: [file], text: `QR code for ${m.name}. Trainer: ${m.trainer.name}. Valid until ${fmtDate(m.pass.end)}. ${m.pass.url}` });
  } catch (err) {
    if (err.name !== 'AbortError') toast(err.message || 'Could not share.', { bad: true });
  }
}

/* ---------- add / edit / renew / delete ---------- */
async function trainerOptions(selected) {
  if (!trainers.length) trainers = await api('/trainers');
  const active = trainers.filter(t => t.active);
  return active.map(t => `<option value="${t.id}"${String(t.id) === String(selected) ? ' selected' : ''}>${esc(t.name)}</option>`).join('');
}

export async function openAddMember(presetTrainer) {
  const owner = isOwner();
  const options = owner ? await trainerOptions(presetTrainer || filters.trainer) : '';
  if (owner && !options) { toast('Add a trainer first.', { bad: true }); return; }
  openModal('Add member', `
    <form class="form" id="add-form" novalidate>
      <div class="form-error" id="add-err" hidden></div>
      <div class="field"><label for="a-name">Member name</label><input type="text" id="a-name" autocomplete="off" placeholder="e.g. Ahmed Khan"></div>
      <div class="field"><label for="a-phone">WhatsApp number</label><input type="tel" id="a-phone" autocomplete="off" inputmode="tel" placeholder="e.g. 0300 1234567"><span class="hint">The QR code is sent to this number.</span></div>
      <div class="row-2">
        ${owner ? `<div class="field"><label for="a-trainer">Trainer</label><select id="a-trainer">${options}</select></div>` : ''}
        <div class="field"><label for="a-months">Package</label><select id="a-months"><option value="1">1 month</option><option value="2">2 months</option><option value="3">3 months</option></select></div>
      </div>
      ${waOn()
        ? `<label class="check"><input type="checkbox" id="a-send"${session.me.autoSend ? ' checked' : ''}> Send the QR code on WhatsApp now</label>`
        : '<p class="hint">WhatsApp is not connected. After adding, you can send the QR code with one tap from your own WhatsApp.</p>'}
      <div class="dialog-actions"><button class="btn" type="button" data-action="close">Cancel</button><button class="btn btn-primary" type="submit" id="a-submit">${icon('qr')}Add member</button></div>
    </form>`);
  $('#add-form').addEventListener('submit', async e => {
    e.preventDefault();
    const body = { name: $('#a-name').value, phone: $('#a-phone').value, months: Number($('#a-months').value), send: !!$('#a-send')?.checked };
    if (owner) body.trainerId = Number($('#a-trainer').value);
    const r = await busy($('#a-submit'), () => api('/members', { method: 'POST', body }), $('#add-err'));
    if (!r) return;
    members.push(r.member);
    toast(r.send.sent ? `${r.member.name} added and QR code sent` : `${r.member.name} added`);
    openMember(r.member, { send: body.send ? r.send : null, created: true });
    session.refresh();
  });
}

export async function openEditMember(id) {
  const m = memberById(id); if (!m) return;
  const owner = isOwner();
  openModal(`Edit ${m.name}`, `
    <form class="form" id="edit-form" novalidate>
      <div class="form-error" id="e-err" hidden></div>
      <div class="field"><label for="e-name">Member name</label><input type="text" id="e-name" value="${esc(m.name)}"></div>
      <div class="field"><label for="e-phone">WhatsApp number</label><input type="tel" id="e-phone" inputmode="tel" value="${esc(m.phone)}"></div>
      ${owner ? `<div class="field"><label for="e-trainer">Trainer</label><select id="e-trainer">${await trainerOptions(m.trainer.id)}</select></div>` : ''}
      <div class="dialog-actions"><button class="btn" type="button" data-action="open-member" data-id="${m.id}">Cancel</button><button class="btn btn-primary" type="submit" id="e-submit">Save</button></div>
    </form>`);
  $('#edit-form').addEventListener('submit', async e => {
    e.preventDefault();
    const body = { name: $('#e-name').value, phone: $('#e-phone').value };
    if (owner) body.trainerId = Number($('#e-trainer').value);
    const r = await busy($('#e-submit'), () => api(`/members/${m.id}`, { method: 'PATCH', body }), $('#e-err'));
    if (!r) return;
    toast('Saved'); openMember(r.member); session.refresh();
  });
}

export function openRenew(id) {
  const m = memberById(id); if (!m) return;
  const v = statusView(m.status);
  const carry = m.status.key === 'valid' && m.status.days > 0;
  openModal(`New month for ${m.name}`, `
    <form class="form" id="renew-form">
      <div class="form-error" id="r-err" hidden></div>
      <p>${esc(m.name)} gets a new QR code. The old QR code stops working.${carry ? ` The ${esc(v.note.replace(' left', ''))} still left are added on.` : ''}</p>
      <div class="field"><label for="r-months">Add</label><select id="r-months"><option value="1">1 month</option><option value="2">2 months</option><option value="3">3 months</option></select></div>
      ${waOn() ? `<label class="check"><input type="checkbox" id="r-send" checked> Send the new QR code on WhatsApp</label>` : ''}
      <div class="dialog-actions"><button class="btn" type="button" data-action="open-member" data-id="${m.id}">Cancel</button><button class="btn btn-primary" type="submit" id="r-submit">${icon('renew')}Make new QR code</button></div>
    </form>`);
  $('#renew-form').addEventListener('submit', async e => {
    e.preventDefault();
    const send = !!$('#r-send')?.checked;
    const r = await busy($('#r-submit'), () => api(`/members/${m.id}/renew`, { method: 'POST', body: { months: Number($('#r-months').value), send } }), $('#r-err'));
    if (!r) return;
    toast(r.send.sent ? 'New QR code made and sent' : 'New QR code made');
    openMember(r.member, { send: send ? r.send : null });
    session.refresh();
  });
}

export function openDeleteMember(id) {
  const m = memberById(id); if (!m) return;
  openModal('Delete member?', `
    <p>Delete <strong>${esc(m.name)}</strong>? Their QR code will stop working. This can't be undone.</p>
    <div class="dialog-actions"><button class="btn" type="button" data-action="open-member" data-id="${m.id}">Cancel</button><button class="btn btn-danger-solid" type="button" data-action="confirm-delete-member" data-id="${m.id}">${icon('trash')}Delete</button></div>`);
}

export async function deleteMember(btn, id) {
  const m = memberById(id);
  const r = await busy(btn, () => api(`/members/${id}`, { method: 'DELETE' }));
  if (!r) return;
  members = members.filter(x => x.id !== Number(id));
  closeModal(); toast(`${m?.name ?? 'Member'} deleted`); session.refresh();
}

export async function loadMember(id) {
  if (!memberById(id)) members = await api('/members');
  return memberById(id);
}
