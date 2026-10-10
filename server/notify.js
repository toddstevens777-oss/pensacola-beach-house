// Email notifications for the beach house calendar.
//
// Rules:
//  - Admin alert (to the scheduling admin only): a Stevens/Wagner request for an open
//    week comes in while >= ALERT_THRESHOLD_PCT of the period's weeks are finalized
//    (and the period has >= ALERT_MIN_WEEKS weeks), OR the admin's own finalizing pushes
//    a period over the threshold while such requests are still pending.
//  - Outcome email: when the week of an alerted request is finalized, the requesting
//    family is told how it ended (assigned to them, or to another family).
//  - Furr's own requests never alert. Reopening a week sends nothing.
//  - Everything is batched: the first event opens a BATCH_MINUTES window; when it closes,
//    one email goes out per recipient group, built from the database state at that moment
//    (so a quick correction inside the window never produces a wrong email).
//  - Private notes are never included in any email.
//  - New-series announcement: when the admin creates a period, everyone (Stevens, Wagner and
//    Furr addresses) gets one email asking them to mark each week Requested / Can't make it in
//    the app. Same batching window; deleting the period inside the window cancels it. Sent only
//    when ANNOUNCE_NEW_SERIES is on. Family-facing emails say "please don't reply" and set
//    Reply-To to the admin so a stray reply reaches the scheduler.
//
// Modes (NOTIFY_MODE): off | log | send. If unset: "send" when GMAIL_USER,
// GMAIL_APP_PASSWORD and ADMIN_ALERT_EMAILS are all set, otherwise "off" (a complete
// no-op, so deploying this code changes nothing until email is configured).

const nodemailer = require('nodemailer');
const { nanoid } = require('nanoid');
const db = require('./db');
const { formatRange } = require('./weeks');
const { SCHEDULING_ADMIN_FAMILY } = require('./auth');
const { archivedPeriodIds, isPeriodArchived, todayCT } = require('./archive');

// ---------- Config ----------

function num(name, dflt) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return dflt;
  const v = Number(raw);
  return Number.isFinite(v) ? v : dflt;
}

function cfg() {
  return {
    thresholdPct: num('ALERT_THRESHOLD_PCT', 50),
    minWeeks: num('ALERT_MIN_WEEKS', 8),
    batchMinutes: num('BATCH_MINUTES', 15),
    appUrl: process.env.APP_URL || 'https://pensacola-beach-house.onrender.com',
    gmailUser: (process.env.GMAIL_USER || '').trim(),
    gmailPass: (process.env.GMAIL_APP_PASSWORD || '').replace(/\s+/g, ''), // Google shows it with spaces
  };
}

const GROUP_ENV = { admin: 'ADMIN_ALERT_EMAILS', Stevens: 'STEVENS_EMAILS', Wagner: 'WAGNER_EMAILS', Furr: 'FURR_EMAILS' };

function emails(envName) {
  return (process.env[envName] || '')
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.includes('@'));
}

function announceOn() {
  return ['on', 'true', '1', 'yes'].includes((process.env.ANNOUNCE_NEW_SERIES || '').trim().toLowerCase());
}

// Replies to family-facing emails should reach the scheduling admin, not whoever owns the Gmail account.
function familyReplyTo() {
  return (process.env.REPLY_TO_FAMILIES || '').trim() || emails(GROUP_ENV.admin)[0] || cfg().gmailUser;
}

