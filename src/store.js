import { createClient } from '@supabase/supabase-js';
import { addDays, packageEnd, todayISO, newToken } from './util.js';
import { hashPassword, verifyPassword } from './auth.js';

// All data lives in Supabase. The server uses the service role key, which is never sent to browsers.
let sb;

async function rows(query) {
  const { data, error } = await query;
  if (error) throw new Error(`Database error: ${error.message}`);
  return data;
}
async function num(query) {
  const { count, error } = await query;
  if (error) throw new Error(`Database error: ${error.message}`);
  return count ?? 0;
}
const chunks = (list, size) => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, i * size + size));

export async function initStore() {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
  sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  const { error } = await sb.from('users').select('id').limit(1);
  if (error) throw new Error(`Can't read the Supabase tables (${error.message}). Run supabase/schema.sql in the Supabase SQL Editor.`);
  console.log(`Database: Supabase (${new URL(url).hostname})`);
  await seed();
}

/* ---------- settings ---------- */
export async function getSetting(key, fallback = null) {
  const row = await rows(sb.from('settings').select('value').eq('key', key).maybeSingle());
  return row?.value ?? fallback;
}
export async function setSetting(key, value) {
  await rows(sb.from('settings').upsert({ key, value: String(value) }));
}

/* ---------- users (owner + trainers) ---------- */
export const users = {
  activeByUsername: u => rows(sb.from('users').select('*').eq('username', u).eq('active', true).maybeSingle()),
  usernameTaken: async u => !!(await rows(sb.from('users').select('id').eq('username', u).maybeSingle())),
  activeById: id => rows(sb.from('users').select('id, role, name, username, phone').eq('id', id).eq('active', true).maybeSingle()),
  byId: id => rows(sb.from('users').select('*').eq('id', id).maybeSingle()),
  trainer: id => rows(sb.from('users').select('*').eq('id', id).eq('role', 'trainer').maybeSingle()),
  activeTrainer: id => rows(sb.from('users').select('id').eq('id', id).eq('role', 'trainer').eq('active', true).maybeSingle()),
  insert: u => rows(sb.from('users').insert(u).select('id, name, username, phone').single()),
  update: (id, fields) => rows(sb.from('users').update(fields).eq('id', id)),
  removeTrainer: id => rows(sb.from('users').delete().eq('id', id).eq('role', 'trainer')),
  trainers: () => rows(sb.from('users').select('id, name, username, phone, active, created_at').eq('role', 'trainer').order('active', { ascending: false }).order('name')),
  countActiveTrainers: () => num(sb.from('users').select('id', { count: 'exact', head: true }).eq('role', 'trainer').eq('active', true)),
  owner: () => rows(sb.from('users').select('*').eq('role', 'owner').order('id').limit(1).maybeSingle()),
};

/* ---------- members, each with their latest QR code ---------- */
const MEMBER_SELECT = 'id, name, phone, trainer_id, created_at, trainer:users(name), passes(id, token, start_date, end_date, revoked, sent_at)';
const latestPassOnly = q => q.order('id', { referencedTable: 'passes', ascending: false }).limit(1, { referencedTable: 'passes' });
function flatMember(m) {
  const p = m.passes?.[0] ?? null;
  return {
    id: m.id, name: m.name, phone: m.phone, trainer_id: m.trainer_id, trainer_name: m.trainer?.name ?? '', created_at: m.created_at,
    pass_id: p?.id ?? null, token: p?.token ?? null, start_date: p?.start_date ?? null, end_date: p?.end_date ?? null,
    revoked: p?.revoked ?? false, sent_at: p?.sent_at ?? null,
  };
}
export const members = {
  list: async trainerId => {
    let q = latestPassOnly(sb.from('members').select(MEMBER_SELECT)).order('name');
    if (trainerId) q = q.eq('trainer_id', trainerId);
    return (await rows(q)).map(flatMember);
  },
  row: async id => {
    const m = await rows(latestPassOnly(sb.from('members').select(MEMBER_SELECT)).eq('id', id).maybeSingle());
    return m ? flatMember(m) : null;
  },
  insert: m => rows(sb.from('members').insert(m).select('id').single()),
  update: (id, fields) => rows(sb.from('members').update(fields).eq('id', id)),
  remove: id => rows(sb.from('members').delete().eq('id', id)),
  countForTrainer: id => num(sb.from('members').select('id', { count: 'exact', head: true }).eq('trainer_id', id)),
  moveAll: (fromTrainer, toTrainer) => rows(sb.from('members').update({ trainer_id: toTrainer }).eq('trainer_id', fromTrainer)),
  removeAllForTrainer: id => rows(sb.from('members').delete().eq('trainer_id', id)), // their QR codes go too (cascade)
};

/* ---------- QR codes ---------- */
export const passes = {
  create: (memberId, start, end) => rows(sb.from('passes').insert({ member_id: memberId, token: newToken(), start_date: start, end_date: end }).select().single()),
  revokeAll: memberId => rows(sb.from('passes').update({ revoked: true }).eq('member_id', memberId)),
  markSent: id => rows(sb.from('passes').update({ sent_at: new Date().toISOString() }).eq('id', id)),
  tokenExists: async token => !!(await rows(sb.from('passes').select('id').eq('token', token).maybeSingle())),
  byToken: async token => {
    const p = await rows(sb.from('passes').select('*, member:members(id, name, trainer:users(id, name))').eq('token', token).maybeSingle());
    if (!p) return null;
    return { ...p, member_id: p.member?.id, member_name: p.member?.name, trainer_id: p.member?.trainer?.id, trainer_name: p.member?.trainer?.name };
  },
};

