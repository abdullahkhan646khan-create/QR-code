import { Router } from 'express';
import QRCode from 'qrcode';
import { getSetting, setSetting, users, members, passes, scans } from './store.js';
import { hashPassword, verifyPassword, setSession, clearSession, requireUser, requireOwner, loginAllowed, loginFailed, loginSucceeded } from './auth.js';
import { todayISO, addDays, packageEnd, passStatus, fmtDate, normalizePhone, formatPhone, cleanText, startOfTodayISO } from './util.js';
import { whatsappState, whatsappReady, connectWhatsApp, disconnectWhatsApp, sendImage, sendText } from './whatsapp.js';

export const api = Router();

class UserError extends Error { constructor(status, message) { super(message); this.status = status; } }
const fail = (status, message) => { throw new UserError(status, message); };

const baseUrl = req => (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
const passUrl = (req, token) => `${baseUrl(req)}/p/${token}`;
const qrPng = text => QRCode.toBuffer(text, { width: 640, margin: 2, errorCorrectionLevel: 'M' });
const gymName = () => getSetting('gym_name', 'Our Gym');
const countryCode = () => getSetting('country_code', '92');

/* ---------- members: shape for the app ---------- */
async function caption(row, url) {
  const first = row.name.split(' ')[0];
  return `Hello ${first}, here is your personal training QR code at ${await gymName()}.\n\n`
    + `Trainer: ${row.trainer_name}\nValid: ${fmtDate(row.start_date)} to ${fmtDate(row.end_date)}\n\n`
    + `Show this QR code at the gym when you come to train.\n${url}`;
}

async function shapeMember(req, row) {
  const url = row.token ? passUrl(req, row.token) : null;
  return {
    id: row.id, name: row.name, phone: formatPhone(row.phone),
    trainer: { id: row.trainer_id, name: row.trainer_name },
    pass: row.pass_id ? { id: row.pass_id, token: row.token, start: row.start_date, end: row.end_date, sentAt: row.sent_at, url } : null,
    status: passStatus(row.pass_id ? row : null),
    waLink: url ? `https://wa.me/${row.phone}?text=${encodeURIComponent(await caption(row, url))}` : null,
  };
}

// Owners reach every member; trainers only their own.
async function accessibleMember(req, id) {
  const row = await members.row(Number(id));
  if (!row || (req.user.role === 'trainer' && row.trainer_id !== req.user.id)) fail(404, 'Member not found.');
  return row;
}

// Sends the member's current QR code on WhatsApp. Never throws: returns what happened.
async function sendPass(req, row) {
  try {
    const url = passUrl(req, row.token);
    await sendImage(row.phone, await qrPng(url), await caption(row, url));
    await passes.markSent(row.pass_id);
    return { sent: true };
  } catch (err) {
    return { sent: false, error: err.message || 'Sending failed.' };
  }
}
const maybeSend = async (req, row) => (req.body?.send !== false && whatsappReady()
  ? sendPass(req, row)
  : { sent: false, error: whatsappReady() ? null : 'WhatsApp is not connected.' });

/* ---------- login ---------- */
api.post('/login', async (req, res) => {
  const username = cleanText(req.body?.username, 40).toLowerCase();
  const key = `${req.ip}|${username}`;
  if (!loginAllowed(key)) fail(429, 'Too many tries. Wait 10 minutes and try again.');
  const user = await users.activeByUsername(username);
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
    countryCode: await countryCode(),
    autoSend: (await getSetting('auto_send', 'true')) === 'true',
    whatsapp: { connected: whatsappReady() },
  });
});

api.post('/me/password', requireUser, async (req, res) => {
  const user = await users.byId(req.user.id);
  if (!(await verifyPassword(req.body?.current || '', user.password_hash))) fail(400, 'Your current password is wrong.');
  checkPassword(req.body?.next);
  await users.update(req.user.id, { password_hash: await hashPassword(req.body.next) });
  res.json({ ok: true });
});

