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
  public/logo.png    — MOLAB Pakistan logo (also used as the browser tab favicon)
  public/assets/default-card-template.png — the real MOLAB membership card artwork, baked in as the default
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

### Alternative: Neon (Postgres) instead of MongoDB Atlas

Prefer Neon? The app supports it as a drop-in alternative — set a Neon connection string and it's
used instead of Mongo automatically (Mongo takes priority only if `MONGODB_URI` is also set, so just
use one or the other).

#### Step 1 — Create a free Neon project

1. Go to **[neon.tech](https://neon.tech)** and sign up (GitHub/Google sign-in works too).
2. Click **Create a project**. Pick any region close to you and a Postgres version (default is fine).
3. Name it anything (e.g. `vmolab`).

#### Step 2 — Get your connection string

1. On your new project's dashboard, find the **Connection String** panel.
2. Make sure **Pooled connection** is selected (recommended for serverless/Render deployments).
3. Copy the string — it looks like:
   `postgresql://neondb_owner:<password>@ep-xxxx-pooler.region.aws.neon.tech/neondb?sslmode=require`

#### Step 3 — Add it to Render

1. In Render, go to your service → **Environment**.
2. Add a variable: `DATABASE_URL` = the full connection string from Step 2 (or use `NEON_DATABASE_URL`
   if you'd rather keep the name Neon-specific — the app checks both).
3. Save — Render will redeploy automatically.
4. Check the **Logs** tab for `Connected to Neon/Postgres — data will persist permanently.` to confirm.

The app automatically creates the table it needs (`vmolab_app_data`) on first connection — nothing to
set up manually in Neon's SQL editor. Like Atlas, this needs no Render disk and no paid Render plan.

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
The app lets the admin map whichever columns the file actually has to Full Name, Membership ID,
Email, Membership Status, Country, and Institution — it doesn't require an exact template.

The downloadable template itself (**Admin → Roster Upload → Download Template**) is fully
admin-editable: use the **Manage Template Columns** box on that same tab to add or remove columns
(e.g. add "Phone Number", or drop "Country" if MOLAB doesn't track it) — whatever's in that list is
exactly what gets downloaded. It ships with six columns by default: Full Name, Molab Membership ID,
Email Address, Membership Status, Country, and Institution.

Every name + Membership ID pair in an imported file can then sign in immediately at the Member Portal.

## Member login security — 4-digit passcode

The first time someone logs in with a given name + Membership ID, they're immediately prompted to
set a 4-digit passcode (this can't be skipped). From then on, that passcode is required alongside
their name and Membership ID to sign in — so knowing someone's Membership ID alone isn't enough to
get into their account. Passcodes are stored as salted hashes (`scrypt`), never in plain text.

If a member forgets their passcode, there's no self-service reset (a 4-digit PIN has too small a
space for security questions to help) — an admin resets it for them from **Admin → Members → Reset
Passcode**, which clears their passcode and prompts them to set a new one on their next login.

## Member privacy — Membership IDs are admin-only

Membership IDs are never shown to other members anywhere in the app (community board posts, replies,
announcements, etc. only ever show a member's name). They remain visible only inside the Admin
console (Members table, Research Pitches moderation view, Contact Admin Inbox), where staff need them
to act on flags, locks, or renewals.

## Member profile, photo, and membership card/letter

Each member has a **My Profile** tab where they can:
- Upload a profile photo (auto-resized in the browser before upload).
- Set their **Institution** (university, hospital, employer) — editable by the member themselves, but
  pre-filled from the roster import if you supplied it there. Name, Membership ID, and Membership
  Status stay locked to whatever the roster says, since those come from MOLAB's official records.
- Download a personalized **Membership Card** and **Membership Letter** as PDFs.

The app ships with MOLAB's actual card design and welcome letter copy built in, calibrated to the
real artwork — nothing to set up before members can start downloading these. Both are fully editable
by admin at any time under **Admin → Card & Letter Templates**:

- **Card**: upload new background artwork whenever you want to change the design, and adjust the four
  text-position sliders (Name / Institution / Membership ID / Valid Till, as a % down the card) if
  your new artwork places them somewhere different from the current design.
- **Letter**: edit the heading, the full body text, and the signature name/title directly in a text
  box — no re-upload needed. Use `{{name}}`, `{{institution}}`, and `{{membershipId}}` anywhere in the
  body and they're swapped in automatically for each member. Separate paragraphs with a blank line.

## Announcements tab

Every member's dashboard has a 4th tab, **Announcements**, showing the full history of broadcast
messages sent from **Admin → Overview → Broadcast Announcement** — in addition to the instant in-app
notification (bell icon) and email each broadcast already triggers.

## Contact Admin — message history and responses

Anyone can reach MOLAB admin via the **Contact Admin** button (on the Member Login screen and inside
the dashboard). Logged-in members see their own past messages and any admin response right inside
that same dialog the next time they open it. On the admin side, **Admin → Contact Admin Inbox** lets
staff write a response (which notifies the member in-app and by email if they left one) or just mark
a query resolved (which also notifies the member) — so the member always knows what they sent and
what came back.

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

## Admin access is hidden from the public site

The public landing page no longer shows an "Admin" button anywhere — the only way to reach the admin
login is by going directly to `https://yoursite.onrender.com/admin`. This keeps casual visitors from
ever seeing that an admin console exists.

**Important:** this is obscurity, not real access control — anyone who knows or guesses the `/admin`
URL still hits the same password-protected login you already have. It reduces the chance of a random
visitor stumbling onto the admin login and doesn't replace the password; don't treat the URL itself as
a secret credential. If you want stronger protection later (e.g. IP allowlisting, per-admin accounts),
that's a separate step beyond what's built here.

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
