// Series ("period") archiving.
//
// A series is archived when EITHER
//   - its last week has ended (computed from dates; nothing is stored or scheduled), or
//   - the admin archived it early by hand (periods.archived_at is set).
// Archiving only hides a series from the everyday view. Nothing is deleted, so past
// weeks, requests and assignments stay available for reporting/export.

const db = require('./db');

// "Today" in the house's time zone, as YYYY-MM-DD.
function todayCT() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
}

// A week is "past" once its last day (Wednesday) is before today.
function isWeekPast(week, today = todayCT()) {
  return week.end_date < today;
}

function archiveState(period, today = todayCT()) {
  const last = db.prepare('SELECT MAX(end_date) AS e FROM weeks WHERE period_id = ?').get(period.id).e;
  const ended = !!last && last < today;
  if (ended) return { archived: true, reason: 'ended', restorable: false };
  if (period.archived_at) return { archived: true, reason: 'manual', restorable: true };
  return { archived: false, reason: null, restorable: false };
}

function isPeriodArchived(periodId) {
  const p = db.prepare('SELECT * FROM periods WHERE id = ?').get(periodId);
  return !!p && archiveState(p).archived;
}

function archivedPeriodIds() {
  const today = todayCT();
  const out = new Set();
  for (const p of db.prepare('SELECT * FROM periods').all()) {
    if (archiveState(p, today).archived) out.add(p.id);
  }
  return out;
}

module.exports = { todayCT, isWeekPast, archiveState, isPeriodArchived, archivedPeriodIds };
