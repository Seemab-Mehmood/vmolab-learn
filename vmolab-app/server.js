/**
 * vMoLab Learn — Server
 * Express backend + JSON-file persistence + nodemailer email.
 *
 * ENVIRONMENT VARIABLES (set these in Render's dashboard):
 *   PORT              — provided automatically by Render
 *   DATA_DIR           — path to a persistent disk mount (e.g. /data). Falls back to ./data
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

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* ============================================================
   PERSISTENCE — simple JSON-file "database" with a write mutex
   ============================================================ */
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

const DEFAULT_DB = {
  roster: [],        // [{name, membershipId, email, country, status, addedAt}]
  members: {},        // { [membershipId]: {name, membershipId, email, country, loginCount, firstLogin, lastLogin, notifications:[]} }
  patients: {},        // { [membershipId]: [ {id, patientName, model, params, dataset, holdout, createdAt, updatedAt} ] }
  research: [],        // [ {id, name, membershipId, title, body, date, status, replies:[]} ]
  flags: [],          // [ {id, targetType, targetId, targetLabel, reason, by, date, resolved} ]
  perks: [],          // [ {id, membershipId, memberName, perkType, note, assignedAt} ]
  activityLog: []       // [ {ts, type, name, membershipId, detail} ]
};

function ensureDb(){
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify(DEFAULT_DB, null, 2));
}
function readDbRaw(){
  ensureDb();
  try { return Object.assign({}, DEFAULT_DB, JSON.parse(fs.readFileSync(DB_FILE, 'utf8'))); }
  catch(e){ return JSON.parse(JSON.stringify(DEFAULT_DB)); }
}
function writeDbRaw(db){ fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }

// Serialize all read-modify-write operations so concurrent requests never corrupt the file.
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
    const db = readDbRaw();
    const result = await mutatorFn(db);
    writeDbRaw(db);
    return result;
  });
}