// Everyone who should hear about a new series: Stevens + Wagner + Furr (falls back to the admin
// address until FURR_EMAILS is set), de-duplicated.
function announcementRecipients() {
  const furr = emails(GROUP_ENV.Furr);
  const all = [...emails(GROUP_ENV.Stevens), ...emails(GROUP_ENV.Wagner), ...(furr.length ? furr : emails(GROUP_ENV.admin))];
  const seen = new Set();
  return all.filter((a) => {
    const k = a.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function mode() {
  const m = (process.env.NOTIFY_MODE || '').toLowerCase();
  if (['off', 'log', 'send'].includes(m)) return m;
  const c = cfg();
  return c.gmailUser && c.gmailPass && emails(GROUP_ENV.admin).length ? 'send' : 'off';
}

// ---------- Delivery ----------

let transporter = null;
function getTransporter() {
  if (!transporter) {
    const c = cfg();
    transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: { user: c.gmailUser, pass: c.gmailPass },
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 20000,
    });
  }
  return transporter;
}

const outbox = []; // log mode only: lets tests inspect what would have been sent

async function deliver(to, { subject, text, html }, opts = {}) {
  const m = mode();
  const c = cfg();
  const replyTo = opts.replyTo || process.env.REPLY_TO || c.gmailUser;
  if (m === 'log') {
    outbox.push({ to, subject, text, html, replyTo });
    if (outbox.length > 200) outbox.shift();
    console.log(`[notify:log] To: ${to.join(', ')}\nSubject: ${subject}\nReply-To: ${replyTo}\n\n${text}\n`);
    return;
  }
  if (m !== 'send') throw new Error('Email notifications are off');
  await getTransporter().sendMail({
    from: `"Beach House Calendar" <${c.gmailUser}>`,
    to: to.join(', '),
    replyTo,
    subject,
    text,
    html,
  });
}

// ---------- Small helpers ----------

const nowISO = () => new Date().toISOString();

function esc(s) {
  return String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}

function ago(iso) {
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86400000);
  if (!(days > 0)) return 'today';
  return days === 1 ? '1 day ago' : `${days} days ago`;
}

function plural(n, one, many) {
  return n === 1 ? one : many;
}

function periodStats(periodId) {
  const row = db
    .prepare(
      "SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'finalized' THEN 1 ELSE 0 END) AS finalized FROM weeks WHERE period_id = ?"
    )
    .get(periodId);
  const total = row.total || 0;
  const finalized = row.finalized || 0;
  const pct = total ? (finalized / total) * 100 : 0;
  const c = cfg();
  return { total, finalized, pct, qualifies: total >= c.minWeeks && pct >= c.thresholdPct };
}

// ---------- Alert bookkeeping ----------

function insertAlert(weekId, family, reason) {
  return db
    .prepare('INSERT OR IGNORE INTO request_alerts (id, week_id, family, reason, triggered_at) VALUES (?, ?, ?, ?, ?)')
    .run(nanoid(), weekId, family, reason, nowISO()).changes;
}

// Alert every live request from a non-admin family on a not-yet-finalized week of
// this period, if the period currently qualifies. Idempotent.
function sweepPeriod(periodId, reason) {
  if (isPeriodArchived(periodId)) return 0; // finished/archived series never alert
  if (!periodStats(periodId).qualifies) return 0;
  const rows = db
    .prepare(
      `SELECT wr.week_id, wr.family
         FROM week_responses wr JOIN weeks w ON w.id = wr.week_id
        WHERE w.period_id = ? AND w.status != 'finalized' AND wr.kind = 'requested' AND wr.family != ?
          AND w.end_date >= ?`
    )
    .all(periodId, SCHEDULING_ADMIN_FAMILY, todayCT());
  let n = 0;
  for (const r of rows) n += insertAlert(r.week_id, r.family, reason);
  return n;
}

const SELECT_PENDING = `
  SELECT a.id AS alert_id, a.family, a.reason,
         w.id AS week_id, w.start_date, w.end_date, w.sort_index, w.finalized_family,
         p.id AS period_id, p.label AS period_label, p.start_date AS period_start,
         wr.created_at AS requested_at
    FROM request_alerts a
    JOIN weeks w ON w.id = a.week_id
    JOIN periods p ON p.id = w.period_id
    JOIN week_responses wr ON wr.week_id = a.week_id AND wr.family = a.family AND wr.kind = 'requested'`;

// Alerts the admin has not been told about, for weeks still open, with the request still standing.
function adminPending() {
  const archived = archivedPeriodIds();
  return db
    .prepare(`${SELECT_PENDING} WHERE a.admin_notified_at IS NULL AND w.status != 'finalized'
              ORDER BY p.start_date, w.sort_index, a.family`)
    .all()
    .filter((r) => !archived.has(r.period_id) && r.end_date >= todayCT());
}

