# Trainer Pass

QR codes for personal training at a gym.

- **Gym owner** logs in, adds trainers (each gets a username and password), sees every member, links the gym's WhatsApp, and scans QR codes.
- **Trainer** logs in, sees only their own members, adds a member (a QR code is made and sent to the member on WhatsApp), and scans QR codes.
- **Scanning** a member's QR code shows the member, their trainer, and the expiry date: Valid, Expired, or Old QR code.
- A member's QR code lasts the package length (1 month by default). **New month** makes a new code and the old one stops working; unused days carry over.

## Database: Supabase

All data is stored in Supabase. Run `supabase/schema.sql` once in Supabase > SQL Editor to create the tables. Every table has Row Level Security on with no policies, so the public anon key can't read anything; only the server, using the service role key, can.

The server needs two values from Supabase > Settings > API:

- `SUPABASE_URL`, like `https://<project-ref>.supabase.co`
- `SUPABASE_SERVICE_ROLE_KEY`, a secret. Put it only in Render's environment variables or your local `.env`, never in git.

## Run on your computer

Needs Node.js 22 or newer. Copy `.env.example` to `.env` and fill in the Supabase values, then:

```bash
npm install
npm run dev
```

Open http://localhost:3000. The first start adds sample trainers and members (turn off with `SEED_DEMO=false`).

| Login | Username | Password |
|---|---|---|
| Gym owner | `owner` | the `ADMIN_PASSWORD` you set (`owner123` if not set) |
| Sample trainers | `usman`, `sana`, `bilal` | `usman123`, `sana123`, `bilal123` |

Changing `ADMIN_PASSWORD` and restarting resets the owner's password to it.

## Deploy on Render

**New > Web Service**, pick this repository, then:

| Field | Value |
|---|---|
| Branch | `main` |
| Region | Singapore |
| Build command | `npm ci` |
| Start command | `npm start` |
| Instance | Free |
| Health check path (Advanced) | `/healthz` |

Environment variables: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ADMIN_PASSWORD`, `SESSION_SECRET` (press Generate), `NODE_VERSION` = `22`, `NODE_ENV` = `production`, `APP_TIMEZONE` = `Asia/Karachi`. Or use **New > Blueprint**, which reads `render.yaml`.

Then open the Render link, log in as `owner`, go to **WhatsApp** and scan the code with the gym's phone (WhatsApp > Linked devices > Link a device).

Free plan: the service sleeps after 15 minutes without visits; the first visit then takes about a minute, and WhatsApp reconnects by itself. Open the app a minute before a demo.

## WhatsApp

The app links to WhatsApp the same way WhatsApp Web does, using the open-source Baileys library. This is not an official WhatsApp API: use a number the gym owns, and avoid bulk messages to people who haven't saved the number, or WhatsApp may block it. The link is saved in Supabase, so it survives restarts.

Each trainer can link their own WhatsApp from **WhatsApp** in their login; their members' QR codes are then sent from the trainer's number. A trainer who hasn't linked one sends through the gym's WhatsApp (linked by the owner). Right after linking, the app sends a "connected" message to that number. After Render wakes the app up, sending waits a few seconds for WhatsApp to reconnect instead of failing.

When no WhatsApp is linked, every member card still has a **Send on WhatsApp** button that opens WhatsApp on the phone with the message and QR link ready.

## Settings (environment variables)

See `.env.example`. On Render they are set from `render.yaml`.
