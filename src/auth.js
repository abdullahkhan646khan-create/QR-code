import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { users, getSetting, setSetting } from './store.js';

const scrypt = promisify(crypto.scrypt);
const COOKIE = 'tp_session';
const SESSION_DAYS = 14;

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = await scrypt(String(password), salt, 32);
  return `${salt}:${hash.toString('hex')}`;
}

export async function verifyPassword(password, stored) {
  const [salt, hex] = String(stored).split(':');
  if (!salt || !hex) return false;
  const hash = await scrypt(String(password), salt, 32);
  const expected = Buffer.from(hex, 'hex');
  return expected.length === hash.length && crypto.timingSafeEqual(expected, hash);
}

// SESSION_SECRET from env, or one generated once and kept in the database.
let secret;
async function sessionSecret() {
  if (secret) return secret;
  secret = process.env.SESSION_SECRET || await getSetting('session_secret');
  if (!secret) { secret = crypto.randomBytes(32).toString('hex'); await setSetting('session_secret', secret); }
  return secret;
}

const sign = async payload => crypto.createHmac('sha256', await sessionSecret()).update(payload).digest('base64url');

export async function setSession(res, userId) {
  const exp = Date.now() + SESSION_DAYS * 86400e3;
  const payload = `${userId}.${exp}`;
  res.cookie(COOKIE, `${payload}.${await sign(payload)}`, {
    httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: SESSION_DAYS * 86400e3, path: '/',
  });
}

export function clearSession(res) {
  res.clearCookie(COOKIE, { path: '/' });
}

function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

// Attaches req.user when the session cookie is valid and the account is still active.
export async function loadUser(req, _res, next) {
  try {
    const raw = readCookie(req, COOKIE);
    if (raw) {
      const [uid, exp, sig] = raw.split('.');
      const expected = await sign(`${uid}.${exp}`);
      const good = sig && sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
      if (good && Number(exp) > Date.now()) {
        req.user = await users.activeById(Number(uid));
      }
    }
    next();
  } catch (err) { next(err); }
}

export function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Please log in again.' });
  next();
}

export function requireOwner(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Please log in again.' });
  if (req.user.role !== 'owner') return res.status(403).json({ error: 'Only the gym owner can do this.' });
  next();
}

// Slows down password guessing: 8 failed tries per 10 minutes per IP and username.
const attempts = new Map();
export function loginAllowed(key) {
  const a = attempts.get(key);
  return !a || a.until < Date.now() || a.count < 8;
}
export function loginFailed(key) {
  const a = attempts.get(key);
  if (!a || a.until < Date.now()) attempts.set(key, { count: 1, until: Date.now() + 10 * 60e3 });
  else a.count++;
}
export const loginSucceeded = key => attempts.delete(key);