// Alerted requests whose week is now finalized and whose family has not yet been told.
function outcomePending() {
  const archived = archivedPeriodIds();
  return db
    .prepare(`${SELECT_PENDING} WHERE a.outcome_notified_at IS NULL AND w.status = 'finalized'
              ORDER BY a.family, w.start_date`)
    .all()
    .filter((r) => !archived.has(r.period_id) && r.end_date >= todayCT());
}

// New series that were announced-on at creation, not yet emailed, and still exist.
function pendingAnnouncements() {
  return db
    .prepare(
      `SELECT a.period_id, a.note, p.label, p.start_date, p.end_date,
              (SELECT COUNT(*) FROM weeks w WHERE w.period_id = p.id) AS week_count
         FROM period_announcements a JOIN periods p ON p.id = a.period_id
        WHERE a.sent_at IS NULL
        ORDER BY p.created_at ASC`
    )
    .all();
}

function markIds(column, ids) {
  if (!ids.length) return;
  const marks = ids.map(() => '?').join(',');
  db.prepare(`UPDATE request_alerts SET ${column} = ? WHERE id IN (${marks})`).run(nowISO(), ...ids);
}

// ---------- Email content ----------

const FOOTER_FAMILY = "This is an automated message. Please don't reply to it.";
const FOOTER_ADMIN = 'Automated message from the Pensacola Beach House calendar. No need to reply. Private family notes are never included.';

function wrapHtml(bodyHtml, footer = FOOTER_FAMILY) {
  const c = cfg();
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:560px;color:#1f2937;line-height:1.5">
${bodyHtml}
<p><a href="${esc(c.appUrl)}">Open the calendar</a></p>
<p style="color:#6b7280;font-size:12px;margin-top:24px">${esc(footer)}</p>
</div>`;
}

function buildAdminEmail(rows) {
  const c = cfg();
  const byPeriod = new Map();
  for (const r of rows) {
    if (!byPeriod.has(r.period_id)) {
      byPeriod.set(r.period_id, { label: r.period_label, stats: periodStats(r.period_id), items: [] });
    }
    byPeriod.get(r.period_id).items.push(r);
  }
  const n = rows.length;
  const allCatchUp = rows.every((r) => r.reason === 'catch_up');
  const someCatchUp = rows.some((r) => r.reason === 'catch_up');
  const subject = `Beach House: ${n} late ${plural(n, 'request', 'requests')} waiting`;

  let intro = `${n} ${plural(n, 'request came', 'requests came')} in after most weeks were already assigned.`;
  if (allCatchUp) intro = `Email alerts were just switched on. ${n} ${plural(n, 'request was', 'requests were')} already waiting on weeks that are still open.`;
  else if (someCatchUp) intro += ' Some of these were already waiting when email alerts were switched on.';

  let text = `${intro}\n`;
  let html = `<p>${esc(intro)}</p>`;
  for (const g of byPeriod.values()) {
    const head = `${g.label} — ${g.stats.finalized} of ${g.stats.total} weeks assigned (${Math.round(g.stats.pct)}%)`;
    text += `\n${head}\n`;
    html += `<p style="margin-bottom:4px"><strong>${esc(head)}</strong></p><ul style="margin-top:0">`;
    for (const r of g.items) {
      const line = `${r.family} family: ${formatRange(r.start_date, r.end_date)} (requested ${ago(r.requested_at)})`;
      text += `  - ${line}\n`;
      html += `<li>${esc(line)}</li>`;
    }
    html += '</ul>';
  }
  text += `\nReview and assign: ${c.appUrl}\n\n(Automated message from the Beach House calendar. No need to reply. Private family notes are not included.)\n`;
  return { subject, text, html: wrapHtml(html, FOOTER_ADMIN) };
}

function buildOutcomeEmail(family, rows) {
  const c = cfg();
  const n = rows.length;
  const subject = `Beach House: update on your week ${plural(n, 'request', 'requests')}`;
  const intro = `Here ${plural(n, 'is the result', 'are the results')} for your family's week ${plural(n, 'request', 'requests')}:`;
  let text = `${intro}\n\n`;
  let html = `<p>${esc(intro)}</p><ul>`;
  for (const r of rows) {
    const result = r.finalized_family === family ? 'assigned to your family' : `assigned to the ${r.finalized_family} family`;
    const line = `${formatRange(r.start_date, r.end_date)}: ${result}`;
    text += `  - ${line}\n`;
    html += `<li>${esc(line)}</li>`;
  }
  html += '</ul>';
  text += `\nCalendar: ${c.appUrl}\n\n${FOOTER_FAMILY}\n`;
  return { subject, text, html: wrapHtml(html) };
}

