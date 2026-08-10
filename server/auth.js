const cookieSignature = require('cookie-signature');
const crypto = require('crypto');
const db = require('./db');

const SESSION_SECRET = process.env.SESSION_SECRET || 'beachhouse-dev-secret-change-me';
// Master key only the treasurer knows — used solely to reset a family's password
// if they forget it. Never stored per-family, never shown in the UI nav.
const ADMIN_RESET_KEY = process.env.ADMIN_RESET_KEY || 'change-me-admin-key';

const FAMILIES = ['Stevens', 'Furr', 'Wagner'];
const SCHEDULING_ADMIN_FAMILY = 'Furr'; // Brett — finalizes weeks

const COOKIE_NAME = 'bh_session';

// ---------- Password hashing (scrypt, no extra native deps) ----------

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, salt, expectedHash) {
  if (!password || !salt || !expectedHash) return false;
  const candidateHash = crypto.scryptSync(password, salt, 64).toString('hex');
  const a = Buffer.from(candidateHash, 'hex');
  const b = Buffer.from(expectedHash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function setFamilyPassword(family, newPassword, updatedBy) {
  const { salt, hash } = hashPassword(newPassword);
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO family_credentials (family, password_hash, password_salt, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(family) DO UPDATE SET password_hash = excluded.password_hash,
       password_salt = excluded.password_salt, updated_at = excluded.updated_at, updated_by = excluded.updated_by`
  ).run(family, hash, salt, now, updatedBy);
}

function getFamilyCredential(family) {
  return db.prepare('SELECT * FROM family_credentials WHERE family = ?').get(family);
}

function checkFamilyLogin(family, password) {
  const cred = getFamilyCredential(family);
  if (!cred) return { ok: false, reason: 'no-password-set' };
  const ok = verifyPassword(password, cred.password_salt, cred.password_hash);
  return { ok, reason: ok ? null : 'wrong-password' };
}

function checkAdminKey(candidate) {
  if (typeof candidate !== 'string' || candidate.length === 0) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(ADMIN_RESET_KEY);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ---------- Sessions ----------

function makeSessionCookie(family) {
  const payload = JSON.stringify({ family, ts: Date.now() });
  const encoded = Buffer.from(payload).toString('base64');
  return cookieSignature.sign(encoded, SESSION_SECRET);
}

function readSession(req) {
  const raw = req.cookies && req.cookies[COOKIE_NAME];
  if (!raw) return null;
  const unsigned = cookieSignature.unsign(raw, SESSION_SECRET);
  if (!unsigned) return null;
  try {
    const payload = JSON.parse(Buffer.from(unsigned, 'base64').toString('utf8'));
    if (!FAMILIES.includes(payload.family)) return null;
    return { family: payload.family, isAdmin: payload.family === SCHEDULING_ADMIN_FAMILY };
  } catch (e) {
    return null;
  }
}

function requireAuth(req, res, next) {
  const session = readSession(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  req.session = session;
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session || !req.session.isAdmin) {
    return res.status(403).json({ error: 'Admin (Furr family) only' });
  }
  next();
}

module.exports = {
  FAMILIES,
  SCHEDULING_ADMIN_FAMILY,
  COOKIE_NAME,
  hashPassword,
  verifyPassword,
  setFamilyPassword,
  getFamilyCredential,
  checkFamilyLogin,
  checkAdminKey,
  makeSessionCookie,
  readSession,
  requireAuth,
  requireAdmin,
};
