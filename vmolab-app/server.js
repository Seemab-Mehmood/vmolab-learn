/**
 * vMoLab Learn — Server
 * Express backend + persistence (MongoDB Atlas, or Neon/Postgres, or a local JSON-file
 * fallback for offline development) + nodemailer email.
 *
 * ENVIRONMENT VARIABLES (set these in Render's dashboard):
 *   PORT              — provided automatically by Render
 *   MONGODB_URI         — a MongoDB Atlas connection string. Takes priority if set.
 *   MONGODB_DB_NAME       — database name to use inside your Atlas cluster (default: vmolab)
 *   DATABASE_URL / NEON_DATABASE_URL — a Neon (or any Postgres) connection string. Used if
 *                        MONGODB_URI is not set. See README.md for step-by-step Neon setup.
 *   DATA_DIR           — (fallback only) path to store data/db.json if neither of the above is set.
 *                        This will NOT persist reliably on Render without a paid disk — use
 *                        MongoDB Atlas or Neon instead for permanent free storage.
 *   ADMIN_EMAIL         — admin login email   (default: molabpakistan@gmail.com)
 *   ADMIN_PASSWORD      — admin login password (default: @MolabPakistan26)
 *   EMAIL_HOST, EMAIL_PORT, EMAIL_USER, EMAIL_PASS, EMAIL_FROM — SMTP settings for real email delivery.
 *     If these are not set, the app still works — messages are logged and delivered as in-app
 *     notifications, but no real email is sent. See README.md.
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { MongoClient } = require('mongodb');
const { Pool } = require('pg');

const app = express();
app.use(express.json({ limit: '12mb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* ============================================================
   PERSISTENCE — MongoDB Atlas, or Neon/Postgres, or a local
   JSON-file fallback, behind a write mutex.
   ============================================================ */
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

// Ships with the real MOLAB membership card artwork baked in as the default, so card downloads
// work immediately without the admin needing to upload anything on day one.
let DEFAULT_CARD_IMAGE = null;
try {
  DEFAULT_CARD_IMAGE = 'data:image/png;base64,' + fs.readFileSync(path.join(__dirname, 'public', 'assets', 'default-card-template.png')).toString('base64');
} catch (e) {
  console.warn('[vMoLab] Default card template image not found — card downloads will need admin-uploaded artwork.');
}

const DEFAULT_LETTER_BODY = [
  "Welcome to Mathematical Oncology Lab Pakistan! We are excited to have you on board from {{institution}} and look forward to the contributions you will make.",
  "Your Molab Membership ID is {{membershipId}}.",
  "As a new member of the Molab Pakistan, you will be joining a group of talented and dedicated individuals who are committed to bring clinical excellence at the intersection of mathematics and computational logics. We believe in fostering a positive and collaborative work environment where everyone can grow and succeed together.",
  "MoLab Pakistan is more than a research laboratory—it is an interdisciplinary organization established to advance Mathematical Oncology through research, education, software innovation, computational modeling, and international collaboration. Founded on 19 February 2026, MoLab Pakistan brings together clinicians, mathematicians, computer scientists, engineers, researchers, educators, and innovators to solve complex cancer challenges using quantitative approaches.",
  "As an Official Member, you shall have full access to vMoLab Learn and vMoLab Simulations that are available for your learnings throughout the mathematical oncology learning.",
  "For any questions/suggestions/comments, feel free to reach out to our team at molabpakistan@gmail.com.",
  "Once again, welcome to the new era of medicine! We are thrilled to have you with us and can't wait to see what we will achieve together."
].join('\n\n');

const DEFAULT_DB = {
  roster: [],        // [{name, membershipId, email, country, institution, membershipStatus, status, locked, lockReason, lockedAt, addedAt}]
  members: {},        // { [membershipId]: {name, membershipId, email, country, membershipStatus, institution, photoUrl, passcodeHash, loginCount, firstLogin, lastLogin, notifications:[]} }
  patients: {},        // { [membershipId]: [ {id, patientName, model, params, dataset, holdout, createdAt, updatedAt} ] }
  research: [],        // [ {id, name, membershipId, title, body, date, status, replies:[]} ]
  flags: [],          // [ {id, targetType, targetId, targetLabel, reason, by, date, resolved} ]
  perks: [],          // [ {id, membershipId, memberName, perkType, note, assignedAt} ]
  activityLog: [],       // [ {ts, type, name, membershipId, detail} ]
  supportMessages: [],    // [ {id, name, email, membershipId, message, date, resolved, response, responseDate} ]
  broadcasts: [],       // [ {id, subject, body, tag, date} ]
  broadcastTags: ['Opportunities', 'Capacity Building Sessions', 'Workshops', 'Courses'], // admin-editable
  rosterTemplateColumns: ['Full Name', 'Molab Membership ID', 'Email Address', 'Membership Status', 'Country', 'Institution'], // admin-editable
  templates: {
    cardImage: DEFAULT_CARD_IMAGE,
    cardPositions: { nameY: 0.427, institutionY: 0.499, idY: 0.571, validY: 0.641 }, // admin-editable, fraction of image height
    letterHeading: 'Welcome To The MOLAB Pakistan',
    letterBody: DEFAULT_LETTER_BODY, // admin-editable; paragraphs separated by blank lines, supports {{name}} {{institution}} {{membershipId}}
    letterSignatureName: 'Seemab Mehmood',
    letterSignatureTitle: 'Founder & CEO'
  }
};

let useMongo = false;
let mongoCollection = null;
let usePg = false;
let pgPool = null;
const DOC_ID = 'main';
const PG_TABLE = 'vmolab_app_data';