function buildAnnouncementEmail(rows, { sample = false } = {}) {
  const c = cfg();
  const n = rows.length;
  const subject = (sample ? '[SAMPLE] ' : '') +
    (n === 1 ? `Beach House: new dates open for requests (${rows[0].label})` : `Beach House: ${n} new series open for requests`);
  const intro = `Brett has published ${n === 1 ? 'a new series' : `${n} new series`} of dates on the Pensacola Beach House calendar.`;
  const ask = `Please log in to the calendar and, for each week in ${plural(n, 'this series', 'these series')}, mark it Requested if you'd like it, or Can't make it if you can't. Marking the weeks you can't make is just as helpful as requesting the ones you want, because it helps Brett plan the assignments. Your choices count only when they're made in the calendar.`;
  const sampleNote = 'THIS IS A SAMPLE of the email families will receive when Brett publishes a new series. No action needed.';

  let text = sample ? `${sampleNote}\n\n` : '';
  let html = sample ? `<p style="background:#fef3c7;padding:8px 12px;border-radius:6px"><strong>${esc(sampleNote)}</strong></p>` : '';
  text += `${intro}\n\n`;
  html += `<p>${esc(intro)}</p>`;
  for (const r of rows) {
    const line = `${r.label}: ${formatRange(r.start_date, r.end_date)} (${r.week_count} ${plural(r.week_count, 'week', 'weeks')})`;
    text += `${line}\n`;
    html += `<p style="margin-bottom:4px"><strong>${esc(line)}</strong></p>`;
    if (r.note) {
      text += `Note from Brett: ${r.note}\n`;
      html += `<p style="margin-top:0">Note from Brett: ${esc(r.note)}</p>`;
    }
    text += '\n';
  }
  text += `${ask}\n\nOpen the calendar: ${c.appUrl}\n\n${FOOTER_FAMILY}\n`;
  html += `<p>${esc(ask)}</p>`;
  return { subject, text, html: wrapHtml(html) };
}

// ---------- Batching & flushing ----------

let flushTimer = null;
let flushing = false;
let failures = 0;

function scheduleFlush(delayMs) {
  if (flushTimer) return; // a window is already open; it will pick this up
  const delay = delayMs != null ? delayMs : cfg().batchMinutes * 60 * 1000;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flush().catch((e) => console.error('[notify] flush failed:', e));
  }, delay);
  if (flushTimer.unref) flushTimer.unref();
}

async function flush() {
  if (mode() === 'off') return { skipped: true };
  if (flushing) return { busy: true };
  flushing = true;
  const result = { adminSent: 0, outcomesSent: 0, announced: 0, errors: [], warnings: [] };
  try {
    const adm = adminPending();
    if (adm.length) {
      const to = emails(GROUP_ENV.admin);
      if (!to.length) {
        result.warnings.push('ADMIN_ALERT_EMAILS is empty; admin alert not sent');
      } else {
        try {
          await deliver(to, buildAdminEmail(adm));
          markIds('admin_notified_at', adm.map((r) => r.alert_id));
          result.adminSent = adm.length;
        } catch (e) {
          result.errors.push(`admin alert: ${e.message}`);
        }
      }
    }

    const byFamily = new Map();
    for (const r of outcomePending()) {
      if (!byFamily.has(r.family)) byFamily.set(r.family, []);
      byFamily.get(r.family).push(r);
    }
    for (const [family, rows] of byFamily) {
      const to = emails(GROUP_ENV[family] || '');
      if (!to.length) {
        result.warnings.push(`no recipients configured for ${family}; outcome email not sent`);
        continue;
      }
      try {
        await deliver(to, buildOutcomeEmail(family, rows), { replyTo: familyReplyTo() });
        markIds('outcome_notified_at', rows.map((r) => r.alert_id));
        result.outcomesSent += rows.length;
      } catch (e) {
        result.errors.push(`outcome for ${family}: ${e.message}`);
      }
    }

    const anns = announceOn() ? pendingAnnouncements() : [];
    if (anns.length) {
      const to = announcementRecipients();
      if (!to.length) {
        result.warnings.push('no recipients configured for the new-series announcement');
      } else {
        try {
          await deliver(to, buildAnnouncementEmail(anns), { replyTo: familyReplyTo() });
          const marks = anns.map(() => '?').join(',');
          db.prepare(`UPDATE period_announcements SET sent_at = ? WHERE period_id IN (${marks})`).run(nowISO(), ...anns.map((a) => a.period_id));
          result.announced = anns.length;
        } catch (e) {
          result.errors.push(`announcement: ${e.message}`);
        }
      }
    }
  } finally {
    flushing = false;
  }

  if (result.errors.length) {
    failures += 1;
    console.error('[notify] send errors:', result.errors.join('; '));
    if (failures < 4) scheduleFlush(30 * 60 * 1000); // retry in 30 min, a few times
  } else {
    failures = 0;
  }
  if (result.warnings.length) console.warn('[notify]', result.warnings.join('; '));
  return result;
}

