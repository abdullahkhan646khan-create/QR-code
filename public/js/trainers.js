import { $, esc, icon, initials, plural, session, api, openModal, closeModal, toast, busy, makePassword, copyText } from './core.js';

let trainers = [];
const byId = id => trainers.find(t => t.id === Number(id));
const usernameFrom = name => name.toLowerCase().split(/\s+/)[0]?.replace(/[^a-z0-9]/g, '').slice(0, 20) || '';

export async function renderTrainers(view) {
  view.innerHTML = `
    <div class="page-head">
      <div><h1>Trainers</h1><p>Each trainer gets their own login. They only see and add their own members.</p></div>
      <div class="page-actions"><button class="btn btn-primary" type="button" data-action="add-trainer">${icon('plus')}Add trainer</button></div>
    </div>
    <div class="tgrid" id="t-grid"><div class="card empty">Loading trainers…</div></div>`;
  trainers = await api('/trainers');
  const grid = $('#t-grid');
  if (!trainers.length) { grid.innerHTML = '<div class="card empty" style="grid-column:1/-1">No trainers yet. Press <b>Add trainer</b> to create the first login.</div>'; return; }
  grid.innerHTML = trainers.map(t => `
    <article class="card tcard">
      <div class="tcard-top">
        <div class="avatar">${esc(initials(t.name))}</div>
        <div class="who"><strong>${esc(t.name)}</strong><span>@${esc(t.username)}${t.phone ? ` · ${esc(t.phone)}` : ''}</span></div>
        ${t.active ? `<span class="pill ${t.whatsapp ? 'valid' : 'off'}" title="${t.whatsapp ? 'Sends QR codes from their own WhatsApp' : "Uses the gym's WhatsApp"}">${t.whatsapp ? 'WhatsApp' : 'No WhatsApp'}</span>` : '<span class="pill off">Login off</span>'}
      </div>
      <div class="tcard-nums">
        <div><b>${t.members}</b><span>Members</span></div>
        <div><b style="color:var(--ok)">${t.valid}</b><span>Valid</span></div>
        <div><b style="color:${t.expired ? 'var(--bad)' : 'inherit'}">${t.expired}</b><span>Expired</span></div>
      </div>
      <div class="tcard-acts">
        <button class="btn btn-sm" type="button" data-go="members" data-trainer="${t.id}">${icon('members', 16)}Members</button>
        <button class="btn btn-sm" type="button" data-action="add-member-for" data-id="${t.id}">${icon('plus', 16)}Add member</button>
        <button class="btn btn-sm btn-quiet" type="button" data-action="edit-trainer" data-id="${t.id}">${icon('edit', 16)}Edit</button>
        <button class="btn btn-sm btn-quiet btn-danger" type="button" data-action="delete-trainer" data-id="${t.id}">${icon('trash', 16)}Delete</button>
      </div>
    </article>`).join('');
}

function loginText(t, password) {
  return `Hi ${t.name.split(' ')[0]}, here is your Trainer Pass login for ${session.me.gymName}.\n\nLink: ${location.origin}\nUsername: ${t.username}\nPassword: ${password}\n\nLog in to add your members and send them their QR codes.`;
}

function showLogin(t, password, title) {
  const text = loginText(t, password);
  const phone = t.phone ? t.phone.replace(/\D/g, '') : '';
  openModal(title, `
    <p>Give these login details to <strong>${esc(t.name)}</strong>. The password is shown only now.</p>
    <div class="creds">
      <div><span class="muted">Link</span><code>${esc(location.origin)}</code></div>
      <div><span class="muted">Username</span><code>${esc(t.username)}</code></div>
      <div><span class="muted">Password</span><code>${esc(password)}</code></div>
    </div>
    <div class="btn-row">
      ${phone ? `<a class="btn btn-wa" href="https://wa.me/${phone}?text=${encodeURIComponent(text)}" target="_blank" rel="noopener">${icon('send')}Send on WhatsApp</a>` : ''}
      <button class="btn" type="button" id="copy-login">${icon('copy')}Copy login details</button>
    </div>
    <div class="dialog-actions"><button class="btn btn-primary" type="button" data-action="close">Done</button></div>`);
  $('#copy-login').addEventListener('click', () => copyText(text));
}

export function openAddTrainer() {
  const pw = makePassword();
  openModal('Add trainer', `
    <form class="form" id="t-form" novalidate>
      <div class="form-error" id="t-err" hidden></div>
      <div class="field"><label for="t-name">Trainer name</label><input type="text" id="t-name" autocomplete="off" placeholder="e.g. Kamran Ali"></div>
      <div class="field"><label for="t-phone">WhatsApp number <span class="muted">(optional)</span></label><input type="tel" id="t-phone" inputmode="tel" autocomplete="off" placeholder="e.g. 0300 1234567"><span class="hint">Used to send the trainer their login.</span></div>
      <div class="row-2">
        <div class="field"><label for="t-user">Username</label><input type="text" id="t-user" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="e.g. kamran"></div>
        <div class="field"><label for="t-pass">Password</label><div class="input-group"><input type="text" id="t-pass" autocomplete="off" value="${esc(pw)}"><button class="btn" type="button" id="t-gen" aria-label="Make a new password">${icon('renew', 16)}</button></div></div>
      </div>
      <div class="dialog-actions"><button class="btn" type="button" data-action="close">Cancel</button><button class="btn btn-primary" type="submit" id="t-submit">${icon('plus')}Create trainer login</button></div>
    </form>`);
  let touched = false;
  $('#t-user').addEventListener('input', () => { touched = true; });
  $('#t-name').addEventListener('input', e => { if (!touched) $('#t-user').value = usernameFrom(e.target.value); });
  $('#t-gen').addEventListener('click', () => { $('#t-pass').value = makePassword(); });
  $('#t-form').addEventListener('submit', async e => {
    e.preventDefault();
    const body = { name: $('#t-name').value, phone: $('#t-phone').value, username: $('#t-user').value.trim().toLowerCase(), password: $('#t-pass').value };
    const r = await busy($('#t-submit'), () => api('/trainers', { method: 'POST', body }), $('#t-err'));
    if (!r) return;
    toast(`${r.name} added`);
    showLogin(r, body.password, 'Trainer login created');
    session.refresh();
  });
}

export function openEditTrainer(id) {
  const t = byId(id); if (!t) return;
  openModal(`Edit ${t.name}`, `
    <form class="form" id="te-form" novalidate>
      <div class="form-error" id="te-err" hidden></div>
      <div class="field"><label for="te-name">Trainer name</label><input type="text" id="te-name" value="${esc(t.name)}"></div>
      <div class="field"><label for="te-phone">WhatsApp number</label><input type="tel" id="te-phone" inputmode="tel" value="${esc(t.phone || '')}"></div>
      <div class="field"><label>Username</label><div class="muted">@${esc(t.username)}</div></div>
      <div class="dialog-actions"><button class="btn" type="button" data-action="close">Cancel</button><button class="btn btn-primary" type="submit" id="te-submit">Save</button></div>
    </form>
    <div class="note" style="display:flex;flex-direction:column;gap:10px">
      <strong style="color:var(--ink)">Login</strong>
      <div class="btn-row">
        <button class="btn btn-sm" type="button" data-action="reset-trainer-pw" data-id="${t.id}">${icon('key', 16)}New password</button>
        <button class="btn btn-sm" type="button" data-action="toggle-trainer" data-id="${t.id}">${t.active ? 'Turn login off' : 'Turn login on'}</button>
        <button class="btn btn-sm btn-quiet btn-danger" type="button" data-action="delete-trainer" data-id="${t.id}">${icon('trash', 16)}Delete trainer</button>
      </div>
      <span>${t.active ? 'Turning the login off stops this trainer from logging in. Their members keep their QR codes.' : 'This trainer cannot log in right now.'}</span>
    </div>`);
  $('#te-form').addEventListener('submit', async e => {
    e.preventDefault();
    const r = await busy($('#te-submit'), () => api(`/trainers/${t.id}`, { method: 'PATCH', body: { name: $('#te-name').value, phone: $('#te-phone').value } }), $('#te-err'));
    if (!r) return;
    closeModal(); toast('Saved'); session.refresh();
  });
}

export async function resetTrainerPassword(btn, id) {
  const t = byId(id); if (!t) return;
  const password = makePassword();
  const r = await busy(btn, () => api(`/trainers/${t.id}`, { method: 'PATCH', body: { password } }));
  if (!r) return;
  showLogin(t, password, 'New password made');
}

export async function toggleTrainer(btn, id) {
  const t = byId(id); if (!t) return;
  const r = await busy(btn, () => api(`/trainers/${t.id}`, { method: 'PATCH', body: { active: !t.active } }));
  if (!r) return;
  closeModal(); toast(t.active ? `${t.name} can no longer log in` : `${t.name} can log in again`); session.refresh();
}

export function confirmDeleteTrainer(id) {
  const t = byId(id); if (!t) return;
  const others = trainers.filter(x => x.id !== t.id && x.active);
  const choice = t.members === 0 ? '' : `
    <p><strong>${esc(t.name)}</strong> has ${plural(t.members, 'member')}. What should happen to them?</p>
    <div class="form" style="gap:12px">
      ${others.length ? `<label class="check"><input type="radio" name="dt-choice" value="move" checked>
        <span style="display:flex;flex-direction:column;gap:6px;flex:1">Move them to another trainer (their QR codes keep working)
        <select id="dt-to" aria-label="Move members to">${others.map(o => `<option value="${o.id}">${esc(o.name)}</option>`).join('')}</select></span></label>` : ''}
      <label class="check"><input type="radio" name="dt-choice" value="delete"${others.length ? '' : ' checked'}> Delete them and their QR codes</label>
    </div>`;
  openModal('Delete trainer?', `
    <div class="form-error" id="dt-err" hidden></div>
    ${choice}
    <p>${t.members === 0 ? `Delete <strong>${esc(t.name)}</strong> and their login?` : 'The trainer and their login will be deleted.'} This can't be undone.</p>
    <div class="dialog-actions"><button class="btn" type="button" data-action="close">Cancel</button><button class="btn btn-danger-solid" type="button" data-action="confirm-delete-trainer" data-id="${t.id}">${icon('trash')}Delete trainer</button></div>`);
}

export async function deleteTrainer(btn, id) {
  const t = byId(id); if (!t) return;
  const move = t.members > 0 && document.querySelector('input[name="dt-choice"]:checked')?.value === 'move';
  const target = move ? byId($('#dt-to').value) : null;
  const query = !t.members ? '' : move ? `?moveTo=${target.id}` : '?deleteMembers=1';
  const r = await busy(btn, () => api(`/trainers/${id}${query}`, { method: 'DELETE' }), $('#dt-err'));
  if (!r) return;
  closeModal();
  toast(!t.members ? `${t.name} deleted` : move ? `${t.name} deleted. Members moved to ${target.name}.` : `${t.name} and ${plural(t.members, 'member')} deleted`);
  session.refresh();
}
