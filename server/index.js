const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');
const { nanoid } = require('nanoid');

const db = require('./db');
const { generateWeeks, formatRange } = require('./weeks');
const {
  FAMILIES,
  SCHEDULING_ADMIN_FAMILY,
  COOKIE_NAME,
  setFamilyPassword,
  getFamilyCredential,
  checkFamilyLogin,
  checkAdminKey,
  makeSessionCookie,
  readSession,
  requireAuth,
  requireAdmin,
} = require('./auth');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, '..', 'public')));

const cookieOpts = {
  httpOnly: true,
  sameSite: 'lax',
  maxAge: 1000 * 60 * 60 * 24 * 180, // 180 days
};

// ---------- Auth ----------

app.post('/api/login', (req, res) => {
  const { password, family } = req.body || {};
  if (!FAMILIES.includes(family)) {
    return res.status(400).json({ error: 'Choose a valid family' });
  }
  const result = checkFamilyLogin(family, password);
  if (!result.ok) {
    if (result.reason === 'no-password-set') {
      return res.status(401).json({ error: `No password has been set for ${family} yet — ask your treasurer to set one.` });
    }
    return res.status(401).json({ error: 'Incorrect password' });
  }
  const cookie = makeSessionCookie(family);
  res.cookie(COOKIE_NAME, cookie, cookieOpts);
  res.json({ family, isAdmin: family === SCHEDULING_ADMIN_FAMILY });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME);
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  const session = readSession(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  res.json({ ...session, families: FAMILIES });
});

// Self-service: a logged-in family changes their own password.
app.post('/api/change-password', requireAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters' });
  }
  const result = checkFamilyLogin(req.session.family, currentPassword);
  if (!result.ok) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }
  setFamilyPassword(req.session.family, newPassword, 'self');
  res.json({ ok: true });
});

// ---------- Treasurer backdoor: reset any family's password ----------
// Gated by ADMIN_RESET_KEY (an env var only the treasurer knows), not by any
// family login. Gives a way in if a family forgets their password.

const adminAttempts = new Map(); // ip -> { count, lockedUntil }
function checkAdminRateLimit(ip) {
  const entry = adminAttempts.get(ip);
  if (!entry) return true;
  if (entry.lockedUntil && Date.now() < entry.lockedUntil) return false;
  return true;
}
function recordAdminFailure(ip) {
  const entry = adminAttempts.get(ip) || { count: 0, lockedUntil: null };
  entry.count += 1;
  if (entry.count >= 5) {
    entry.lockedUntil = Date.now() + 15 * 60 * 1000; // 15 min lockout
    entry.count = 0;
  }
  adminAttempts.set(ip, entry);
}
function clearAdminFailures(ip) {
  adminAttempts.delete(ip);
}

app.post('/api/admin/status', (req, res) => {
  const { adminKey } = req.body || {};
  const ip = req.ip;
  if (!checkAdminRateLimit(ip)) {
    return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
  }
  if (!checkAdminKey(adminKey)) {
    recordAdminFailure(ip);
    return res.status(401).json({ error: 'Incorrect admin key' });
  }
  clearAdminFailures(ip);
  const statuses = FAMILIES.map((family) => {
    const cred = getFamilyCredential(family);
    return {
      family,
      hasPassword: !!cred,
      updatedAt: cred ? cred.updated_at : null,
      updatedBy: cred ? cred.updated_by : null,
    };
  });
  res.json(statuses);
});

app.post('/api/admin/reset-password', (req, res) => {
  const { adminKey, family, newPassword } = req.body || {};
  const ip = req.ip;
  if (!checkAdminRateLimit(ip)) {
    return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
  }
  if (!checkAdminKey(adminKey)) {
    recordAdminFailure(ip);
    return res.status(401).json({ error: 'Incorrect admin key' });
  }
  clearAdminFailures(ip);
  if (!FAMILIES.includes(family)) {
    return res.status(400).json({ error: 'Invalid family' });
  }
  if (!newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters' });
  }
  setFamilyPassword(family, newPassword, 'admin');
  res.json({ ok: true });
});