function hasPending() {
  return adminPending().length > 0 || outcomePending().length > 0 || (announceOn() && pendingAnnouncements().length > 0);
}

// ---------- Hooks called from the routes ----------

// The admin just created a new period (series of weeks).
function onPeriodCreated(periodId, note) {
  if (mode() === 'off' || !announceOn()) return;
  const clean = typeof note === 'string' ? note.trim().slice(0, 500) : '';
  db.prepare('INSERT OR IGNORE INTO period_announcements (period_id, note, created_at) VALUES (?, ?, ?)').run(
    periodId,
    clean || null,
    nowISO()
  );
  scheduleFlush();
}

// A family just submitted a "requested" response for a week.
function onRequest(weekId, family) {
  if (mode() === 'off' || family === SCHEDULING_ADMIN_FAMILY) return;
  const week = db.prepare('SELECT * FROM weeks WHERE id = ?').get(weekId);
  if (!week || week.status === 'finalized') return;
  if (isPeriodArchived(week.period_id)) return;
  if (!periodStats(week.period_id).qualifies) return;
  insertAlert(weekId, family, 'late_request');
  scheduleFlush();
}

// The admin just finalized, re-assigned or reopened a week. `prev` is the week's
// state before the change: { status, finalized_family }.
function onFinalizeChange(weekId, prev) {
  if (mode() === 'off') return;
  const week = db.prepare('SELECT * FROM weeks WHERE id = ?').get(weekId);
  if (!week) return;
  if (week.status === 'finalized') {
    sweepPeriod(week.period_id, 'threshold_crossed');
    // Re-assigned to a different family without reopening: tell the requesters again.
    if (prev && prev.status === 'finalized' && prev.finalized_family !== week.finalized_family) {
      db.prepare('UPDATE request_alerts SET outcome_notified_at = NULL WHERE week_id = ?').run(weekId);
    }
  } else {
    // Reopened: a later re-finalize should notify again.
    db.prepare('UPDATE request_alerts SET outcome_notified_at = NULL WHERE week_id = ?').run(weekId);
  }
  if (hasPending()) scheduleFlush();
}

function start() {
  const m = mode();
  if (m === 'off') {
    console.log('[notify] email notifications are off (not configured)');
    return;
  }
  console.log(`[notify] email notifications on (mode=${m})`);
  if (hasPending()) scheduleFlush(60 * 1000);
}

// ---------- Admin tools ----------

function status() {
  const c = cfg();
  return {
    mode: mode(),
    gmailConfigured: !!(c.gmailUser && c.gmailPass),
    recipients: {
      admin: emails(GROUP_ENV.admin).length,
      Stevens: emails(GROUP_ENV.Stevens).length,
      Wagner: emails(GROUP_ENV.Wagner).length,
      Furr: emails(GROUP_ENV.Furr).length,
    },
    announceNewSeries: announceOn(),
    announcementRecipients: announcementRecipients().length,
    pendingAnnouncements: announceOn() ? pendingAnnouncements().length : 0,
    thresholdPct: c.thresholdPct,
    minWeeks: c.minWeeks,
    batchMinutes: c.batchMinutes,
    pendingAdminAlerts: adminPending().length,
    pendingOutcomeEmails: outcomePending().length,
  };
}

