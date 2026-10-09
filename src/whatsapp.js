import makeWASocket, { Browsers, BufferJSON, DisconnectReason, fetchLatestBaileysVersion, initAuthCreds, proto } from 'baileys';
import pino from 'pino';
import QRCode from 'qrcode';
import { waAuth } from './store.js';

// Links WhatsApp numbers like WhatsApp Web (unofficial). One connection per person:
// 'gym' is the owner's (the gym's number), 't<id>' is a trainer's own number.
// Each login is kept in the wa_auth table under its own key prefix, so it survives restarts and Render's sleep.
const logger = pino({ level: process.env.WA_LOG_LEVEL || 'silent' });
const sessions = new Map();

export const GYM = 'gym';
export const trainerSession = trainerId => `t${trainerId}`;
export const sessionFor = user => (user.role === 'owner' ? GYM : trainerSession(user.id));

function get(id) {
  if (!sessions.has(id)) sessions.set(id, { id, status: 'disconnected', qrDataUrl: null, me: null, sock: null, wanted: false, error: null, starting: false, justLinked: false });
  return sessions.get(id);
}

const encode = value => JSON.stringify(value, BufferJSON.replacer);
const decode = text => JSON.parse(text, BufferJSON.reviver);

async function authState(id) {
  const p = `${id}:`;
  const found = await waAuth.getMany([`${p}creds`]);
  const creds = found[`${p}creds`] ? decode(found[`${p}creds`]) : initAuthCreds();
  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const rows = await waAuth.getMany(ids.map(k => `${p}${type}-${k}`));
          const data = {};
          for (const k of ids) {
            let value = rows[`${p}${type}-${k}`] ? decode(rows[`${p}${type}-${k}`]) : null;
            if (type === 'app-state-sync-key' && value) value = proto.Message.AppStateSyncKeyData.fromObject(value);
            data[k] = value;
          }
          return data;
        },
        set: async data => {
          const upserts = [], deletes = [];
          for (const category of Object.keys(data)) {
            for (const k of Object.keys(data[category])) {
              const value = data[category][k];
              if (value) upserts.push({ key: `${p}${category}-${k}`, value: encode(value) }); else deletes.push(`${p}${category}-${k}`);
            }
          }
          if (upserts.length) await waAuth.setMany(upserts);
          if (deletes.length) await waAuth.deleteMany(deletes);
        },
      },
    },
    saveCreds: () => waAuth.setMany([{ key: `${p}creds`, value: encode(creds) }]),
  };
}

async function start(id) {
  const s = get(id);
  if (s.sock || s.starting) return;
  s.starting = true;
  s.error = null;
  if (s.status !== 'connected') s.status = 'connecting';
  try {
    const { state, saveCreds } = await authState(id);
    let version;
    try { ({ version } = await fetchLatestBaileysVersion()); } catch { /* use the library default */ }
    const sock = makeWASocket({
      auth: state, logger, version, browser: Browsers.macOS('Chrome'),
      markOnlineOnConnect: false, syncFullHistory: false, generateHighQualityLinkPreview: false,
      shouldSyncHistoryMessage: () => false, // old chats aren't needed to send QR codes; skipping them makes linking quick
    });
    s.sock = sock;
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
      if (qr) { s.status = 'qr'; s.justLinked = true; s.qrDataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 360 }); }
      if (connection === 'open') {
        s.status = 'connected'; s.qrDataUrl = null; s.error = null;
        s.me = { id: sock.user?.id, name: sock.user?.name || sock.user?.verifiedName || '' };
        console.log(`WhatsApp ${id} connected`);
        if (s.justLinked) {
          // A phone was just linked: message that number so the owner/trainer sees sending works.
          s.justLinked = false;
          const self = `${s.me.id.split(':')[0].split('@')[0]}@s.whatsapp.net`;
          sock.sendMessage(self, { text: 'Trainer Pass is connected. QR codes for your members will be sent from this WhatsApp number.' })
            .catch(err => console.error(`WhatsApp ${id} confirmation failed`, err.message));
        }
      }
      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        s.sock = null;
        if (code === DisconnectReason.loggedOut) {
          await waAuth.clearPrefix(`${id}:`);
          Object.assign(s, { status: 'disconnected', me: null, qrDataUrl: null, wanted: false, error: 'WhatsApp was logged out from the phone. Connect again to keep sending.' });
        } else if (s.status === 'qr' && code === DisconnectReason.timedOut) {
          Object.assign(s, { status: 'disconnected', qrDataUrl: null, wanted: false, error: 'The code expired. Press Connect WhatsApp to get a new one.' });
        } else if (s.wanted) {
          s.status = s.me ? 'reconnecting' : 'connecting';
          // connectionReplaced: another copy of the app (e.g. during a Render deploy) took over. Wait for it to stop
          // instead of taking the connection straight back, which would make both copies fight.
          const wait = code === DisconnectReason.restartRequired ? 300 : code === DisconnectReason.connectionReplaced ? 20000 : 3000;
          setTimeout(() => start(id).catch(err => console.error(`WhatsApp ${id} restart failed`, err)), wait);
        } else {
          s.status = 'disconnected';
        }
      }
    });
  } catch (err) {
    s.sock = null; s.status = 'disconnected'; s.error = 'Could not reach WhatsApp. Try again in a minute.';
    console.error(`WhatsApp ${id} start failed`, err);
  } finally {
    s.starting = false;
  }
}

