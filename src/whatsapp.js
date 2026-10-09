import makeWASocket, { Browsers, BufferJSON, DisconnectReason, fetchLatestBaileysVersion, initAuthCreds, proto } from 'baileys';
import pino from 'pino';
import QRCode from 'qrcode';
import { q, one } from './db.js';

// Links the gym's WhatsApp like WhatsApp Web (unofficial). The login is kept in the wa_auth table,
// so it survives restarts and Render's free-plan sleep.
const logger = pino({ level: process.env.WA_LOG_LEVEL || 'silent' });
const wa = { status: 'disconnected', qrDataUrl: null, me: null, sock: null, wanted: false, error: null, starting: false, qrCount: 0 };

async function readKey(key) {
  const row = await one('select value from wa_auth where key = $1', [key]);
  return row ? JSON.parse(row.value, BufferJSON.reviver) : null;
}
async function writeKey(key, value) {
  await q('insert into wa_auth (key, value) values ($1, $2) on conflict (key) do update set value = excluded.value',
    [key, JSON.stringify(value, BufferJSON.replacer)]);
}
const deleteKey = key => q('delete from wa_auth where key = $1', [key]);
const clearAuth = () => q('delete from wa_auth');

async function dbAuthState() {
  const creds = (await readKey('creds')) || initAuthCreds();
  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(ids.map(async id => {
            let value = await readKey(`${type}-${id}`);
            if (type === 'app-state-sync-key' && value) value = proto.Message.AppStateSyncKeyData.fromObject(value);
            data[id] = value;
          }));
          return data;
        },
        set: async data => {
          const tasks = [];
          for (const category of Object.keys(data)) {
            for (const id of Object.keys(data[category])) {
              const value = data[category][id];
              tasks.push(value ? writeKey(`${category}-${id}`, value) : deleteKey(`${category}-${id}`));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: () => writeKey('creds', creds),
  };
}

async function start() {
  if (wa.sock || wa.starting) return;
  wa.starting = true;
  wa.error = null;
  if (wa.status !== 'connected') wa.status = 'connecting';
  try {
    const { state, saveCreds } = await dbAuthState();
    let version;
    try { ({ version } = await fetchLatestBaileysVersion()); } catch { /* use the library default */ }
    const sock = makeWASocket({
      auth: state, logger, version, browser: Browsers.macOS('Chrome'),
      markOnlineOnConnect: false, syncFullHistory: false, generateHighQualityLinkPreview: false,
    });
    wa.sock = sock;
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', async update => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        wa.qrCount++;
        wa.status = 'qr';
        wa.qrDataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 360 });
      }
      if (connection === 'open') {
        wa.status = 'connected'; wa.qrDataUrl = null; wa.qrCount = 0; wa.error = null;
        wa.me = { id: sock.user?.id, name: sock.user?.name || sock.user?.verifiedName || '' };
        console.log('WhatsApp connected:', wa.me.id);
      }
      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        wa.sock = null;
        if (code === DisconnectReason.loggedOut) {
          await clearAuth();
          Object.assign(wa, { status: 'disconnected', me: null, qrDataUrl: null, wanted: false, error: 'WhatsApp was logged out from the phone. Connect again to keep sending.' });
        } else if (wa.status === 'qr' && code === DisconnectReason.timedOut) {
          // Nobody scanned the code in time: stop and let the owner press Connect again.
          Object.assign(wa, { status: 'disconnected', qrDataUrl: null, wanted: false, error: 'The QR code expired. Press Connect WhatsApp to get a new one.' });
        } else if (wa.wanted) {
          wa.status = wa.me ? 'reconnecting' : 'connecting';
          setTimeout(() => start().catch(err => console.error('WhatsApp restart failed', err)), code === DisconnectReason.restartRequired ? 300 : 3000);
        } else {
          wa.status = 'disconnected';
        }
      }
    });
  } catch (err) {
    wa.sock = null; wa.status = 'disconnected'; wa.error = 'Could not reach WhatsApp. Try again in a minute.';
    console.error('WhatsApp start failed', err);
  } finally {
    wa.starting = false;
  }
}

// On server start: reconnect automatically if a phone was linked before.
export async function resumeWhatsApp() {
  const creds = await readKey('creds');
  if (creds?.me) { wa.wanted = true; wa.me = { id: creds.me.id, name: creds.me.name || '' }; await start(); }
}

export async function connectWhatsApp() {
  wa.wanted = true; wa.qrCount = 0;
  if (!wa.sock) await start();
}

export async function disconnectWhatsApp() {
  wa.wanted = false;
  try { await wa.sock?.logout(); } catch { /* already closed */ }
  try { wa.sock?.end(undefined); } catch { /* ignore */ }
  wa.sock = null;
  await clearAuth();
  Object.assign(wa, { status: 'disconnected', me: null, qrDataUrl: null, error: null });
}

export function whatsappState() {
  const number = wa.me?.id ? wa.me.id.split(':')[0].split('@')[0] : null;
  return { status: wa.status, qr: wa.status === 'qr' ? wa.qrDataUrl : null, number, name: wa.me?.name || '', error: wa.error };
}

export const whatsappReady = () => wa.status === 'connected' && !!wa.sock;

// Sends an image with a caption. Throws an Error with a plain message the UI can show.
export async function sendImage(phoneDigits, png, caption) {
  if (!whatsappReady()) throw new Error('WhatsApp is not connected. The owner can connect it in WhatsApp settings.');
  const [found] = await wa.sock.onWhatsApp(phoneDigits);
  if (!found?.exists) throw new Error(`+${phoneDigits} is not on WhatsApp. Check the number.`);
  await wa.sock.sendMessage(found.jid, { image: png, caption });
}

export async function sendText(phoneDigits, text) {
  if (!whatsappReady()) throw new Error('WhatsApp is not connected.');
  const [found] = await wa.sock.onWhatsApp(phoneDigits);
  if (!found?.exists) throw new Error(`+${phoneDigits} is not on WhatsApp. Check the number.`);
  await wa.sock.sendMessage(found.jid, { text });
}