function normId(s){ return (s || '').toString().trim().toUpperCase(); }
function normName(s){ return (s || '').toString().trim().replace(/\s+/g, ' ').toLowerCase(); }
function genId(prefix){ return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

function logActivity(db, type, name, membershipId, detail){
  db.activityLog.unshift({ ts: Date.now(), type, name: name || 'Admin', membershipId: membershipId || '-', detail });
  db.activityLog = db.activityLog.slice(0, 400);
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
function requireAdmin(req, res, next){
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  const expiry = token && adminTokens.get(token);
  if (!expiry || expiry < Date.now()) return res.status(401).json({ ok: false, error: 'Admin session expired. Please sign in again.' });
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
  const { name, membershipId, country } = req.body || {};
  if (!name || !membershipId) return res.status(400).json({ ok: false, error: 'Full name and Membership ID are required.' });

  const result = await withDb(async (db) => {
    const entry = db.roster.find(r => normId(r.membershipId) === normId(membershipId));
    if (!entry) return { ok: false, error: 'Membership ID not found. Please contact your MOLAB admin.' };
    if (entry.status === 'removed') return { ok: false, error: 'This membership has been deactivated. Contact your MOLAB admin.' };
    if (normName(entry.name) !== normName(name)) return { ok: false, error: 'Name does not match our records for this Membership ID.' };

    if (!db.members[entry.membershipId]) {
      db.members[entry.membershipId] = { name: entry.name, membershipId: entry.membershipId, email: entry.email || '', country: entry.country || '', loginCount: 0, firstLogin: Date.now(), lastLogin: null, notifications: [] };
    }
    const profile = db.members[entry.membershipId];
    profile.loginCount += 1;
    profile.lastLogin = Date.now();
    profile.name = entry.name;
    if (country && !profile.country) profile.country = country;
    logActivity(db, 'login', entry.name, entry.membershipId, 'Member signed in');
    return { ok: true, member: profile };
  });

  res.status(result.ok ? 200 : 401).json(result);
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

/* ============================================================
   PUBLIC STATS
   ============================================================ */
app.get('/api/stats', (req, res) => {
  const db = readDbRaw();
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
app.get('/api/research', (req, res) => {
  const db = readDbRaw();
  res.json({ ok: true, research: db.research });
});

app.post('/api/research', async (req, res) => {
  const { name, membershipId, title, body } = req.body || {};
  if (!name || !membershipId || !title || !body) return res.status(400).json({ ok: false, error: 'Missing fields.' });
  const entry = { id: genId('r'), name, membershipId, title, body, date: Date.now(), status: 'open', replies: [] };
  await withDb(async (db) => {
    db.research.unshift(entry);
    logActivity(db, 'research', name, membershipId, `Submitted pitch "${title}"`);
  });
  res.json({ ok: true, entry });
});

app.post('/api/research/:id/reply', async (req, res) => {
  const { authorName, authorId, role, body } = req.body || {};
  if (!authorName || !body) return res.status(400).json({ ok: false, error: 'Missing fields.' });
  const result = await withDb(async (db) => {
    const post = db.research.find(r => r.id === req.params.id);
    if (!post) return { ok: false, error: 'Post not found.' };
    post.replies = post.replies || [];
    post.replies.push({ id: genId('c'), authorName, authorId: authorId || '', role: role === 'admin' ? 'admin' : 'member', body, date: Date.now() });
    logActivity(db, 'reply', authorName, authorId, `Replied on "${post.title}"`);
    return { ok: true };
  });
  res.json(result);
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
app.get('/api/patients/:membershipId', (req, res) => {
  const db = readDbRaw();
  res.json({ ok: true, patients: db.patients[req.params.membershipId] || [] });
});

app.post('/api/patients/:membershipId', async (req, res) => {
  const { patientName } = req.body || {};
  if (!patientName) return res.status(400).json({ ok: false, error: 'Patient label is required.' });
  const record = {
    id: genId('p'), patientName, model: 'gompertz', params: {}, holdout: false,
    dataset: [{ t: 0, v: 95 }, { t: 7, v: 140 }, { t: 14, v: 210 }, { t: 21, v: 320 }, { t: 28, v: 460 }, { t: 35, v: 640 }],
    createdAt: Date.now(), updatedAt: Date.now()
  };
  await withDb(async (db) => {
    if (!db.patients[req.params.membershipId]) db.patients[req.params.membershipId] = [];
    db.patients[req.params.membershipId].push(record);
    logActivity(db, 'patient', null, req.params.membershipId, `Created patient record "${patientName}"`);
  });
  res.json({ ok: true, patient: record });
});

app.put('/api/patients/:membershipId/:patientId', async (req, res) => {
  const result = await withDb(async (db) => {
    const list = db.patients[req.params.membershipId] || [];
    const idx = list.findIndex(p => p.id === req.params.patientId);
    if (idx < 0) return { ok: false, error: 'Patient record not found.' };
    list[idx] = Object.assign({}, list[idx], req.body, { id: list[idx].id, updatedAt: Date.now() });
    db.patients[req.params.membershipId] = list;
    return { ok: true, patient: list[idx] };
  });
  res.json(result);
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
app.get('/api/notifications/:membershipId', (req, res) => {
  const db = readDbRaw();
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
   ADMIN — OVERVIEW / ACTIVITY
   ============================================================ */
app.get('/api/admin/activity', requireAdmin, (req, res) => {
  const db = readDbRaw();
  res.json({ ok: true, activity: db.activityLog.slice(0, 100) });
});

/* ============================================================
   ADMIN — ROSTER
   ============================================================ */
app.get('/api/admin/roster', requireAdmin, (req, res) => {
  const db = readDbRaw();
  res.json({ ok: true, roster: db.roster });
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
        roster[idx].status = 'active';
      } else {
        roster.push({ name: entry.name, membershipId: entry.membershipId, email: entry.email || '', country: entry.country || '', status: 'active', addedAt: Date.now() });
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
app.get('/api/admin/members', requireAdmin, (req, res) => {
  const db = readDbRaw();
  const members = db.roster.map(r => {
    const profile = db.members[r.membershipId];
    const pts = db.patients[r.membershipId] || [];
    return {
      name: r.name, membershipId: r.membershipId, email: r.email, country: r.country,
      status: r.status, loginCount: profile ? profile.loginCount : 0,
      lastLogin: profile ? profile.lastLogin : null, patientCount: pts.length
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
  const { subject, body } = req.body || {};
  if (!subject || !body) return res.status(400).json({ ok: false, error: 'Subject and message are required.' });

  const { emails, count } = await withDb(async (db) => {
    const activeIds = db.roster.filter(r => r.status !== 'removed').map(r => r.membershipId);
    activeIds.forEach(id => {
      if (!db.members[id]) db.members[id] = { notifications: [] };
      const profile = db.members[id];
      profile.notifications = profile.notifications || [];
      profile.notifications.push({ msg: `${subject}: ${body}`, date: Date.now(), read: false });
    });
    const emails = activeIds.map(id => (db.members[id] && db.members[id].email) || (db.roster.find(r => r.membershipId === id) || {}).email).filter(Boolean);
    logActivity(db, 'broadcast', 'Admin', null, `Broadcast announcement: "${subject}" to ${activeIds.length} member(s)`);
    return { emails, count: activeIds.length };
  });

  let emailResult = { sent: false };
  if (emails.length) emailResult = await sendEmail({ bcc: emails, subject, text: body });
  res.json({ ok: true, notifiedCount: count, emailedCount: emails.length, emailSent: emailResult.sent });
});

/* ============================================================
   ADMIN — FLAGS
   ============================================================ */
app.get('/api/admin/flags', requireAdmin, (req, res) => {
  const db = readDbRaw();
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
   ADMIN — PERKS / COMMUNITY SPOTLIGHT
   ============================================================ */
app.get('/api/admin/perks', requireAdmin, (req, res) => {
  const db = readDbRaw();
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
   FALLBACK — serve the app for any other route
   ============================================================ */
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  ensureDb();
  console.log(`vMoLab Learn server running on port ${PORT}`);
  console.log(`Data directory: ${DATA_DIR}`);
});