async function initStorage(){
  if (process.env.MONGODB_URI) {
    try {
      const client = new MongoClient(process.env.MONGODB_URI);
      await client.connect();
      const dbName = process.env.MONGODB_DB_NAME || 'vmolab';
      mongoCollection = client.db(dbName).collection('appdata');
      const existing = await mongoCollection.findOne({ _id: DOC_ID });
      if (!existing) await mongoCollection.insertOne(Object.assign({ _id: DOC_ID }, DEFAULT_DB));
      useMongo = true;
      console.log('[vMoLab] Connected to MongoDB Atlas — data will persist permanently.');
      return;
    } catch (e) {
      console.error('[vMoLab] Could not connect to MongoDB Atlas, falling back:', e.message);
      useMongo = false;
    }
  }
  const pgConnStr = process.env.DATABASE_URL || process.env.NEON_DATABASE_URL;
  if (pgConnStr) {
    try {
      pgPool = new Pool({ connectionString: pgConnStr, ssl: { rejectUnauthorized: false } });
      await pgPool.query(`CREATE TABLE IF NOT EXISTS ${PG_TABLE} (id TEXT PRIMARY KEY, data JSONB NOT NULL)`);
      const { rows } = await pgPool.query(`SELECT data FROM ${PG_TABLE} WHERE id = $1`, [DOC_ID]);
      if (!rows.length) await pgPool.query(`INSERT INTO ${PG_TABLE} (id, data) VALUES ($1, $2)`, [DOC_ID, DEFAULT_DB]);
      usePg = true;
      console.log('[vMoLab] Connected to Neon/Postgres — data will persist permanently.');
      return;
    } catch (e) {
      console.error('[vMoLab] Could not connect to Neon/Postgres, falling back to local JSON file:', e.message);
      usePg = false;
    }
  }
  console.warn('[vMoLab] No MONGODB_URI or DATABASE_URL set — using local JSON file storage (data/db.json). See README.md to switch to MongoDB Atlas or Neon for permanent free storage.');
}

function ensureLocalFile(){
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify(DEFAULT_DB, null, 2));
}

async function readDbRaw(){
  if (useMongo) {
    const doc = await mongoCollection.findOne({ _id: DOC_ID });
    return doc ? Object.assign({}, DEFAULT_DB, doc) : JSON.parse(JSON.stringify(DEFAULT_DB));
  }
  if (usePg) {
    const { rows } = await pgPool.query(`SELECT data FROM ${PG_TABLE} WHERE id = $1`, [DOC_ID]);
    return rows.length ? Object.assign({}, DEFAULT_DB, rows[0].data) : JSON.parse(JSON.stringify(DEFAULT_DB));
  }
  ensureLocalFile();
  try { return Object.assign({}, DEFAULT_DB, JSON.parse(fs.readFileSync(DB_FILE, 'utf8'))); }
  catch(e){ return JSON.parse(JSON.stringify(DEFAULT_DB)); }
}