/* ---------- overview ---------- */
api.get('/overview', requireUser, async (req, res) => {
  const trainerId = req.user.role === 'trainer' ? req.user.id : null;
  const [rows, scansToday, recent, trainerCount] = await Promise.all([
    members.list(trainerId), scans.countSince(startOfTodayISO(), trainerId), scans.recent(trainerId),
    trainerId ? null : users.countActiveTrainers(),
  ]);
  const statuses = rows.map(r => passStatus(r.pass_id ? r : null));
  const count = key => statuses.filter(s => s.key === key).length;
  const expiring = rows.map((r, i) => ({ r, s: statuses[i] })).filter(x => x.s.key === 'valid' && x.s.days <= 5)
    .sort((a, b) => a.s.days - b.s.days).slice(0, 6);
  res.json({
    members: rows.length, valid: count('valid'), expired: count('expired'), expiringSoon: expiring.length,
    trainers: trainerCount, scansToday,
    expiring: await Promise.all(expiring.map(x => shapeMember(req, x.r))),
    recentScans: recent,
    whatsapp: whatsappState().status,
  });
});

/* ---------- trainers (owner) ---------- */
api.get('/trainers', requireOwner, async (req, res) => {
  const [list, rows] = await Promise.all([users.trainers(), members.list()]);
  res.json(list.map(t => {
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
  const phone = req.body?.phone ? normalizePhone(req.body.phone, await countryCode()) : null;
  if (req.body?.phone && !phone) fail(400, 'That phone number looks wrong.');
  if (await users.usernameTaken(username)) fail(409, `The username "${username}" is taken. Pick another.`);
  const t = await users.insert({ role: 'trainer', name, username, password_hash: await hashPassword(password), phone });
  res.status(201).json({ ...t, phone: formatPhone(t.phone) });
});

api.patch('/trainers/:id', requireOwner, async (req, res) => {
  const t = await users.trainer(Number(req.params.id));
  if (!t) fail(404, 'Trainer not found.');
  const fields = {};
  if (req.body?.name !== undefined) {
    fields.name = cleanText(req.body.name, 60);
    if (fields.name.length < 2) fail(400, "Enter the trainer's name.");
  }
  if (req.body?.phone !== undefined) {
    fields.phone = req.body.phone ? normalizePhone(req.body.phone, await countryCode()) : null;
    if (req.body.phone && !fields.phone) fail(400, 'That phone number looks wrong.');
  }
  if (req.body?.password) { checkPassword(req.body.password); fields.password_hash = await hashPassword(req.body.password); }
  if (typeof req.body?.active === 'boolean') fields.active = req.body.active;
  if (Object.keys(fields).length) await users.update(t.id, fields);
  res.json({ ok: true });
});

api.delete('/trainers/:id', requireOwner, async (req, res) => {
  const id = Number(req.params.id);
  const n = await members.countForTrainer(id);
  if (n > 0) fail(409, `This trainer still has ${n} member${n === 1 ? '' : 's'}. Move them to another trainer first, or turn off the login instead.`);
  await users.removeTrainer(id);
  res.json({ ok: true });
});

/* ---------- members ---------- */
api.get('/members', requireUser, async (req, res) => {
  const trainerId = req.user.role === 'trainer' ? req.user.id : (req.query.trainer ? Number(req.query.trainer) : null);
  const rows = await members.list(trainerId);
  res.json(await Promise.all(rows.map(r => shapeMember(req, r))));
});

async function readMemberInput(req) {
  const name = cleanText(req.body?.name, 60);
  if (name.length < 2) fail(400, "Enter the member's name.");
  const phone = normalizePhone(req.body?.phone, await countryCode());
  if (!phone) fail(400, 'Enter a WhatsApp number, for example 0300 1234567.');
  let trainerId = req.user.id;
  if (req.user.role === 'owner') {
    trainerId = Number(req.body?.trainerId);
    if (!(await users.activeTrainer(trainerId))) fail(400, 'Pick a trainer.');
  }
  return { name, phone, trainerId };
}
const monthsFrom = req => Math.min(Math.max(Number(req.body?.months) || 1, 1), 12);

api.post('/members', requireUser, async (req, res) => {
  const { name, phone, trainerId } = await readMemberInput(req);
  const m = await members.insert({ trainer_id: trainerId, name, phone });
  const start = todayISO();
  await passes.create(m.id, start, packageEnd(start, monthsFrom(req)));
  const send = await maybeSend(req, await members.row(m.id));
  res.status(201).json({ member: await shapeMember(req, await members.row(m.id)), send });
});

api.patch('/members/:id', requireUser, async (req, res) => {
  const row = await accessibleMember(req, req.params.id);
  const fields = {};
  if (req.body?.name !== undefined) {
    fields.name = cleanText(req.body.name, 60);
    if (fields.name.length < 2) fail(400, "Enter the member's name.");
  }
  if (req.body?.phone !== undefined) {
    fields.phone = normalizePhone(req.body.phone, await countryCode());
    if (!fields.phone) fail(400, 'Enter a WhatsApp number, for example 0300 1234567.');
  }
  if (req.user.role === 'owner' && req.body?.trainerId && Number(req.body.trainerId) !== row.trainer_id) {
    if (!(await users.trainer(Number(req.body.trainerId)))) fail(400, 'Pick a trainer.');
    fields.trainer_id = Number(req.body.trainerId);
  }
  if (Object.keys(fields).length) await members.update(row.id, fields);
  res.json({ member: await shapeMember(req, await members.row(row.id)) });
});

api.delete('/members/:id', requireUser, async (req, res) => {
  const row = await accessibleMember(req, req.params.id);
  await members.remove(row.id);
  res.json({ ok: true });
});

// New month: a fresh QR code. If the old one still has days left, they carry over. The old code stops working.
api.post('/members/:id/renew', requireUser, async (req, res) => {
  const row = await accessibleMember(req, req.params.id);
  const today = todayISO();
  const stillValid = row.pass_id && !row.revoked && row.end_date >= today;
  const end = stillValid ? packageEnd(addDays(row.end_date, 1), monthsFrom(req)) : packageEnd(today, monthsFrom(req));
  await passes.revokeAll(row.id);
  await passes.create(row.id, today, end);
  const send = await maybeSend(req, await members.row(row.id));
  res.json({ member: await shapeMember(req, await members.row(row.id)), send });
});

api.post('/members/:id/send', requireUser, async (req, res) => {
  const row = await accessibleMember(req, req.params.id);
  if (!row.pass_id) fail(400, 'This member has no QR code yet.');
  const send = await sendPass(req, row);
  if (!send.sent) fail(502, send.error);
  res.json({ member: await shapeMember(req, await members.row(row.id)), send });
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
  const pass = token ? await passes.byToken(token) : null;
  if (!pass) {
    await scans.add({ scanned_by: req.user.id, result: 'unknown' });
    return res.json({ result: 'unknown', message: `This QR code is not from ${await gymName()}.` });
  }
  const status = passStatus(pass);
  await scans.add({ pass_id: pass.id, member_id: pass.member_id, trainer_id: pass.trainer_id, scanned_by: req.user.id, result: status.key });
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
  res.json({ ok: true });
});

api.get('/whatsapp', requireOwner, (req, res) => res.json(whatsappState()));
api.post('/whatsapp/connect', requireOwner, async (req, res) => { await connectWhatsApp(); res.json(whatsappState()); });
api.post('/whatsapp/disconnect', requireOwner, async (req, res) => { await disconnectWhatsApp(); res.json(whatsappState()); });
api.post('/whatsapp/test', requireOwner, async (req, res) => {
  const phone = normalizePhone(req.body?.phone, await countryCode());
  if (!phone) fail(400, 'Enter a WhatsApp number.');
  try { await sendText(phone, `Test message from ${await gymName()}. WhatsApp is connected and QR codes can be sent.`); }
  catch (err) { fail(502, err.message); }
  res.json({ ok: true });
});

/* ---------- public member pass ---------- */
api.get('/public/pass/:token', async (req, res) => {
  const pass = await passes.byToken(req.params.token);
  if (!pass) fail(404, 'This QR code was not found.');
  res.json({ gymName: await gymName(), member: pass.member_name, trainer: pass.trainer_name, start: pass.start_date, end: pass.end_date, status: passStatus(pass), qr: `/p/${pass.token}/qr.png` });
});

export async function publicQrPng(req, res) {
  if (!(await passes.tokenExists(req.params.token))) return res.status(404).send('Not found');
  res.type('png').set('Cache-Control', 'public, max-age=300').send(await qrPng(passUrl(req, req.params.token)));
}

/* ---------- errors ---------- */
// eslint-disable-next-line no-unused-vars
export function apiErrors(err, req, res, _next) {
  if (err instanceof UserError) return res.status(err.status).json({ error: err.message });
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Bad request.' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server. Try again.' });
}
