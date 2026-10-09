import { Router } from 'express';
import QRCode from 'qrcode';
import { q, one, getSetting, setSetting, createPass } from './db.js';
import { hashPassword, verifyPassword, setSession, clearSession, requireUser, requireOwner, loginAllowed, loginFailed, loginSucceeded } from './auth.js';
import { todayISO, addDays, packageEnd, passStatus, fmtDate, normalizePhone, formatPhone, cleanText, TIMEZONE } from './util.js';
import { whatsappState, whatsappReady, connectWhatsApp, disconnectWhatsApp, sendImage, sendText } from './whatsapp.js';

export const api = Router();

class UserError extends Error { constructor(status, message) { super(message); this.status = status; } }
const fail = (status, message) => { throw new UserError(status, message); };

const baseUrl = req => (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
const passUrl = (req, token) => `${baseUrl(req)}/p/${token}`;
const qrPng = text => QRCode.toBuffer(text, { width: 640, margin: 2, errorCorrectionLevel: 'M' });
const gymName = () => getSetting('gym_name', 'Our Gym');

/* ---------- members: shared query and shape ---------- */
const MEMBER_SQL = `
  select m.id, m.name, m.phone, m.trainer_id, u.name as trainer_name, m.created_at,
         p.id as pass_id, p.token, p.start_date, p.end_date, p.revoked, p.sent_at
  from members m
  join users u on u.id = m.trainer_id
  left join lateral (select * from passes where member_id = m.id order by id desc limit 1) p on true`;

async function caption(row, url) {
  const first = row.name.split(' ')[0];
  return `Hello ${first}, here is your personal training QR code at ${await gymName()}.\n\n`
    + `Trainer: ${row.trainer_name}\nValid: ${fmtDate(row.start_date)} to ${fmtDate(row.end_date)}\n\n`
    + `Show this QR code at the gym when you come to train.\n${url}`;
}

async function shapeMember(req, row) {
  const pass = row.pass_id ? { start_date: row.start_date, end_date: row.end_date, revoked: row.revoked } : null;
  const url = row.token ? passUrl(req, row.token) : null;
  return {
    id: row.id, name: row.name, phone: formatPhone(row.phone),
    trainer: { id: row.trainer_id, name: row.trainer_name },
    pass: row.pass_id ? { id: row.pass_id, token: row.token, start: row.start_date, end: row.end_date, sentAt: row.sent_at, url } : null,
    status: passStatus(pass),
    waLink: url ? `https://wa.me/${row.phone}?text=${encodeURIComponent(await caption(row, url))}` : null,
  };
}

async function memberRow(id) {
  return one(`${MEMBER_SQL} where m.id = $1`, [id]);
}

// Owners reach every member; trainers only their own.
async function accessibleMember(req, id) {
  const row = await memberRow(Number(id));
  if (!row || (req.user.role === 'trainer' && row.trainer_id !== req.user.id)) fail(404, 'Member not found.');
  return row;
}

// Sends the member's current QR code on WhatsApp. Never throws: returns what happened.
async function sendPass(req, row) {
  try {
    const url = passUrl(req, row.token);
    await sendImage(row.phone, await qrPng(url), await caption(row, url));
    await q('update passes set sent_at = now() where id = $1', [row.pass_id]);
    return { sent: true };
  } catch (err) {
    return { sent: false, error: err.message || 'Sending failed.' };
  }
}

/* ---------- login ---------- */
api.post('/login', async (req, res) => {
  const username = cleanText(req.body?.username, 40).toLowerCase();
  const key = `${req.ip}|${username}`;
  if (!loginAllowed(key)) fail(429, 'Too many tries. Wait 10 minutes and try again.');
  const user = await one('select * from users where username = $1 and active', [username]);
  if (!user || !(await verifyPassword(req.body?.password || '', user.password_hash))) {
    loginFailed(key);
    fail(401, 'Wrong username or password.');
  }
  loginSucceeded(key);
  await setSession(res, user.id);
  res.json({ ok: true, role: user.role });
});

api.post('/logout', (req, res) => { clearSession(res); res.json({ ok: true }); });

api.get('/me', requireUser, async (req, res) => {
  res.json({
    user: req.user,
    gymName: await gymName(),
    countryCode: await getSetting('country_code', '92'),
    autoSend: (await getSetting('auto_send', 'true')) === 'true',
    whatsapp: { connected: whatsappReady() },
  });
});

api.post('/me/password', requireUser, async (req, res) => {
  const user = await one('select password_hash from users where id = $1', [req.user.id]);
  if (!(await verifyPassword(req.body?.current || '', user.password_hash))) fail(400, 'Your current password is wrong.');
  checkPassword(req.body?.next);
  await q('update users set password_hash = $1 where id = $2', [await hashPassword(req.body.next), req.user.id]);
  res.json({ ok: true });
});

/* ---------- overview ---------- */
api.get('/overview', requireUser, async (req, res) => {
  const mine = req.user.role === 'trainer';
  const rows = await q(`${MEMBER_SQL} ${mine ? 'where m.trainer_id = $1' : ''} order by m.name`, mine ? [req.user.id] : []);
  const statuses = rows.map(r => passStatus(r.pass_id ? r : null));
  const count = key => statuses.filter(s => s.key === key).length;
  const today = todayISO();
  const scanWhere = mine ? 'and s.trainer_id = $3' : '';
  const scansToday = await one(`select count(*)::int as n from scans s where (s.created_at at time zone $1)::date = $2::date ${scanWhere}`,
    mine ? [TIMEZONE, today, req.user.id] : [TIMEZONE, today]);
  const recent = await q(`
    select s.id, s.result, s.created_at, m.name as member_name, t.name as trainer_name, b.name as scanned_by
    from scans s left join members m on m.id = s.member_id left join users t on t.id = s.trainer_id left join users b on b.id = s.scanned_by
    ${mine ? 'where s.trainer_id = $1' : ''} order by s.id desc limit 8`, mine ? [req.user.id] : []);
  const expiring = rows.map((r, i) => ({ r, s: statuses[i] })).filter(x => x.s.key === 'valid' && x.s.days <= 5)
    .sort((a, b) => a.s.days - b.s.days).slice(0, 6);
  res.json({
    members: rows.length, valid: count('valid'), expired: count('expired'), expiringSoon: expiring.length,
    trainers: mine ? null : (await one(`select count(*)::int as n from users where role = 'trainer' and active`)).n,
    scansToday: scansToday.n,
    expiring: await Promise.all(expiring.map(x => shapeMember(req, x.r))),
    recentScans: recent,
    whatsapp: whatsappState().status,
  });
});

/* ---------- trainers (owner) ---------- */
api.get('/trainers', requireOwner, async (req, res) => {
  const trainers = await q(`select id, name, username, phone, active, created_at from users where role = 'trainer' order by active desc, name`);
  const rows = await q(MEMBER_SQL);
  res.json(trainers.map(t => {
    const mine = rows.filter(r => r.trainer_id === t.id).map(r => passStatus(r.pass_id ? r : null));
    return { ...t, phone: formatPhone(t.phone), members: mine.length, valid: mine.filter(s => s.key === 'valid').length, expired: mine.filter(s => s.key === 'expired').length };
  }));
});

function checkUsername(u) {
  if (!/^[a-z0-9._-]{3,30}$/.test(u)) fail(400, 'Username: 3 to 30 letters or numbers, no spaces.');
}
function checkPassword(p) {
  if (String(p || '').length < 6) fail(400, 'Password must be at least 6 characters.');
}

api.post('/trainers', requireOwner, async (req, res) => {
  const name = cleanText(req.body?.name, 60), username = cleanText(req.body?.username, 30).toLowerCase(), password = String(req.body?.password || '');
  if (name.length < 2) fail(400, "Enter the trainer's name.");
  checkUsername(username); checkPassword(password);
  const phone = req.body?.phone ? normalizePhone(req.body.phone, await getSetting('country_code', '92')) : null;
  if (req.body?.phone && !phone) fail(400, 'That phone number looks wrong.');
  if (await one('select id from users where username = $1', [username])) fail(409, `The username "${username}" is taken. Pick another.`);
  const t = await one(`insert into users (role, name, username, password_hash, phone) values ('trainer', $1, $2, $3, $4) returning id, name, username, phone`,
    [name, username, await hashPassword(password), phone]);
  res.status(201).json({ ...t, phone: formatPhone(t.phone) });
});

api.patch('/trainers/:id', requireOwner, async (req, res) => {
  const t = await one(`select * from users where id = $1 and role = 'trainer'`, [Number(req.params.id)]);
  if (!t) fail(404, 'Trainer not found.');
  const name = req.body?.name !== undefined ? cleanText(req.body.name, 60) : t.name;
  if (name.length < 2) fail(400, "Enter the trainer's name.");
  let phone = t.phone;
  if (req.body?.phone !== undefined) {
    phone = req.body.phone ? normalizePhone(req.body.phone, await getSetting('country_code', '92')) : null;
    if (req.body.phone && !phone) fail(400, 'That phone number looks wrong.');
  }
  let hash = t.password_hash;
  if (req.body?.password) { checkPassword(req.body.password); hash = await hashPassword(req.body.password); }
  const active = typeof req.body?.active === 'boolean' ? req.body.active : t.active;
  await q('update users set name = $1, phone = $2, password_hash = $3, active = $4 where id = $5', [name, phone, hash, active, t.id]);
  res.json({ ok: true });
});

api.delete('/trainers/:id', requireOwner, async (req, res) => {
  const id = Number(req.params.id);
  const n = (await one('select count(*)::int as n from members where trainer_id = $1', [id])).n;
  if (n > 0) fail(409, `This trainer still has ${n} member${n === 1 ? '' : 's'}. Move them to another trainer first, or turn off the login instead.`);
  await q(`update scans set trainer_id = null, scanned_by = null where trainer_id = $1 or scanned_by = $1`, [id]);
  await q(`delete from users where id = $1 and role = 'trainer'`, [id]);
  res.json({ ok: true });
});

/* ---------- members ---------- */
api.get('/members', requireUser, async (req, res) => {
  const trainerId = req.user.role === 'trainer' ? req.user.id : (req.query.trainer ? Number(req.query.trainer) : null);
  const rows = await q(`${MEMBER_SQL} ${trainerId ? 'where m.trainer_id = $1' : ''} order by m.name`, trainerId ? [trainerId] : []);
  res.json(await Promise.all(rows.map(r => shapeMember(req, r))));
});

async function readMemberInput(req) {
  const name = cleanText(req.body?.name, 60);
  if (name.length < 2) fail(400, "Enter the member's name.");
  const phone = normalizePhone(req.body?.phone, await getSetting('country_code', '92'));
  if (!phone) fail(400, 'Enter a WhatsApp number, for example 0300 1234567.');
  let trainerId = req.user.id;
  if (req.user.role === 'owner') {
    trainerId = Number(req.body?.trainerId);
    if (!(await one(`select id from users where id = $1 and role = 'trainer' and active`, [trainerId]))) fail(400, 'Pick a trainer.');
  }
  return { name, phone, trainerId };
}

api.post('/members', requireUser, async (req, res) => {
  const { name, phone, trainerId } = await readMemberInput(req);
  const months = Math.min(Math.max(Number(req.body?.months) || 1, 1), 12);
  const m = await one('insert into members (trainer_id, name, phone) values ($1, $2, $3) returning id', [trainerId, name, phone]);
  const start = todayISO();
  await createPass(m.id, start, packageEnd(start, months));
  let row = await memberRow(m.id);
  const send = req.body?.send !== false && whatsappReady() ? await sendPass(req, row) : { sent: false, error: whatsappReady() ? null : 'WhatsApp is not connected.' };
  row = await memberRow(m.id);
  res.status(201).json({ member: await shapeMember(req, row), send });
});

api.patch('/members/:id', requireUser, async (req, res) => {
  const row = await accessibleMember(req, req.params.id);
  const name = req.body?.name !== undefined ? cleanText(req.body.name, 60) : row.name;
  if (name.length < 2) fail(400, "Enter the member's name.");
  let phone = row.phone;
  if (req.body?.phone !== undefined) {
    phone = normalizePhone(req.body.phone, await getSetting('country_code', '92'));
    if (!phone) fail(400, 'Enter a WhatsApp number, for example 0300 1234567.');
  }
  let trainerId = row.trainer_id;
  if (req.user.role === 'owner' && req.body?.trainerId) {
    trainerId = Number(req.body.trainerId);
    if (!(await one(`select id from users where id = $1 and role = 'trainer'`, [trainerId]))) fail(400, 'Pick a trainer.');
  }
  await q('update members set name = $1, phone = $2, trainer_id = $3 where id = $4', [name, phone, trainerId, row.id]);
  res.json({ member: await shapeMember(req, await memberRow(row.id)) });
});

api.delete('/members/:id', requireUser, async (req, res) => {
  const row = await accessibleMember(req, req.params.id);
  await q('update scans set member_id = null where member_id = $1', [row.id]);
  await q('delete from members where id = $1', [row.id]);
  res.json({ ok: true });
});

// New month: a fresh QR code. If the old one still has days left, they carry over. The old code stops working.
api.post('/members/:id/renew', requireUser, async (req, res) => {
  const row = await accessibleMember(req, req.params.id);
  const months = Math.min(Math.max(Number(req.body?.months) || 1, 1), 12);
  const today = todayISO();
  const stillValid = row.pass_id && !row.revoked && row.end_date >= today;
  const end = stillValid ? packageEnd(addDays(row.end_date, 1), months) : packageEnd(today, months);
  await q('update passes set revoked = true where member_id = $1', [row.id]);
  await createPass(row.id, today, end);
  let fresh = await memberRow(row.id);
  const send = req.body?.send !== false && whatsappReady() ? await sendPass(req, fresh) : { sent: false, error: whatsappReady() ? null : 'WhatsApp is not connected.' };
  fresh = await memberRow(row.id);
  res.json({ member: await shapeMember(req, fresh), send });
});

api.post('/members/:id/send', requireUser, async (req, res) => {
  const row = await accessibleMember(req, req.params.id);
  if (!row.pass_id) fail(400, 'This member has no QR code yet.');
  const send = await sendPass(req, row);
  if (!send.sent) fail(502, send.error);
  res.json({ member: await shapeMember(req, await memberRow(row.id)), send });
});

api.get('/members/:id/qr.png', requireUser, async (req, res) => {
  const row = await accessibleMember(req, req.params.id);
  if (!row.token) fail(404, 'No QR code yet.');
  res.type('png').set('Cache-Control', 'no-store').send(await qrPng(passUrl(req, row.token)));
});

/* ---------- scanning ---------- */
const tokenFrom = code => {
  const text = String(code || '').trim();
  const m = text.match(/\/p\/([A-Za-z0-9_-]{8,64})/) || text.match(/^([A-Za-z0-9_-]{12,64})$/);
  return m ? m[1] : null;
};

api.post('/scan', requireUser, async (req, res) => {
  const token = tokenFrom(req.body?.code);
  const pass = token && await one(`
    select p.*, m.id as member_id, m.name as member_name, u.id as trainer_id, u.name as trainer_name
    from passes p join members m on m.id = p.member_id join users u on u.id = m.trainer_id where p.token = $1`, [token]);
  if (!pass) {
    await q('insert into scans (scanned_by, result) values ($1, $2)', [req.user.id, 'unknown']);
    return res.json({ result: 'unknown', message: `This QR code is not from ${await gymName()}.` });
  }
  const status = passStatus(pass);
  await q('insert into scans (pass_id, member_id, trainer_id, scanned_by, result) values ($1, $2, $3, $4, $5)',
    [pass.id, pass.member_id, pass.trainer_id, req.user.id, status.key]);
  const messages = {
    valid: `Trains under ${pass.trainer_name}`,
    expired: 'The package has ended. Ask the member to renew.',
    replaced: 'This is an old QR code. A newer one was sent to the member.',
    upcoming: `This QR code starts on ${fmtDate(pass.start_date)}.`,
  };
  res.json({
    result: status.key, days: status.days, message: messages[status.key],
    member: { id: pass.member_id, name: pass.member_name },
    trainer: { id: pass.trainer_id, name: pass.trainer_name },
    start: pass.start_date, end: pass.end_date,
  });
});

/* ---------- settings & WhatsApp (owner) ---------- */
api.patch('/settings', requireOwner, async (req, res) => {
  if (req.body?.gymName !== undefined) {
    const v = cleanText(req.body.gymName, 40); if (v.length < 2) fail(400, 'Enter the gym name.');
    await setSetting('gym_name', v);
  }
  if (req.body?.countryCode !== undefined) {
    const v = String(req.body.countryCode).replace(/\D/g, ''); if (!v || v.length > 4) fail(400, 'Country code is 1 to 4 digits, like 92.');
    await setSetting('country_code', v);
  }
  if (typeof req.body?.autoSend === 'boolean') await setSetting('auto_send', String(req.body.autoSend));
  if (req.body?.password) {
    checkPassword(req.body.password);
    await q('update users set password_hash = $1 where id = $2', [await hashPassword(req.body.password), req.user.id]);
  }
  res.json({ ok: true });
});

api.get('/whatsapp', requireOwner, (req, res) => res.json(whatsappState()));
api.post('/whatsapp/connect', requireOwner, async (req, res) => { await connectWhatsApp(); res.json(whatsappState()); });
api.post('/whatsapp/disconnect', requireOwner, async (req, res) => { await disconnectWhatsApp(); res.json(whatsappState()); });
api.post('/whatsapp/test', requireOwner, async (req, res) => {
  const phone = normalizePhone(req.body?.phone, await getSetting('country_code', '92'));
  if (!phone) fail(400, 'Enter a WhatsApp number.');
  try { await sendText(phone, `Test message from ${await gymName()}. WhatsApp is connected and QR codes can be sent.`); }
  catch (err) { fail(502, err.message); }
  res.json({ ok: true });
});

/* ---------- public member pass ---------- */
api.get('/public/pass/:token', async (req, res) => {
  const pass = await one(`
    select p.*, m.name as member_name, u.name as trainer_name
    from passes p join members m on m.id = p.member_id join users u on u.id = m.trainer_id where p.token = $1`, [req.params.token]);
  if (!pass) fail(404, 'This QR code was not found.');
  const status = passStatus(pass);
  res.json({ gymName: await gymName(), member: pass.member_name, trainer: pass.trainer_name, start: pass.start_date, end: pass.end_date, status, qr: `/p/${pass.token}/qr.png` });
});

export async function publicQrPng(req, res) {
  const pass = await one('select token from passes where token = $1', [req.params.token]);
  if (!pass) return res.status(404).send('Not found');
  res.type('png').set('Cache-Control', 'public, max-age=300').send(await qrPng(passUrl(req, pass.token)));
}

/* ---------- errors ---------- */
// eslint-disable-next-line no-unused-vars
export function apiErrors(err, req, res, _next) {
  if (err instanceof UserError) return res.status(err.status).json({ error: err.message });
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Bad request.' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server. Try again.' });
}
