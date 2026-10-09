-- Trainer Pass schema for Supabase. Paste into Supabase > SQL Editor > Run.
-- Optional: the app also creates these tables by itself the first time it starts.

-- Gym owner and trainers (each logs in with username + password)
create table if not exists users (
  id serial primary key,
  role text not null check (role in ('owner', 'trainer')),
  name text not null,
  username text not null unique,
  password_hash text not null,          -- scrypt hash, never the plain password
  phone text,                           -- digits with country code, e.g. 923001234567
  active boolean not null default true, -- false = trainer can't log in
  created_at timestamptz not null default now()
);

-- Members, each assigned to one trainer
create table if not exists members (
  id serial primary key,
  trainer_id integer not null references users(id),
  name text not null,
  phone text not null,                  -- WhatsApp number, digits with country code
  created_at timestamptz not null default now()
);

-- QR codes. A member gets a new one each month; the old one is marked revoked.
create table if not exists passes (
  id serial primary key,
  member_id integer not null references members(id) on delete cascade,
  token text not null unique,           -- random code inside the QR link /p/<token>
  start_date text not null,             -- YYYY-MM-DD
  end_date text not null,               -- YYYY-MM-DD, last valid day
  revoked boolean not null default false,
  sent_at timestamptz,                  -- last time it was sent on WhatsApp
  created_at timestamptz not null default now()
);
create index if not exists passes_member_idx on passes(member_id);

-- Every scan at the gym and its result
create table if not exists scans (
  id serial primary key,
  pass_id integer references passes(id) on delete set null,
  member_id integer references members(id) on delete set null,
  trainer_id integer references users(id) on delete set null,
  scanned_by integer references users(id) on delete set null,
  result text not null,                 -- valid | expired | replaced | upcoming | unknown
  created_at timestamptz not null default now()
);

-- Gym name, country code, auto-send, session secret
create table if not exists settings (key text primary key, value text not null);

-- WhatsApp linked-device login (keeps WhatsApp connected after restarts)
create table if not exists wa_auth (key text primary key, value text not null);

-- Lock every table from Supabase's public API (anon / service keys over REST).
-- The app connects as the database owner, which is not affected.
alter table users enable row level security;
alter table members enable row level security;
alter table passes enable row level security;
alter table scans enable row level security;
alter table settings enable row level security;
alter table wa_auth enable row level security;