async function sendTest(group) {
  const key = ['admin', 'Stevens', 'Wagner', 'Furr'].includes(group) ? group : 'admin';
  const to = emails(GROUP_ENV[key]);
  if (!to.length) throw new Error(`No recipients configured for "${key}"`);
  if (mode() === 'off') {
    throw new Error('Sending is not configured yet (needs GMAIL_USER, GMAIL_APP_PASSWORD and ADMIN_ALERT_EMAILS)');
  }
  const text = 'This is a test of the Pensacola Beach House calendar email notifications. If you can read this, delivery works. No action needed.\n';
  await deliver(to, {
    subject: 'Beach House: test email',
    text,
    html: wrapHtml(`<p>${esc(text)}</p>`),
  }, key === 'admin' ? {} : { replyTo: familyReplyTo() });
  return { ok: true, mode: mode(), group: key, sentTo: to };
}

// Sends a clearly-labelled SAMPLE of the new-series announcement to the Stevens addresses only,
// so the wording can be reviewed before anything goes to families.
async function sendSampleAnnouncement() {
  const to = emails(GROUP_ENV.Stevens);
  if (!to.length) throw new Error('No Stevens recipients configured (STEVENS_EMAILS)');
  if (mode() === 'off') {
    throw new Error('Sending is not configured yet (needs GMAIL_USER, GMAIL_APP_PASSWORD and ADMIN_ALERT_EMAILS)');
  }
  const sample = [{
    label: 'Winter 2027',
    start_date: '2027-01-07',
    end_date: '2027-04-07',
    week_count: 13,
    note: 'Please get your requests in by Friday.',
  }];
  await deliver(to, buildAnnouncementEmail(sample, { sample: true }), { replyTo: familyReplyTo() });
  return { ok: true, mode: mode(), sentTo: to };
}

// What a catch-up would include: pending non-admin requests on open weeks in
// periods that currently qualify.
function catchupPreview() {
  const archived = archivedPeriodIds();
  const periods = db.prepare('SELECT * FROM periods ORDER BY start_date ASC').all().filter((p) => !archived.has(p.id));
  const out = [];
  for (const p of periods) {
    const stats = periodStats(p.id);
    if (!stats.qualifies) continue;
    const reqs = db
      .prepare(
        `SELECT wr.family, wr.created_at, w.start_date, w.end_date, a.admin_notified_at
           FROM week_responses wr
           JOIN weeks w ON w.id = wr.week_id
           LEFT JOIN request_alerts a ON a.week_id = wr.week_id AND a.family = wr.family
          WHERE w.period_id = ? AND w.status != 'finalized' AND wr.kind = 'requested' AND wr.family != ?
            AND w.end_date >= ?
          ORDER BY w.sort_index, wr.family`
      )
      .all(p.id, SCHEDULING_ADMIN_FAMILY, todayCT());
    if (!reqs.length) continue;
    out.push({
      period: p.label,
      assigned: stats.finalized,
      total: stats.total,
      percent: Math.round(stats.pct),
      requests: reqs.map((r) => ({
        family: r.family,
        week: formatRange(r.start_date, r.end_date),
        requested: ago(r.created_at),
        alreadyAlerted: !!r.admin_notified_at,
      })),
    });
  }
  return out;
}

async function runCatchup() {
  if (mode() === 'off') throw new Error('Notifications are not configured yet');
  const periods = db.prepare('SELECT id FROM periods').all();
  let newlyMarked = 0;
  for (const p of periods) newlyMarked += sweepPeriod(p.id, 'catch_up');
  const result = await flush();
  return { newlyMarked, ...result };
}

module.exports = {
  onRequest,
  onFinalizeChange,
  onPeriodCreated,
  sendSampleAnnouncement,
  start,
  flush,
  status,
  sendTest,
  catchupPreview,
  runCatchup,
  // exposed for local testing
  _outbox: outbox,
  _periodStats: periodStats,
  _adminPending: adminPending,
  _outcomePending: outcomePending,
  _pendingAnnouncements: pendingAnnouncements,
  _buildAnnouncementEmail: buildAnnouncementEmail,
};