/* ---------- scans ---------- */
export const scans = {
  add: s => rows(sb.from('scans').insert(s)),
  countSince: (iso, trainerId) => {
    let q = sb.from('scans').select('id', { count: 'exact', head: true }).gte('created_at', iso);
    if (trainerId) q = q.eq('trainer_id', trainerId);
    return num(q);
  },
  recent: async (trainerId, limit = 8) => {
    let q = sb.from('scans')
      .select('id, result, created_at, member:members(name), trainer:users!scans_trainer_id_fkey(name), scanner:users!scans_scanned_by_fkey(name)')
      .order('id', { ascending: false }).limit(limit);
    if (trainerId) q = q.eq('trainer_id', trainerId);
    return (await rows(q)).map(s => ({ id: s.id, result: s.result, created_at: s.created_at, member_name: s.member?.name ?? null, trainer_name: s.trainer?.name ?? null, scanned_by: s.scanner?.name ?? null }));
  },
};

/* ---------- WhatsApp login keys ---------- */
export const waAuth = {
  getMany: async keys => {
    const out = {};
    for (const part of chunks(keys, 100)) for (const r of await rows(sb.from('wa_auth').select('key, value').in('key', part))) out[r.key] = r.value;
    return out;
  },
  setMany: async entries => { for (const part of chunks(entries, 200)) await rows(sb.from('wa_auth').upsert(part)); },
  deleteMany: async keys => { for (const part of chunks(keys, 100)) await rows(sb.from('wa_auth').delete().in('key', part)); },
  clearPrefix: prefix => rows(sb.from('wa_auth').delete().like('key', `${prefix}%`)),
  // Connection ids ('gym', 't12', ...) that have a saved login.
  sessionsWithCreds: async () => (await rows(sb.from('wa_auth').select('key').like('key', '%:creds'))).map(r => r.key.slice(0, -':creds'.length)),
  // Keys saved before connections had a prefix get moved under `prefix` once.
  moveLegacyKeys: async prefix => {
    const legacy = await rows(sb.from('wa_auth').select('key, value').not('key', 'match', '^(gym|t[0-9]+):'));
    if (!legacy.length) return;
    for (const part of chunks(legacy, 200)) await rows(sb.from('wa_auth').upsert(part.map(r => ({ key: prefix + r.key, value: r.value }))));
    for (const part of chunks(legacy.map(r => r.key), 100)) await rows(sb.from('wa_auth').delete().in('key', part));
    console.log(`Moved ${legacy.length} saved WhatsApp keys to ${prefix}`);
  },
};

/* ---------- first start ---------- */
async function seed() {
  // Owner account. ADMIN_PASSWORD sets the owner's password; changing it on Render resets the password.
  const envPw = process.env.ADMIN_PASSWORD;
  const owner = await users.owner();
  if (!owner) {
    const username = (process.env.ADMIN_USERNAME || 'owner').toLowerCase();
    await users.insert({ role: 'owner', name: process.env.ADMIN_NAME || 'Gym Owner', username, password_hash: await hashPassword(envPw || 'owner123') });
    if (envPw) await setSetting('admin_password_env', await hashPassword(envPw));
    console.log(`Owner account created: ${username}`);
  } else if (envPw && !(await verifyPassword(envPw, await getSetting('admin_password_env', '')))) {
    await users.update(owner.id, { password_hash: await hashPassword(envPw) });
    await setSetting('admin_password_env', await hashPassword(envPw));
    console.log('Owner password set from ADMIN_PASSWORD');
  }
  if (await getSetting('gym_name') === null) await setSetting('gym_name', process.env.GYM_NAME || 'Demo Fitness Club');
  if (await getSetting('country_code') === null) await setSetting('country_code', process.env.DEFAULT_COUNTRY_CODE || '92');
  if (await getSetting('auto_send') === null) await setSetting('auto_send', 'true');

  if (process.env.SEED_DEMO === 'false' || await getSetting('demo_seeded') === 'true') return;
  await setSetting('demo_seeded', 'true');
  if ((await users.trainers()).length) return;

  const today = todayISO();
  const sample = [
    ['Usman Tariq', 'usman', '923000000201', [['Ali Raza', 6], ['Saad Qureshi', 20], ['Omar Farooq', 34]]],
    ['Sana Malik', 'sana', '923000000202', [['Ayesha Siddiqui', 12], ['Mehwish Ali', 27]]],
    ['Bilal Ahmed', 'bilal', '923000000203', [['Hassan Mirza', 3], ['Danish Iqbal', 40]]],
  ];
  let n = 101;
  for (const [name, username, phone, list] of sample) {
    const t = await users.insert({ role: 'trainer', name, username, password_hash: await hashPassword(`${username}123`), phone });
    for (const [memberName, daysAgo] of list) {
      const m = await members.insert({ trainer_id: t.id, name: memberName, phone: `9230000000${n++}` });
      const start = addDays(today, -daysAgo);
      await passes.create(m.id, start, packageEnd(start));
    }
  }
  console.log('Sample trainers and members added (passwords: usman123, sana123, bilal123)');
}