// ---------- Periods & Weeks ----------

// A response's `note` is private: only visible to the family who wrote it,
// or to the scheduling admin (Furr), who needs full visibility to make
// assignments. Everyone else sees that a family responded, just not why.
function redactResponse(row, viewer) {
  const canSeeNote = viewer.isAdmin || viewer.family === row.family;
  return {
    id: row.id,
    family: row.family,
    note: canSeeNote ? row.note : null,
    notePrivate: !canSeeNote && !!row.note,
    created_at: row.created_at,
  };
}

function serializeWeek(row, viewer) {
  const responses = db
    .prepare('SELECT id, family, kind, note, created_at FROM week_responses WHERE week_id = ? ORDER BY created_at ASC')
    .all(row.id);
  const requests = responses.filter((r) => r.kind === 'requested').map((r) => redactResponse(r, viewer));
  const unavailable = responses.filter((r) => r.kind === 'unavailable').map((r) => redactResponse(r, viewer));
  const comments = db
    .prepare('SELECT id, family, message, created_at FROM comments WHERE week_id = ? ORDER BY created_at ASC')
    .all(row.id);
  return {
    id: row.id,
    period_id: row.period_id,
    start_date: row.start_date,
    end_date: row.end_date,
    range_label: formatRange(row.start_date, row.end_date),
    status: row.status,
    finalized_family: row.finalized_family,
    sort_index: row.sort_index,
    requests,
    unavailable,
    comments,
  };
}

app.get('/api/periods', requireAuth, (req, res) => {
  const periods = db.prepare('SELECT * FROM periods ORDER BY start_date ASC').all();
  const result = periods.map((p) => {
    const weeks = db
      .prepare('SELECT * FROM weeks WHERE period_id = ? ORDER BY sort_index ASC')
      .all(p.id)
      .map((w) => serializeWeek(w, req.session));
    return { ...p, weeks };
  });
  res.json(result);
});

app.post('/api/periods', requireAuth, requireAdmin, (req, res) => {
  const { label, start_date, end_date } = req.body || {};
  if (!label || !start_date || !end_date) {
    return res.status(400).json({ error: 'label, start_date, end_date are required' });
  }
  if (end_date < start_date) {
    return res.status(400).json({ error: 'end_date must be after start_date' });
  }
  const generated = generateWeeks(start_date, end_date);
  if (generated.length === 0) {
    return res.status(400).json({ error: 'No Thursday–Wednesday weeks fall in that range' });
  }

  const periodId = nanoid();
  const now = new Date().toISOString();

  const insertPeriod = db.prepare(
    'INSERT INTO periods (id, label, start_date, end_date, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)'
  );
  const insertWeek = db.prepare(
    'INSERT INTO weeks (id, period_id, start_date, end_date, status, sort_index) VALUES (?, ?, ?, ?, ?, ?)'
  );

  const tx = db.transaction(() => {
    insertPeriod.run(periodId, label, start_date, end_date, now, req.session.family);
    for (const w of generated) {
      insertWeek.run(nanoid(), periodId, w.start_date, w.end_date, 'open', w.sort_index);
    }
  });
  tx();

  res.status(201).json({ id: periodId, weeksCreated: generated.length });
});

app.delete('/api/periods/:id', requireAuth, requireAdmin, (req, res) => {
  const { id } = req.params;
  const tx = db.transaction(() => {
    const weekIds = db.prepare('SELECT id FROM weeks WHERE period_id = ?').all(id).map((w) => w.id);
    for (const weekId of weekIds) {
      db.prepare('DELETE FROM week_responses WHERE week_id = ?').run(weekId);
      db.prepare('DELETE FROM comments WHERE week_id = ?').run(weekId);
    }
    db.prepare('DELETE FROM weeks WHERE period_id = ?').run(id);
    db.prepare('DELETE FROM periods WHERE id = ?').run(id);
  });
  tx();
  res.json({ ok: true });
});

