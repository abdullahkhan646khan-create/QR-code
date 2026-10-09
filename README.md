# Trainer Pass

QR codes for personal training at a gym.

- **Gym owner** logs in, adds trainers (each gets a username and password), sees every member, links the gym's WhatsApp, and scans QR codes.
- **Trainer** logs in, sees only their own members, adds a member (a QR code is made and sent to the member on WhatsApp), and scans QR codes.
- **Scanning** a member's QR code shows the member, their trainer, and the expiry date: Valid, Expired, or Old QR code.
- A member's QR code lasts the package length (1 month by default). **New month** makes a new code and the old one stops working; unused days carry over.

## Run on your computer

Needs Node.js 20 or newer.

```bash
npm install
npm start
```

Open http://localhost:3000. The first start creates a local database in `.data/` with sample data.

| Login | Username | Password |
|---|---|---|
| Gym owner | `owner` | `owner123` |
| Sample trainers | `usman`, `sana`, `bilal` | `usman123`, `sana123`, `bilal123` |

The camera scanner works on `localhost` and on the deployed https link. On a phone over plain http, use **Scan from a photo**.

## Database: Supabase

Data is stored in Supabase Postgres. The app needs only the database connection string (not the anon or service role key):

1. Supabase > your project > **Connect** > **Session pooler**. Copy the URI and put your database password in it:
   `postgresql://postgres.<project-ref>:<db-password>@aws-0-<region>.pooler.supabase.com:5432/postgres`
2. Tables are created automatically on first start. To create them yourself, run `supabase/schema.sql` in the SQL Editor.

Every table has Row Level Security on with no policies, so nothing is readable through Supabase's public REST API. Only the app's server reads the data.

## Deploy on Render

1. In Render: **New > Blueprint**, pick this GitHub repository. Render reads `render.yaml`.
2. When asked, paste the Supabase connection string as `DATABASE_URL` and choose an `ADMIN_PASSWORD`.
3. Open the Render link, log in as `owner` with that password.
4. Open **WhatsApp** in the app and scan the code with the gym's phone (WhatsApp > Linked devices > Link a device).

Free plan notes:
- The web service sleeps after 15 minutes without visits. The first visit after that takes about a minute. WhatsApp reconnects by itself when it wakes up. Open the app a minute before a demo.
- Set `SEED_DEMO` to `false` before using it for a real gym.

## WhatsApp

The app links to WhatsApp the same way WhatsApp Web does, using the open-source Baileys library. This is not an official WhatsApp API: use a number the gym owns, and avoid bulk messages to people who haven't saved the number, or WhatsApp may block it. The link is saved in the database, so it survives restarts.

When WhatsApp is not linked, every member card still has a **Send on WhatsApp** button that opens WhatsApp on the trainer's phone with the message and QR link ready.

## Settings (environment variables)

See `.env.example`. On Render they are set from `render.yaml`.
