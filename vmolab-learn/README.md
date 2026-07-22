# vMoLab Learn

A mathematical oncology learning community platform for MOLAB Pakistan — member/admin login,
5-model tumor growth simulations, patient records, data/graph export, a community research board
with replies, admin roster import, moderation, member perks, and individual/broadcast email.

This is a real Node.js + Express app (not a static file), because live member-wide stats,
persistent community threads, and broadcast email all require a server and a database.

## What's inside

```
vmolab-app/
  server.js        — Express API + JSON-file data store + email
  public/index.html  — the entire front-end (landing page + member/admin app)
  public/logo.png    — MOLAB Pakistan logo
  package.json
  .env.example      — documents every environment variable
  data/            — where the JSON "database" file lives (db.json is created on first run)
```

## Deploying on Render

1. Push this folder to a GitHub (or GitLab) repository.
2. In Render, click **New +** → **Web Service** and connect that repository.
3. Settings:
   - **Environment**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: the free tier works to get started (see the persistence note below).
4. Under **Environment → Environment Variables**, add:
   - `ADMIN_EMAIL` = `molabpakistan@gmail.com`
   - `ADMIN_PASSWORD` = `@MolabPakistan26` (change this to something private once you've deployed)
   - `DATA_DIR` = `/data` (only if you've added a persistent disk — see below)
   - `EMAIL_HOST`, `EMAIL_PORT`, `EMAIL_USER`, `EMAIL_PASS`, `EMAIL_FROM` (optional, for real email — see below)
5. Click **Create Web Service**. Render will build and start the app, and give you a `https://...onrender.com` URL — that's the whole thing, live.

### Important: persistent storage

Render's web services normally use an **ephemeral filesystem** — anything written to disk
(including this app's `data/db.json` file) can be wiped whenever the service restarts or redeploys.
For a real membership platform you don't want to lose your roster, patients, or research board, so:

- In Render, add a **Persistent Disk** to the service (Render dashboard → your service → **Disks** → **Add Disk**), mount it at `/data`.
- Set the `DATA_DIR` environment variable to `/data`.
- Redeploy. From then on, all data written by the app lives on that disk and survives restarts/redeploys.

If you skip this step, the app will still run and work perfectly during a session — it just risks
resetting membership/patient/research data on the next deploy or restart. This is fine for testing,
but do add the disk before treating this as your production membership system.

### Enabling real email delivery

Without SMTP configured, admin messages and broadcast announcements still work — they appear
instantly as in-app notifications for members — but no email is actually sent (this is logged
to the Render service logs so it's easy to verify things are firing correctly).

To send real emails, set the `EMAIL_*` environment variables. The simplest path with an existing
Gmail account (e.g. molabpakistan@gmail.com):

1. Turn on 2-Step Verification on the Google account.
2. Create an **App Password** (Google Account → Security → App Passwords).
3. Set:
   - `EMAIL_HOST=smtp.gmail.com`
   - `EMAIL_PORT=587`
   - `EMAIL_USER=molabpakistan@gmail.com`
   - `EMAIL_PASS=<the 16-character app password>`
   - `EMAIL_FROM=molabpakistan@gmail.com`

Any standard SMTP provider (SendGrid, Mailgun, Zoho, your own mail server, etc.) works the same way —
just point `EMAIL_HOST`/`EMAIL_PORT`/`EMAIL_USER`/`EMAIL_PASS` at that provider's SMTP credentials.

## How members get access

Admins upload a spreadsheet (.xlsx/.xls/.csv) of membership responses under **Admin → Roster Upload**.
The app lets the admin map whichever columns contain the full name, Membership ID, and (optionally)
email/country — it doesn't require an exact template. Every name + Membership ID pair in that file
can then sign in immediately at the Member Portal.

## Security note

The admin password is checked server-side (not in the browser), which is a meaningful step up from
a pure static-file version — but this is still a lightweight, single-password admin login suited to
a small club/community tool. If MOLAB Pakistan's admin team grows, consider moving to per-admin
accounts with hashed passwords.

## Local testing

```
npm install
cp .env.example .env    # edit values as needed
npm start
```

Then open http://localhost:3000