// Recompute a week's public status from its responses. Unavailability never
// affects this — only requests do. Finalized weeks are left untouched here;
// callers guard against responding to a finalized week in the first place.
function recomputeWeekStatus(weekId) {
  const week = db.prepare('SELECT * FROM weeks WHERE id = ?').get(weekId);
  if (!week || week.status === 'finalized') return;
  const requestedCount = db
    .prepare("SELECT COUNT(*) as c FROM week_responses WHERE week_id = ? AND kind = 'requested'")
    .get(weekId).c;
  const nextStatus = requestedCount > 0 ? 'requested' : 'open';
  if (nextStatus !== week.status) {
    db.prepare('UPDATE weeks SET status = ? WHERE id = ?').run(nextStatus, weekId);
  }
}

// ---------- Responses: a family requests a week OR marks it unavailable ----------
// Mutually exclusive — at most one response per family per week.

app.post('/api/weeks/:id/response', requireAuth, (req, res) => {
  const { id } = req.params;
  const { kind, note } = req.body || {};
  if (!['requested', 'unavailable'].includes(kind)) {
    return res.status(400).json({ error: "kind must be 'requested' or 'unavailable'" });
  }
  const week = db.prepare('SELECT * FROM weeks WHERE id = ?').get(id);
  if (!week) return res.status(404).json({ error: 'Week not found' });
  if (week.status === 'finalized') {
    return res.status(400).json({ error: 'This week is already finalized' });
  }

  const tx = db.transaction(() => {
    db.prepare('DELETE FROM week_responses WHERE week_id = ? AND family = ?').run(id, req.session.family);
    db.prepare(
      'INSERT INTO week_responses (id, week_id, family, kind, note, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(nanoid(), id, req.session.family, kind, note || null, new Date().toISOString());
    recomputeWeekStatus(id);
  });
  tx();

  const updated = db.prepare('SELECT * FROM weeks WHERE id = ?').get(id);
  res.json(serializeWeek(updated, req.session));
});

app.delete('/api/weeks/:id/response', requireAuth, (req, res) => {
  const { id } = req.params;
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM week_responses WHERE week_id = ? AND family = ?').run(id, req.session.family);
    recomputeWeekStatus(id);
  });
  tx();

  const updated = db.prepare('SELECT * FROM weeks WHERE id = ?').get(id);
  res.json(serializeWeek(updated, req.session));
});

// ---------- Finalize (admin only) ----------

app.post('/api/weeks/:id/finalize', requireAuth, requireAdmin, (req, res) => {
  const { id } = req.params;
  const { family } = req.body || {}; // family string to assign, or null to reopen
  const week = db.prepare('SELECT * FROM weeks WHERE id = ?').get(id);
  if (!week) return res.status(404).json({ error: 'Week not found' });

  if (family === null || family === undefined || family === '') {
    db.prepare("UPDATE weeks SET status = 'open', finalized_family = NULL WHERE id = ?").run(id);
  } else {
    if (!FAMILIES.includes(family)) return res.status(400).json({ error: 'Invalid family' });
    db.prepare("UPDATE weeks SET status = 'finalized', finalized_family = ? WHERE id = ?").run(family, id);
  }

  const updated = db.prepare('SELECT * FROM weeks WHERE id = ?').get(id);
  res.json(serializeWeek(updated, req.session));
});

// ---------- Comments (back-and-forth negotiation, visible to everyone) ----------

app.post('/api/weeks/:id/comments', requireAuth, (req, res) => {
  const { id } = req.params;
  const { message } = req.body || {};
  if (!message || !message.trim()) return res.status(400).json({ error: 'Message required' });
  const week = db.prepare('SELECT * FROM weeks WHERE id = ?').get(id);
  if (!week) return res.status(404).json({ error: 'Week not found' });

  db.prepare('INSERT INTO comments (id, week_id, family, message, created_at) VALUES (?, ?, ?, ?, ?)').run(
    nanoid(),
    id,
    req.session.family,
    message.trim(),
    new Date().toISOString()
  );

  const updated = db.prepare('SELECT * FROM weeks WHERE id = ?').get(id);
  res.json(serializeWeek(updated, req.session));
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Beach house calendar running on http://localhost:${PORT}`);
});
