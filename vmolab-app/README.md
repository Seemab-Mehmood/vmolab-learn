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

### Permanent storage — MongoDB Atlas (recommended, free)

Render's web services normally use an **ephemeral filesystem** — anything written to disk
(including a local `data/db.json` file) can be wiped whenever the service restarts or redeploys.
Render's own Persistent Disks fix this, but only on a paid instance. This app instead ships with
built-in support for **MongoDB Atlas**, which has a free tier (M0, 512 MB) that doesn't expire and
doesn't require a paid Render plan. All of your roster, patient, research, flag, perk, and activity
data is stored there instead of on disk.

#### Step 1 — Create a free Atlas account and cluster

1. Go to **[mongodb.com/cloud/atlas/register](https://www.mongodb.com/cloud/atlas/register)** and sign up (Google sign-in works too).
2. When asked to deploy a database, choose **M0 Free**.
3. Pick any cloud provider/region close to you (this doesn't need to match Render's region for an app this size) and click **Create**.
4. Name the cluster anything you like (e.g. `vmolab-cluster`) — the default name is fine too.

#### Step 2 — Create a database user

1. You'll be prompted to create a database user as part of setup (or go to **Database Access** in the left sidebar → **Add New Database User**).
2. Choose **Password** authentication. Set a username (e.g. `vmolab-admin`) and click **Autogenerate Secure Password** (copy it somewhere safe) or set your own.
3. Under database user privileges, leave it as **Read and write to any database**.
4. Click **Add User**.

#### Step 3 — Allow network access

1. Go to **Network Access** in the left sidebar → **Add IP Address**.
2. Click **Allow Access from Anywhere** (`0.0.0.0/0`). This is fine here since the connection itself is still authenticated with your username/password — it just means Render's servers (whose IPs change) can always reach it.
3. Click **Confirm**.

#### Step 4 — Get your connection string

1. Go to the **Database** section → click **Connect** on your cluster.
2. Choose **Drivers** (or "Connect your application").
3. Copy the connection string — it looks like:
   `mongodb+srv://vmolab-admin:<password>@vmolab-cluster.xxxxx.mongodb.net/?retryWrites=true&w=majority`
4. Replace `<password>` with the database user's actual password from Step 2.

#### Step 5 — Add it to Render

1. In Render, go to your service → **Environment**.
2. Add a variable:
   - `MONGODB_URI` = the full connection string from Step 4
   - (optional) `MONGODB_DB_NAME` = `vmolab` (this is the default if you skip it)
3. Save — Render will redeploy automatically.
4. Check the **Logs** tab for `Connected to MongoDB Atlas — data will persist permanently.` to confirm it worked.

That's it — no Render disk, no upgrade to a paid instance required. Your data now survives restarts,
redeploys, and Render's free-tier spin-downs indefinitely.

If `MONGODB_URI` is ever unset or unreachable, the app automatically falls back to the local
`data/db.json` file so it keeps working — just without permanent storage on Render's free tier.

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

## Membership lifecycle (12-month tiers)

Every membership runs for 12 months starting from the member's **first login** (that's when their
account activates). Once that year is up:

- The member can still **log in**, but can't register new patients, add new measurement values,
  run/view simulations, export data, submit new community posts, or reply to existing ones.
- They see: *"Your access to vMoLab Learn has expired. Please check your membership status with
  MOLAB admin."* — with a one-tap **Contact Admin** button.

Admins can also **lock** a membership at any time (e.g. for a community guidelines complaint) under
**Admin → Members**, which has the exact same restrictive effect as a natural expiry — the member
can still log in and see this same message. **Unlock** removes that restriction; it does not touch
the 12-month timer.

To renew someone for another year (e.g. once they've paid their next membership fee), use the
**Renew** button next to their name in the Members table — this resets their 12-month timer to
start from today. Renewing does *not* automatically lift a conduct-related lock; those need a
separate **Unlock**.

Members (and non-members) can always reach the admin team directly via the **Contact Admin** button
on the login screen or dashboard — messages go to the **Contact Admin Inbox** tab in the Admin
console and, if SMTP is configured, are also emailed straight to `molabpakistan@gmail.com`.

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
