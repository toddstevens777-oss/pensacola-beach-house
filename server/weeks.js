// Utilities for generating Thursday->Wednesday stay weeks.
// All dates are handled as YYYY-MM-DD strings and manipulated in UTC
// to avoid timezone/DST drift.

function parseISO(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function toISO(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(date, n) {
  const d = new Date(date.getTime());
  d.setUTCDate(d.getUTCDate() + n);
  return d;
}

// JS getUTCDay(): Sun=0, Mon=1, Tue=2, Wed=3, Thu=4, Fri=5, Sat=6
function nextOrSameThursday(date) {
  const day = date.getUTCDay();
  const diff = (4 - day + 7) % 7; // days until Thursday
  return addDays(date, diff);
}

/**
 * Generate consecutive Thu->Wed weeks covering [startDate, endDate].
 * The first week begins on the first Thursday on/after startDate.
 * Weeks are generated until a week's start date would fall after endDate.
 */
function generateWeeks(startDateStr, endDateStr) {
  const rangeStart = parseISO(startDateStr);
  const rangeEnd = parseISO(endDateStr);

  let cursor = nextOrSameThursday(rangeStart);
  const weeks = [];
  let idx = 0;

  while (cursor.getTime() <= rangeEnd.getTime()) {
    const weekStart = cursor;
    const weekEnd = addDays(weekStart, 6); // Wed = Thu + 6 days
    weeks.push({
      start_date: toISO(weekStart),
      end_date: toISO(weekEnd),
      sort_index: idx,
    });
    idx += 1;
    cursor = addDays(cursor, 7);
  }

  return weeks;
}

function formatRange(startDateStr, endDateStr) {
  const s = parseISO(startDateStr);
  const e = parseISO(endDateStr);
  const opts = { month: 'short', day: 'numeric' };
  const sStr = s.toLocaleDateString('en-US', { ...opts, timeZone: 'UTC' });
  const eStr = e.toLocaleDateString('en-US', { ...opts, timeZone: 'UTC', year: 'numeric' });
  return `${sStr} – ${eStr}`;
}

module.exports = { generateWeeks, parseISO, toISO, addDays, formatRange };