async function writeDbRaw(db){
  if (useMongo) {
    await mongoCollection.replaceOne({ _id: DOC_ID }, Object.assign({}, db, { _id: DOC_ID }), { upsert: true });
    return;
  }
  if (usePg) {
    await pgPool.query(
      `INSERT INTO ${PG_TABLE} (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data = $2`,
      [DOC_ID, db]
    );
    return;
  }
  ensureLocalFile();
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

// Serialize all read-modify-write operations so concurrent requests never corrupt the data.
class Mutex {
  constructor(){ this._chain = Promise.resolve(); }
  run(fn){
    const result = this._chain.then(() => fn());
    this._chain = result.then(() => {}, () => {});
    return result;
  }
}
const dbMutex = new Mutex();
function withDb(mutatorFn){
  return dbMutex.run(async () => {
    const db = await readDbRaw();
    const result = await mutatorFn(db);
    await writeDbRaw(db);
    return result;
  });
}

function normId(s){ return (s || '').toString().trim().toUpperCase(); }
function normName(s){ return (s || '').toString().trim().replace(/\s+/g, ' ').toLowerCase(); }
function genId(prefix){ return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

/* ============================================================
   PASSCODE HASHING (4-digit member login PIN)
   ============================================================ */
function hashPasscode(passcode){
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(passcode, salt, 32).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPasscode(passcode, stored){
  if (!stored || typeof stored !== 'string' || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  try {
    const candidate = crypto.scryptSync(passcode, salt, 32);
    const expected = Buffer.from(hash, 'hex');
    return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
  } catch (e) { return false; }
}

function logActivity(db, type, name, membershipId, detail){
  db.activityLog.unshift({ ts: Date.now(), type, name: name || 'Admin', membershipId: membershipId || '-', detail });
  db.activityLog = db.activityLog.slice(0, 400);
}

/* ============================================================
   MEMBERSHIP DURATION — every membership tier runs 12 months
   from the member's first login (account activation). Admins can
   also "lock" a membership at any time (e.g. for a community
   guidelines concern) — a lock has the exact same restrictive
   effect as a natural 12-month expiry.
   ============================================================ */
function addOneYear(ts){
  const d = new Date(ts);
  d.setFullYear(d.getFullYear() + 1);
  return d.getTime();
}

// Returns the current access status for a member: whether their activities are
// restricted (expired membership year OR an admin lock), and why.
function getMembershipStatus(db, membershipId){
  const entry = db.roster.find(r => normId(r.membershipId) === normId(membershipId));
  const profile = db.members[membershipId];
  if (!entry) return { restricted: true, reason: 'not_found', expiresAt: null, locked: false, lockReason: '' };
  const locked = !!entry.locked;
  const expiresAt = profile && profile.firstLogin ? addOneYear(profile.firstLogin) : null;
  const expired = !!(expiresAt && Date.now() > expiresAt);
  const restricted = locked || expired;
  let reason = null;
  if (locked) reason = 'locked';
  else if (expired) reason = 'expired';
  return { restricted, reason, expiresAt, locked, lockReason: entry.lockReason || '' };
}

/* ============================================================
   EMAIL
   ============================================================ */
let transporter = null;
if (process.env.EMAIL_HOST && process.env.EMAIL_USER && process.env.EMAIL_PASS){
  transporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST,
    port: parseInt(process.env.EMAIL_PORT || '587', 10),
    secure: parseInt(process.env.EMAIL_PORT || '587', 10) === 465,
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
  });
} else {
  console.warn('[vMoLab] EMAIL_HOST/EMAIL_USER/EMAIL_PASS not set — emails will be logged only, not delivered. See README.md.');
}

async function sendEmail({ to, bcc, subject, text }){
  if (!transporter) {
    console.log('[vMoLab email — NOT SENT, no SMTP configured]', { to, bcc, subject });
    return { sent: false, reason: 'SMTP not configured' };
  }
  try {
    await transporter.sendMail({
      from: process.env.EMAIL_FROM || process.env.EMAIL_USER,
      to: to || undefined,
      bcc: bcc || undefined,
      subject,
      text
    });
    return { sent: true };
  } catch (e) {
    console.error('[vMoLab email error]', e.message);
    return { sent: false, reason: e.message };
  }
}

/* ============================================================
   ADMIN AUTH
   ============================================================ */
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'molabpakistan@gmail.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '@MolabPakistan26';
const adminTokens = new Map(); // token -> expiry ms

function issueAdminToken(){
  const token = crypto.randomBytes(24).toString('hex');
  adminTokens.set(token, Date.now() + 12 * 3600 * 1000);
  return token;
}
function isAdminTokenValid(req){
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  const expiry = token && adminTokens.get(token);
  return !!(expiry && expiry >= Date.now());
}
function requireAdmin(req, res, next){
  if (!isAdminTokenValid(req)) return res.status(401).json({ ok: false, error: 'Admin session expired. Please sign in again.' });
  next();
}

app.post('/api/auth/admin-login', (req, res) => {
  const { email, password } = req.body || {};
  if ((email || '').toLowerCase() !== ADMIN_EMAIL.toLowerCase() || password !== ADMIN_PASSWORD){
    return res.status(401).json({ ok: false, error: 'Incorrect email or password.' });
  }
  res.json({ ok: true, token: issueAdminToken() });
});

/* ============================================================
   MEMBER AUTH
   ============================================================ */
app.post('/api/auth/member-login', async (req, res) => {
  const { name, membershipId, country, passcode } = req.body || {};
  if (!name || !membershipId) return res.status(400).json({ ok: false, error: 'Full name and Membership ID are required.' });

  const result = await withDb(async (db) => {
    const entry = db.roster.find(r => normId(r.membershipId) === normId(membershipId));
    if (!entry) return { ok: false, error: 'Membership ID not found. Please contact your MOLAB admin.' };
    if (entry.status === 'removed') return { ok: false, error: 'This membership has been deactivated. Contact your MOLAB admin.' };
    if (normName(entry.name) !== normName(name)) return { ok: false, error: 'Name does not match our records for this Membership ID.' };

    if (!db.members[entry.membershipId]) {
      db.members[entry.membershipId] = { name: entry.name, membershipId: entry.membershipId, email: entry.email || '', country: entry.country || '', membershipStatus: entry.membershipStatus || '', institution: entry.institution || '', photoUrl: '', passcodeHash: null, loginCount: 0, firstLogin: Date.now(), lastLogin: null, notifications: [] };
    }
    const profile = db.members[entry.membershipId];

    // Returning member who already has a passcode set: it's required and must match.
    if (profile.passcodeHash) {
      if (!passcode) return { ok: false, error: 'Enter your 4-digit passcode.', passcodeRequired: true };
      if (!verifyPasscode(passcode, profile.passcodeHash)) return { ok: false, error: 'Incorrect passcode.', passcodeRequired: true };
    }

    profile.loginCount += 1;
    profile.lastLogin = Date.now();
    profile.name = entry.name;
    profile.membershipStatus = entry.membershipStatus || profile.membershipStatus || '';
    if (entry.institution && !profile.institution) profile.institution = entry.institution;
    if (country && !profile.country) profile.country = country;
    logActivity(db, 'login', entry.name, entry.membershipId, 'Member signed in');
    const membership = getMembershipStatus(db, entry.membershipId);
    return { ok: true, member: profile, membership, passcodeSetupRequired: !profile.passcodeHash };
  });

  res.status(result.ok ? 200 : 401).json(result);
});

app.put('/api/members/:id/passcode', async (req, res) => {
  const { passcode } = req.body || {};
  if (!passcode || !/^\d{4}$/.test(passcode)) return res.status(400).json({ ok: false, error: 'Passcode must be exactly 4 digits.' });
  const result = await withDb(async (db) => {
    const profile = db.members[req.params.id];
    if (!profile) return { ok: false, error: 'Member not found.' };
    profile.passcodeHash = hashPasscode(passcode);
    return { ok: true };
  });
  res.json(result);
});

app.post('/api/admin/members/:id/reset-passcode', requireAdmin, async (req, res) => {
  await withDb(async (db) => {
    const entry = db.roster.find(r => normId(r.membershipId) === normId(req.params.id));
    if (db.members[req.params.id]) {
      const profile = db.members[req.params.id];
      profile.passcodeHash = null;
      profile.notifications = profile.notifications || [];
      profile.notifications.push({ msg: 'MOLAB admin reset your passcode. You\'ll be asked to set a new one next time you log in.', date: Date.now(), read: false });
    }
    logActivity(db, 'moderation', 'Admin', null, `Reset passcode for ${entry ? entry.name : req.params.id}`);
  });
  res.json({ ok: true });
});

app.post('/api/members/:id/set-country', async (req, res) => {
  const { country } = req.body || {};
  const result = await withDb(async (db) => {
    const profile = db.members[req.params.id];
    if (!profile) return { ok: false, error: 'Member not found.' };
    profile.country = country;
    return { ok: true };
  });
  res.json(result);
});

app.put('/api/members/:id/profile', async (req, res) => {
  const { institution } = req.body || {};
  const result = await withDb(async (db) => {
    const profile = db.members[req.params.id];
    if (!profile) return { ok: false, error: 'Member not found.' };
    if (typeof institution === 'string') profile.institution = institution;
    return { ok: true, member: profile };
  });
  res.json(result);
});

app.put('/api/members/:id/photo', async (req, res) => {
  const { photoDataUrl } = req.body || {};
  if (!photoDataUrl || !photoDataUrl.startsWith('data:image/')) return res.status(400).json({ ok: false, error: 'A valid image is required.' });
  const result = await withDb(async (db) => {
    const profile = db.members[req.params.id];
    if (!profile) return { ok: false, error: 'Member not found.' };
    profile.photoUrl = photoDataUrl;
    return { ok: true };
  });
  res.json(result);
});

app.get('/api/members/:id', async (req, res) => {
  const db = await readDbRaw();
  const profile = db.members[req.params.id];
  const rosterEntry = db.roster.find(r => normId(r.membershipId) === normId(req.params.id));
  if (!profile || !rosterEntry) return res.status(404).json({ ok: false, error: 'Member not found.' });
  const membership = getMembershipStatus(db, req.params.id);
  res.json({
    ok: true,
    member: {
      name: rosterEntry.name, membershipId: rosterEntry.membershipId,
      membershipStatus: rosterEntry.membershipStatus || profile.membershipStatus || '',
      institution: profile.institution || '', photoUrl: profile.photoUrl || '',
      firstLogin: profile.firstLogin || null
    },
    membership
  });
});

/* ============================================================
   PUBLIC STATS
   ============================================================ */
app.get('/api/stats', async (req, res) => {
  const db = await readDbRaw();
  const activeRoster = db.roster.filter(r => r.status !== 'removed');
  const totalMembers = db.roster.length;
  const activeMembers = activeRoster.filter(r => {
    const p = db.members[r.membershipId];
    return p && p.loginCount > 0;
  }).length;
  const countries = new Set(
    Object.values(db.members).map(m => (m.country || '').trim()).filter(Boolean)
  ).size;
  const simulations = Object.values(db.patients).reduce((sum, arr) => sum + (arr ? arr.length : 0), 0);

  // Spotlight: most recent perk assigned per perk type
  const spotlightMap = {};
  db.perks.forEach(p => {
    if (!spotlightMap[p.perkType] || spotlightMap[p.perkType].assignedAt < p.assignedAt) spotlightMap[p.perkType] = p;
  });
  const spotlight = Object.values(spotlightMap).sort((a, b) => b.assignedAt - a.assignedAt);

  res.json({ ok: true, totalMembers, activeMembers, countries, simulations, spotlight });
});

/* ============================================================
   RESEARCH / COMMUNITY BOARD (with replies)
   ============================================================ */
app.get('/api/research', async (req, res) => {
  const db = await readDbRaw();
  res.json({ ok: true, research: db.research });
});

app.post('/api/research', async (req, res) => {
  const { name, membershipId, title, body } = req.body || {};
  if (!name || !membershipId || !title || !body) return res.status(400).json({ ok: false, error: 'Missing fields.' });
  const result = await withDb(async (db) => {
    const membership = getMembershipStatus(db, membershipId);
    if (membership.restricted) return { ok: false, error: 'Your membership access is currently restricted. Contact MOLAB admin to post.', restricted: true, membership };
    const entry = { id: genId('r'), name, membershipId, title, body, date: Date.now(), status: 'open', replies: [] };
    db.research.unshift(entry);
    logActivity(db, 'research', name, membershipId, `Submitted pitch "${title}"`);
    return { ok: true, entry };
  });
  res.status(result.ok ? 200 : 403).json(result);
});

app.post('/api/research/:id/reply', async (req, res) => {
  const { authorName, authorId, role, body } = req.body || {};
  if (!authorName || !body) return res.status(400).json({ ok: false, error: 'Missing fields.' });
  const isAdminReply = role === 'admin';
  if (isAdminReply && !isAdminTokenValid(req)) return res.status(401).json({ ok: false, error: 'Admin session expired. Please sign in again.' });

  const result = await withDb(async (db) => {
    if (!isAdminReply) {
      const membership = getMembershipStatus(db, authorId);
      if (membership.restricted) return { ok: false, error: 'Your membership access is currently restricted. Contact MOLAB admin to reply.', restricted: true, membership };
    }
    const post = db.research.find(r => r.id === req.params.id);
    if (!post) return { ok: false, error: 'Post not found.' };
    post.replies = post.replies || [];
    post.replies.push({ id: genId('c'), authorName, authorId: authorId || '', role: isAdminReply ? 'admin' : 'member', body, date: Date.now() });
    logActivity(db, 'reply', authorName, authorId, `Replied on "${post.title}"`);
    return { ok: true };
  });
  res.status(result.ok ? 200 : (result.restricted ? 403 : 400)).json(result);
});

app.post('/api/research/:id/status', requireAdmin, async (req, res) => {
  const { status } = req.body || {};
  const result = await withDb(async (db) => {
    const post = db.research.find(r => r.id === req.params.id);
    if (!post) return { ok: false, error: 'Post not found.' };
    post.status = status;
    logActivity(db, 'moderation', 'Admin', null, `Set research "${post.title}" to ${status}`);
    return { ok: true };
  });
  res.json(result);
});

/* ============================================================
   PATIENT RECORDS (per member)
   ============================================================ */
app.get('/api/patients/:membershipId', async (req, res) => {
  const db = await readDbRaw();
  res.json({ ok: true, patients: db.patients[req.params.membershipId] || [] });
});

app.post('/api/patients/:membershipId', async (req, res) => {
  const { patientName } = req.body || {};
  if (!patientName) return res.status(400).json({ ok: false, error: 'Patient label is required.' });
  const result = await withDb(async (db) => {
    const membership = getMembershipStatus(db, req.params.membershipId);
    if (membership.restricted) return { ok: false, error: 'Your membership access is currently restricted. Contact MOLAB admin.', restricted: true, membership };
    const record = {
      id: genId('p'), patientName, model: 'gompertz', params: {}, holdout: false,
      dataset: [{ t: 0, v: 95 }, { t: 7, v: 140 }, { t: 14, v: 210 }, { t: 21, v: 320 }, { t: 28, v: 460 }, { t: 35, v: 640 }],
      createdAt: Date.now(), updatedAt: Date.now()
    };
    if (!db.patients[req.params.membershipId]) db.patients[req.params.membershipId] = [];
    db.patients[req.params.membershipId].push(record);
    logActivity(db, 'patient', null, req.params.membershipId, `Created patient record "${patientName}"`);
    return { ok: true, patient: record };
  });
  res.status(result.ok ? 200 : 403).json(result);
});

app.put('/api/patients/:membershipId/:patientId', async (req, res) => {
  const result = await withDb(async (db) => {
    const membership = getMembershipStatus(db, req.params.membershipId);
    if (membership.restricted) return { ok: false, error: 'Your membership access is currently restricted. Contact MOLAB admin.', restricted: true, membership };
    const list = db.patients[req.params.membershipId] || [];
    const idx = list.findIndex(p => p.id === req.params.patientId);
    if (idx < 0) return { ok: false, error: 'Patient record not found.' };
    list[idx] = Object.assign({}, list[idx], req.body, { id: list[idx].id, updatedAt: Date.now() });
    db.patients[req.params.membershipId] = list;
    return { ok: true, patient: list[idx] };
  });
  res.status(result.ok ? 200 : (result.restricted ? 403 : 400)).json(result);
});

app.delete('/api/patients/:membershipId/:patientId', async (req, res) => {
  await withDb(async (db) => {
    const list = db.patients[req.params.membershipId] || [];
    db.patients[req.params.membershipId] = list.filter(p => p.id !== req.params.patientId);
  });
  res.json({ ok: true });
});

/* ============================================================
   NOTIFICATIONS
   ============================================================ */
app.get('/api/notifications/:membershipId', async (req, res) => {
  const db = await readDbRaw();
  const profile = db.members[req.params.membershipId];
  res.json({ ok: true, notifications: profile ? (profile.notifications || []) : [] });
});
app.post('/api/notifications/:membershipId/mark-read', async (req, res) => {
  await withDb(async (db) => {
    const profile = db.members[req.params.membershipId];
    if (profile) (profile.notifications || []).forEach(n => n.read = true);
  });
  res.json({ ok: true });
});

/* ============================================================
   MEMBERSHIP STATUS (re-check without re-logging in)
   ============================================================ */
app.get('/api/membership/:membershipId', async (req, res) => {
  const db = await readDbRaw();
  const membership = getMembershipStatus(db, req.params.membershipId);
  res.json({ ok: true, membership });
});

/* ============================================================
   CONTACT ADMIN (public — works even without a member login)
   ============================================================ */
app.post('/api/contact-admin', async (req, res) => {
  const { name, email, message, membershipId } = req.body || {};
  if (!name || !message) return res.status(400).json({ ok: false, error: 'Please include your name and a message.' });
  const entry = { id: genId('sup'), name, email: email || '', membershipId: membershipId || '', message, date: Date.now(), resolved: false, response: '', responseDate: null };
  await withDb(async (db) => {
    db.supportMessages = db.supportMessages || [];
    db.supportMessages.unshift(entry);
    logActivity(db, 'support', name, membershipId || null, 'Submitted a Contact Admin message');
  });
  await sendEmail({
    to: ADMIN_EMAIL,
    subject: `vMoLab Learn — message from ${name}`,
    text: `From: ${name}${email ? ' <' + email + '>' : ''}\n\n${message}`
  });
  res.json({ ok: true });
});

/* ============================================================
   MEMBER — MY CONTACT ADMIN HISTORY
   ============================================================ */
app.get('/api/support/:membershipId', async (req, res) => {
  const db = await readDbRaw();
  const mine = (db.supportMessages || []).filter(m => m.membershipId === req.params.membershipId);
  res.json({ ok: true, messages: mine });
});

/* ============================================================
   ADMIN — OVERVIEW / ACTIVITY
   ============================================================ */
app.get('/api/admin/activity', requireAdmin, async (req, res) => {
  const db = await readDbRaw();
  res.json({ ok: true, activity: db.activityLog.slice(0, 100) });
});

/* ============================================================
   ADMIN — ROSTER
   ============================================================ */
app.get('/api/admin/roster', requireAdmin, async (req, res) => {
  const db = await readDbRaw();
  res.json({ ok: true, roster: db.roster });
});

/* ============================================================
   ADMIN — ROSTER TEMPLATE COLUMNS (fully editable — add/remove any column)
   ============================================================ */
app.get('/api/admin/roster-template-columns', requireAdmin, async (req, res) => {
  const db = await readDbRaw();
  res.json({ ok: true, columns: db.rosterTemplateColumns || [] });
});
app.post('/api/admin/roster-template-columns', requireAdmin, async (req, res) => {
  const { column } = req.body || {};
  if (!column || !column.trim()) return res.status(400).json({ ok: false, error: 'Column name is required.' });
  const result = await withDb(async (db) => {
    db.rosterTemplateColumns = db.rosterTemplateColumns || [];
    if (!db.rosterTemplateColumns.some(c => c.toLowerCase() === column.trim().toLowerCase())) db.rosterTemplateColumns.push(column.trim());
    logActivity(db, 'settings', 'Admin', null, `Added roster template column "${column.trim()}"`);
    return { ok: true, columns: db.rosterTemplateColumns };
  });
  res.json(result);
});
app.delete('/api/admin/roster-template-columns/:column', requireAdmin, async (req, res) => {
  const result = await withDb(async (db) => {
    db.rosterTemplateColumns = (db.rosterTemplateColumns || []).filter(c => c !== req.params.column);
    logActivity(db, 'settings', 'Admin', null, `Removed roster template column "${req.params.column}"`);
    return { ok: true, columns: db.rosterTemplateColumns };
  });
  res.json(result);
});

app.post('/api/admin/roster/import', requireAdmin, async (req, res) => {
  const { entries, replace } = req.body || {};
  if (!Array.isArray(entries) || !entries.length) return res.status(400).json({ ok: false, error: 'No valid rows to import.' });

  const result = await withDb(async (db) => {
    let roster = replace ? [] : db.roster.slice();
    let imported = 0;
    entries.forEach(entry => {
      if (!entry.name || !entry.membershipId) return;
      const idx = roster.findIndex(r => normId(r.membershipId) === normId(entry.membershipId));
      if (idx >= 0) {
        roster[idx].name = entry.name;
        roster[idx].email = entry.email || roster[idx].email;
        roster[idx].country = entry.country || roster[idx].country;
        roster[idx].institution = entry.institution || roster[idx].institution || '';
        roster[idx].membershipStatus = entry.membershipStatus || roster[idx].membershipStatus || '';
        roster[idx].status = 'active';
      } else {
        roster.push({ name: entry.name, membershipId: entry.membershipId, email: entry.email || '', country: entry.country || '', institution: entry.institution || '', membershipStatus: entry.membershipStatus || '', status: 'active', locked: false, lockReason: '', lockedAt: null, addedAt: Date.now() });
      }
      imported++;
    });
    db.roster = roster;
    logActivity(db, 'roster', 'Admin', null, `Imported ${imported} membership record(s)`);
    return { ok: true, imported, total: roster.length };
  });
  res.json(result);
});

/* ============================================================
   ADMIN — MEMBERS
   ============================================================ */
app.get('/api/admin/members', requireAdmin, async (req, res) => {
  const db = await readDbRaw();
  const members = db.roster.map(r => {
    const profile = db.members[r.membershipId];
    const pts = db.patients[r.membershipId] || [];
    const membership = getMembershipStatus(db, r.membershipId);
    return {
      name: r.name, membershipId: r.membershipId, email: r.email, country: r.country,
      membershipStatus: r.membershipStatus || (profile ? profile.membershipStatus : '') || '',
      institution: profile ? profile.institution : '',
      status: r.status, loginCount: profile ? profile.loginCount : 0,
      lastLogin: profile ? profile.lastLogin : null, patientCount: pts.length,
      locked: membership.locked, lockReason: membership.lockReason,
      membershipExpiresAt: membership.expiresAt, restricted: membership.restricted, restrictionReason: membership.reason
    };
  });
  res.json({ ok: true, members });
});

app.post('/api/admin/members/:id/flag', requireAdmin, async (req, res) => {
  const { reason } = req.body || {};
  if (!reason) return res.status(400).json({ ok: false, error: 'Reason is required.' });
  await withDb(async (db) => {
    const entry = db.roster.find(r => normId(r.membershipId) === normId(req.params.id));
    db.flags.unshift({ id: genId('f'), targetType: 'member', targetId: req.params.id, targetLabel: entry ? entry.name : req.params.id, reason, by: 'Admin', date: Date.now(), resolved: false });
    logActivity(db, 'moderation', 'Admin', null, `Flagged member ${entry ? entry.name : req.params.id}: ${reason}`);
  });
  res.json({ ok: true });
});

app.post('/api/admin/members/:id/remove', requireAdmin, async (req, res) => {
  await withDb(async (db) => {
    const entry = db.roster.find(r => normId(r.membershipId) === normId(req.params.id));
    if (entry) entry.status = 'removed';
    logActivity(db, 'moderation', 'Admin', null, `Removed member access: ${entry ? entry.name : req.params.id}`);
  });
  res.json({ ok: true });
});

app.post('/api/admin/members/:id/reinstate', requireAdmin, async (req, res) => {
  await withDb(async (db) => {
    const entry = db.roster.find(r => normId(r.membershipId) === normId(req.params.id));
    if (entry) entry.status = 'active';
    logActivity(db, 'moderation', 'Admin', null, `Reinstated member access: ${entry ? entry.name : req.params.id}`);
  });
  res.json({ ok: true });
});

app.post('/api/admin/members/:id/lock', requireAdmin, async (req, res) => {
  const { reason } = req.body || {};
  if (!reason) return res.status(400).json({ ok: false, error: 'A reason is required to lock a membership.' });
  await withDb(async (db) => {
    const entry = db.roster.find(r => normId(r.membershipId) === normId(req.params.id));
    if (entry) { entry.locked = true; entry.lockReason = reason; entry.lockedAt = Date.now(); }
    if (!db.members[req.params.id]) db.members[req.params.id] = { notifications: [] };
    const profile = db.members[req.params.id];
    profile.notifications = profile.notifications || [];
    profile.notifications.push({ msg: 'Your vMoLab Learn access has been locked by MOLAB admin. Please contact admin for details.', date: Date.now(), read: false });
    logActivity(db, 'moderation', 'Admin', null, `Locked membership for ${entry ? entry.name : req.params.id}: ${reason}`);
  });
  res.json({ ok: true });
});

app.post('/api/admin/members/:id/unlock', requireAdmin, async (req, res) => {
  await withDb(async (db) => {
    const entry = db.roster.find(r => normId(r.membershipId) === normId(req.params.id));
    if (entry) { entry.locked = false; entry.lockReason = ''; entry.lockedAt = null; }
    if (!db.members[req.params.id]) db.members[req.params.id] = { notifications: [] };
    const profile = db.members[req.params.id];
    profile.notifications = profile.notifications || [];
    profile.notifications.push({ msg: 'Your vMoLab Learn access has been unlocked — welcome back!', date: Date.now(), read: false });
    logActivity(db, 'moderation', 'Admin', null, `Unlocked membership for ${entry ? entry.name : req.params.id}`);
  });
  res.json({ ok: true });
});

app.post('/api/admin/members/:id/renew', requireAdmin, async (req, res) => {
  const result = await withDb(async (db) => {
    const entry = db.roster.find(r => normId(r.membershipId) === normId(req.params.id));
    if (!db.members[req.params.id]) db.members[req.params.id] = { name: entry ? entry.name : req.params.id, membershipId: req.params.id, loginCount: 0, notifications: [] };
    const profile = db.members[req.params.id];
    profile.firstLogin = Date.now();
    profile.notifications = profile.notifications || [];
    profile.notifications.push({ msg: 'Your vMoLab Learn membership has been renewed for another 12 months!', date: Date.now(), read: false });
    logActivity(db, 'moderation', 'Admin', null, `Renewed membership (reset 12-month timer) for ${entry ? entry.name : req.params.id}`);
    return { ok: true, membership: getMembershipStatus(db, req.params.id) };
  });
  res.json(result);
});

app.post('/api/admin/members/:id/message', requireAdmin, async (req, res) => {
  const { subject, body, toEmailOverride } = req.body || {};
  if (!body) return res.status(400).json({ ok: false, error: 'Message body is required.' });

  const { profileEmail } = await withDb(async (db) => {
    if (!db.members[req.params.id]) db.members[req.params.id] = { notifications: [] };
    const profile = db.members[req.params.id];
    profile.notifications = profile.notifications || [];
    profile.notifications.push({ msg: `${subject ? subject + ': ' : ''}${body}`, date: Date.now(), read: false });
    logActivity(db, 'message', 'Admin', req.params.id, 'Sent a direct message');
    return { profileEmail: profile.email };
  });

  const to = toEmailOverride || profileEmail;
  let emailResult = { sent: false };
  if (to) emailResult = await sendEmail({ to, subject: subject || 'Message from MOLAB Pakistan', text: body });
  res.json({ ok: true, emailSent: emailResult.sent });
});

app.post('/api/admin/broadcast', requireAdmin, async (req, res) => {
  const { subject, body, tag } = req.body || {};
  if (!subject || !body) return res.status(400).json({ ok: false, error: 'Subject and message are required.' });

  const { emails, count } = await withDb(async (db) => {
    const activeIds = db.roster.filter(r => r.status !== 'removed').map(r => r.membershipId);
    activeIds.forEach(id => {
      if (!db.members[id]) db.members[id] = { notifications: [] };
      const profile = db.members[id];
      profile.notifications = profile.notifications || [];
      profile.notifications.push({ msg: `${tag ? '[' + tag + '] ' : ''}${subject}: ${body}`, date: Date.now(), read: false });
    });
    const emails = activeIds.map(id => (db.members[id] && db.members[id].email) || (db.roster.find(r => r.membershipId === id) || {}).email).filter(Boolean);
    db.broadcasts = db.broadcasts || [];
    db.broadcasts.unshift({ id: genId('bc'), subject, body, tag: tag || '', date: Date.now() });
    logActivity(db, 'broadcast', 'Admin', null, `Broadcast announcement${tag ? ' [' + tag + ']' : ''}: "${subject}" to ${activeIds.length} member(s)`);
    return { emails, count: activeIds.length };
  });

  let emailResult = { sent: false };
  if (emails.length) emailResult = await sendEmail({ bcc: emails, subject, text: body });
  res.json({ ok: true, notifiedCount: count, emailedCount: emails.length, emailSent: emailResult.sent });
});

/* ============================================================
   BROADCASTS (public feed — the "Announcements" tab members see)
   ============================================================ */
app.get('/api/broadcasts', async (req, res) => {
  const db = await readDbRaw();
  res.json({ ok: true, broadcasts: db.broadcasts || [] });
});

/* ============================================================
   BROADCAST TAGS (Opportunities / Capacity Building / Workshops / Courses,
   fully admin-editable)
   ============================================================ */
app.get('/api/broadcast-tags', async (req, res) => {
  const db = await readDbRaw();
  res.json({ ok: true, tags: db.broadcastTags || [] });
});
app.post('/api/admin/broadcast-tags', requireAdmin, async (req, res) => {
  const { tag } = req.body || {};
  if (!tag || !tag.trim()) return res.status(400).json({ ok: false, error: 'Tag name is required.' });
  const result = await withDb(async (db) => {
    db.broadcastTags = db.broadcastTags || [];
    if (!db.broadcastTags.some(t => t.toLowerCase() === tag.trim().toLowerCase())) db.broadcastTags.push(tag.trim());
    logActivity(db, 'settings', 'Admin', null, `Added broadcast tag "${tag.trim()}"`);
    return { ok: true, tags: db.broadcastTags };
  });
  res.json(result);
});
app.delete('/api/admin/broadcast-tags/:tag', requireAdmin, async (req, res) => {
  const result = await withDb(async (db) => {
    db.broadcastTags = (db.broadcastTags || []).filter(t => t !== req.params.tag);
    logActivity(db, 'settings', 'Admin', null, `Removed broadcast tag "${req.params.tag}"`);
    return { ok: true, tags: db.broadcastTags };
  });
  res.json(result);
});

/* ============================================================
   ADMIN — FLAGS
   ============================================================ */
app.get('/api/admin/flags', requireAdmin, async (req, res) => {
  const db = await readDbRaw();
  res.json({ ok: true, flags: db.flags });
});
app.post('/api/admin/flags/:id/resolve', requireAdmin, async (req, res) => {
  await withDb(async (db) => {
    const f = db.flags.find(x => x.id === req.params.id);
    if (f) f.resolved = true;
  });
  res.json({ ok: true });
});

/* ============================================================
   ADMIN — SUPPORT INBOX (Contact Admin messages)
   ============================================================ */
app.get('/api/admin/support', requireAdmin, async (req, res) => {
  const db = await readDbRaw();
  res.json({ ok: true, messages: db.supportMessages || [] });
});
app.post('/api/admin/support/:id/resolve', requireAdmin, async (req, res) => {
  await withDb(async (db) => {
    const m = (db.supportMessages || []).find(x => x.id === req.params.id);
    if (m) {
      m.resolved = true;
      if (m.membershipId && db.members[m.membershipId]) {
        const profile = db.members[m.membershipId];
        profile.notifications = profile.notifications || [];
        profile.notifications.push({ msg: 'MOLAB admin marked your query as resolved.', date: Date.now(), read: false });
      }
    }
  });
  res.json({ ok: true });
});
app.post('/api/admin/support/:id/respond', requireAdmin, async (req, res) => {
  const { response } = req.body || {};
  if (!response) return res.status(400).json({ ok: false, error: 'Response text is required.' });
  const result = await withDb(async (db) => {
    const m = (db.supportMessages || []).find(x => x.id === req.params.id);
    if (!m) return { ok: false, error: 'Message not found.' };
    m.response = response;
    m.responseDate = Date.now();
    m.resolved = true;
    if (m.membershipId && db.members[m.membershipId]) {
      const profile = db.members[m.membershipId];
      profile.notifications = profile.notifications || [];
      profile.notifications.push({ msg: `MOLAB admin responded to your message: ${response}`, date: Date.now(), read: false });
    }
    return { ok: true };
  });
  const targetEmail = (await readDbRaw()).supportMessages.find(x => x.id === req.params.id);
  if (targetEmail && targetEmail.email) await sendEmail({ to: targetEmail.email, subject: 'Response from MOLAB Pakistan', text: response });
  res.json(result);
});

/* ============================================================
   ADMIN — PERKS / COMMUNITY SPOTLIGHT
   ============================================================ */
app.get('/api/admin/perks', requireAdmin, async (req, res) => {
  const db = await readDbRaw();
  res.json({ ok: true, perks: db.perks });
});
app.post('/api/admin/perks', requireAdmin, async (req, res) => {
  const { membershipId, memberName, perkType, note } = req.body || {};
  if (!membershipId || !perkType) return res.status(400).json({ ok: false, error: 'Member and perk type are required.' });
  const perk = { id: genId('perk'), membershipId, memberName: memberName || membershipId, perkType, note: note || '', assignedAt: Date.now() };
  await withDb(async (db) => {
    db.perks.unshift(perk);
    if (!db.members[membershipId]) db.members[membershipId] = { notifications: [] };
    const profile = db.members[membershipId];
    profile.notifications = profile.notifications || [];
    profile.notifications.push({ msg: `🏆 You've been recognized as "${perkType}"${note ? ' — ' + note : ''}!`, date: Date.now(), read: false });
    logActivity(db, 'perk', 'Admin', membershipId, `Awarded "${perkType}" to ${memberName || membershipId}`);
  });
  res.json({ ok: true, perk });
});
app.delete('/api/admin/perks/:id', requireAdmin, async (req, res) => {
  await withDb(async (db) => { db.perks = db.perks.filter(p => p.id !== req.params.id); });
  res.json({ ok: true });
});

/* ============================================================
   MEMBERSHIP CARD / LETTER TEMPLATES
   Admin uploads background artwork once; each member's card/letter
   is generated client-side at download time with their own Name,
   Institution, Membership Status, and 12-month validity dates
   overlaid on top of that artwork.
   ============================================================ */
/* ============================================================
   MEMBERSHIP CARD / LETTER TEMPLATES
   Admin can upload new card artwork, adjust where the four fields land on
   it, and edit the welcome letter's heading/body/signature — anytime.
   Each member's card/letter is generated client-side at download time with
   their own Name, Institution, Membership Status/ID, and validity dates
   filled in.
   ============================================================ */
app.get('/api/templates', async (req, res) => {
  const db = await readDbRaw();
  res.json({ ok: true, templates: db.templates || DEFAULT_DB.templates });
});
app.post('/api/admin/templates', requireAdmin, async (req, res) => {
  const { cardImage, cardPositions, letterHeading, letterBody, letterSignatureName, letterSignatureTitle } = req.body || {};
  await withDb(async (db) => {
    const current = db.templates || DEFAULT_DB.templates;
    db.templates = {
      cardImage: cardImage !== undefined ? cardImage : current.cardImage,
      cardPositions: cardPositions !== undefined ? Object.assign({}, current.cardPositions, cardPositions) : current.cardPositions,
      letterHeading: letterHeading !== undefined ? letterHeading : current.letterHeading,
      letterBody: letterBody !== undefined ? letterBody : current.letterBody,
      letterSignatureName: letterSignatureName !== undefined ? letterSignatureName : current.letterSignatureName,
      letterSignatureTitle: letterSignatureTitle !== undefined ? letterSignatureTitle : current.letterSignatureTitle
    };
    logActivity(db, 'templates', 'Admin', null, 'Updated membership card/letter templates');
  });
  res.json({ ok: true });
});

/* ============================================================
   FALLBACK — serve the app for any other route
   ============================================================ */
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
initStorage().then(() => {
  app.listen(PORT, () => {
    console.log(`vMoLab Learn server running on port ${PORT}`);
    console.log(useMongo ? 'Storage: MongoDB Atlas' : (usePg ? 'Storage: Neon/Postgres' : `Storage: local file (${DATA_DIR})`));
  });
});
