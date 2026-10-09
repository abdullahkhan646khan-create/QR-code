import pg from 'pg';
import { addDays, packageEnd, todayISO, newToken } from './util.js';
import { hashPassword } from './auth.js';

// Postgres when DATABASE_URL is set (Render). Otherwise an embedded Postgres (PGlite) saved in ./.data,
// so the app runs locally with no setup.
let impl;

export async function initDb() {
  if (process.env.DATABASE_URL) {
    const pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined,
      max: 5,
    });
    impl = { query: (text, params) => pool.query(text, params) };
    console.log('Database: Postgres');
  } else {
    const { PGlite } = await import('@electric-sql/pglite');
    const dir = process.env.PGLITE_DIR || './.data/db';
    const db = new PGlite(dir);
    await db.waitReady;
    impl = { query: (text, params) => db.query(text, params) };
    console.log(`Database: local (${dir})`);
  }
  await migrate();
  await seed();
}

export const q = async (text, params = []) => (await impl.query(text, params)).rows;
export const one = async (text, params = []) => (await q(text, params))[0] ?? null;

const SCHEMA = [
  `create table if not exists users (
     id serial primary key,
     role text not null check (role in ('owner', 'trainer')),
     name text not null,
     username text not null unique,
     password_hash text not null,
     phone text,
     active boolean not null default true,
     created_at timestamptz not null default now())`,
  `create table if not exists members (
     id serial primary key,
     trainer_id integer not null references users(id),
     name text not null,
     phone text not null,
     created_at timestamptz not null default now())`,
  `create table if not exists passes (
     id serial primary key,
     member_id integer not null references members(id) on delete cascade,
     token text not null unique,
     start_date text not null,
     end_date text not null,
     revoked boolean not null default false,
     sent_at timestamptz,
     created_at timestamptz not null default now())`,
  `create index if not exists passes_member_idx on passes(member_id)`,
  `create table if not exists scans (
     id serial primary key,
     pass_id integer references passes(id) on delete set null,
     member_id integer references members(id) on delete set null,
     trainer_id integer references users(id) on delete set null,
     scanned_by integer references users(id) on delete set null,
     result text not null,
     created_at timestamptz not null default now())`,
  `create table if not exists settings (key text primary key, value text not null)`,
  `create table if not exists wa_auth (key text primary key, value text not null)`,
];

async function migrate() {
  for (const stmt of SCHEMA) await q(stmt);
}

export async function getSetting(key, fallback = null) {
  return (await one('select value from settings where key = $1', [key]))?.value ?? fallback;
}
export async function setSetting(key, value) {
  await q('insert into settings (key, value) values ($1, $2) on conflict (key) do update set value = excluded.value', [key, String(value)]);
}

export async function createPass(memberId, startIso, endIso) {
  return one('insert into passes (member_id, token, start_date, end_date) values ($1, $2, $3, $4) returning *',
    [memberId, newToken(), startIso, endIso]);
}

// First start: the owner account from env, plus sample trainers and members unless SEED_DEMO=false.
async function seed() {
  if (!(await one(`select id from users where role = 'owner'`))) {
    const username = (process.env.ADMIN_USERNAME || 'owner').toLowerCase();
    const password = process.env.ADMIN_PASSWORD || 'owner123';
    await q(`insert into users (role, name, username, password_hash) values ('owner', $1, $2, $3)`,
      [process.env.ADMIN_NAME || 'Gym Owner', username, await hashPassword(password)]);
    console.log(`Owner account created: ${username}`);
  }
  if (await getSetting('gym_name') === null) await setSetting('gym_name', process.env.GYM_NAME || 'Demo Fitness Club');
  if (await getSetting('country_code') === null) await setSetting('country_code', process.env.DEFAULT_COUNTRY_CODE || '92');
  if (await getSetting('auto_send') === null) await setSetting('auto_send', 'true');

  if (process.env.SEED_DEMO === 'false' || await getSetting('demo_seeded') === 'true') return;
  await setSetting('demo_seeded', 'true');
  if (await one(`select id from users where role = 'trainer'`)) return;

  const today = todayISO();
  const trainers = [
    ['Usman Tariq', 'usman', '923000000201', [['Ali Raza', 6], ['Saad Qureshi', 20], ['Omar Farooq', 34]]],
    ['Sana Malik', 'sana', '923000000202', [['Ayesha Siddiqui', 12], ['Mehwish Ali', 27]]],
    ['Bilal Ahmed', 'bilal', '923000000203', [['Hassan Mirza', 3], ['Danish Iqbal', 40]]],
  ];
  let n = 101;
  for (const [name, username, phone, members] of trainers) {
    const t = await one(`insert into users (role, name, username, password_hash, phone) values ('trainer', $1, $2, $3, $4) returning id`,
      [name, username, await hashPassword(`${username}123`), phone]);
    for (const [memberName, daysAgo] of members) {
      const m = await one('insert into members (trainer_id, name, phone) values ($1, $2, $3) returning id', [t.id, memberName, `9230000000${n++}`]);
      const start = addDays(today, -daysAgo);
      await createPass(m.id, start, packageEnd(start));
    }
  }
  console.log('Sample trainers and members added (passwords: usman123, sana123, bilal123)');
}