// On server start: reconnect every number that was linked before.
export async function resumeWhatsApp() {
  await waAuth.moveLegacyKeys(`${GYM}:`); // logins saved before per-trainer WhatsApp belong to the gym
  for (const id of await waAuth.sessionsWithCreds()) {
    const creds = decode((await waAuth.getMany([`${id}:creds`]))[`${id}:creds`]);
    if (!creds?.me) continue;
    const s = get(id);
    s.wanted = true; s.me = { id: creds.me.id, name: creds.me.name || '' };
    await start(id);
  }
}

export async function connectWhatsApp(id) {
  const s = get(id);
  s.wanted = true;
  if (!s.sock) await start(id);
}

export async function disconnectWhatsApp(id) {
  const s = get(id);
  s.wanted = false;
  try { await s.sock?.logout(); } catch { /* already closed */ }
  try { s.sock?.end(undefined); } catch { /* ignore */ }
  s.sock = null;
  await waAuth.clearPrefix(`${id}:`);
  Object.assign(s, { status: 'disconnected', me: null, qrDataUrl: null, error: null });
}

export function whatsappState(id) {
  const s = get(id);
  const number = s.me?.id ? s.me.id.split(':')[0].split('@')[0] : null;
  return { status: s.status, qr: s.status === 'qr' ? s.qrDataUrl : null, number, name: s.me?.name || '', error: s.error };
}

export const whatsappReady = id => { const s = sessions.get(id); return !!s && s.status === 'connected' && !!s.sock; };

// True when this number is linked but still reconnecting (e.g. the app just woke up on Render).
export const whatsappReconnecting = id => { const s = sessions.get(id); return !!s && s.wanted && !!s.me && ['connecting', 'reconnecting'].includes(s.status); };

// Waits up to `ms` for a linked number to finish reconnecting.
export async function whatsappWaitReady(id, ms = 20000) {
  const until = Date.now() + ms;
  while (!whatsappReady(id) && whatsappReconnecting(id) && Date.now() < until) await new Promise(r => setTimeout(r, 500));
  return whatsappReady(id);
}

async function jidFor(id, phoneDigits) {
  if (!whatsappReady(id)) throw new Error('WhatsApp is not connected.');
  const [found] = await get(id).sock.onWhatsApp(phoneDigits);
  if (!found?.exists) throw new Error(`+${phoneDigits} is not on WhatsApp. Check the number.`);
  return found.jid;
}

// Both throw an Error with a plain message the UI can show.
export async function sendImage(id, phoneDigits, png, caption) {
  const jid = await jidFor(id, phoneDigits);
  await get(id).sock.sendMessage(jid, { image: png, caption });
}
export async function sendText(id, phoneDigits, text) {
  const jid = await jidFor(id, phoneDigits);
  await get(id).sock.sendMessage(jid, { text });
}
