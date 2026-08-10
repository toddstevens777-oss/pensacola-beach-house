const FAMILIES = ['Stevens', 'Furr', 'Wagner'];

let me = null; // { family, isAdmin }
let periodsCache = [];
let openWeekId = null;

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

// ---------- Custom date picker (bigger + more legible than the native one) ----------

function toISOLocal(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function attachDatePicker(input) {
  let viewDate = new Date();
  viewDate.setDate(1);
  let selectedISO = null;

  const popup = document.createElement('div');
  popup.className = 'date-picker-popup';
  document.body.appendChild(popup);

  function fmtDisplay(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  }

  function render() {
    const year = viewDate.getFullYear();
    const month = viewDate.getMonth();
    const first = new Date(year, month, 1);
    const startDay = first.getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const daysInPrevMonth = new Date(year, month, 0).getDate();
    const monthLabel = first.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    const todayISO = toISOLocal(new Date());

    let cells = '';
    for (let i = startDay - 1; i >= 0; i--) {
      cells += `<button type="button" class="dp-day dp-muted" disabled>${daysInPrevMonth - i}</button>`;
    }
    for (let d = 1; d <= daysInMonth; d++) {
      const iso = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      let cls = 'dp-day';
      if (iso === todayISO) cls += ' dp-today';
      if (iso === selectedISO) cls += ' dp-selected';
      cells += `<button type="button" class="${cls}" data-iso="${iso}">${d}</button>`;
    }

    popup.innerHTML = `
      <div class="dp-header">
        <button type="button" class="dp-nav-btn" data-nav="-1">&lsaquo;</button>
        <span class="dp-label">${monthLabel}</span>
        <button type="button" class="dp-nav-btn" data-nav="1">&rsaquo;</button>
      </div>
      <div class="dp-weekdays"><span>S</span><span>M</span><span>T</span><span>W</span><span>T</span><span>F</span><span>S</span></div>
      <div class="dp-days">${cells}</div>
      <div class="dp-footer"><button type="button" class="dp-today-btn">Today</button></div>
    `;

    popup.querySelectorAll('[data-nav]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        viewDate.setMonth(viewDate.getMonth() + parseInt(btn.dataset.nav, 10));
        render();
      });
    });
    popup.querySelectorAll('.dp-day[data-iso]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        selectedISO = btn.dataset.iso;
        input.value = fmtDisplay(selectedISO);
        input.dataset.iso = selectedISO;
        input.dispatchEvent(new Event('change'));
        close();
      });
    });
    popup.querySelector('.dp-today-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      const t = new Date();
      viewDate = new Date(t.getFullYear(), t.getMonth(), 1);
      render();
    });
  }

  function open() {
    $$('.date-picker-popup.open').forEach((p) => { if (p !== popup) p.classList.remove('open'); });
    const rect = input.getBoundingClientRect();
    popup.style.top = `${window.scrollY + rect.bottom + 6}px`;
    popup.style.left = `${window.scrollX + rect.left}px`;
    render();
    popup.classList.add('open');
    requestAnimationFrame(() => {
      const pr = popup.getBoundingClientRect();
      if (pr.right > window.innerWidth - 8) {
        popup.style.left = `${Math.max(8, window.scrollX + rect.right - pr.width)}px`;
      }
    });
  }
  function close() { popup.classList.remove('open'); }

  input.addEventListener('click', (e) => { e.stopPropagation(); open(); });
  document.addEventListener('click', (e) => {
    if (!popup.contains(e.target) && e.target !== input) close();
  });

  return {
    close,
    clear() { selectedISO = null; input.value = ''; delete input.dataset.iso; },
    setISO(iso) {
      if (!iso) return;
      selectedISO = iso;
      const [y, m] = iso.split('-').map(Number);
      viewDate = new Date(y, m - 1, 1);
      input.value = fmtDisplay(iso);
      input.dataset.iso = iso;
    },
  };
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  });
  let data = null;
  try { data = await res.json(); } catch (e) { /* no body */ }
  if (!res.ok) {
    throw new Error((data && data.error) || `Request failed (${res.status})`);
  }
  return data;
}

function fmtWhen(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' +
    d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

// ---------- Boot ----------

async function boot() {
  try {
    me = await api('/api/me');
    showApp();
  } catch (e) {
    showLogin();
  }
}

function showLogin() {
  $('#login-screen').style.display = 'flex';
  $('#app-screen').style.display = 'none';
}

async function showApp() {
  $('#login-screen').style.display = 'none';
  $('#app-screen').style.display = 'block';
  $('#who-badge').textContent = me.family + (me.isAdmin ? ' (admin)' : '');
  $('#who-badge').className = 'family-badge ' + me.family;
  $$('.admin-only').forEach((el) => { el.style.display = me.isAdmin ? '' : 'none'; });
  await loadPeriods();
}

// ---------- Login / logout ----------

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#login-error').textContent = '';
  const family = $('#login-family').value;
  const password = $('#login-password').value;
  try {
    me = await api('/api/login', { method: 'POST', body: { family, password } });
    $('#login-password').value = '';
    showApp();
  } catch (err) {
    $('#login-error').textContent = err.message;
  }
});

$('#logout-btn').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' });
  me = null;
  showLogin();
});

// ---------- Change password ----------

$('#change-password-btn').addEventListener('click', () => {
  $('#password-form').reset();
  $('#password-error').textContent = '';
  $('#password-success').textContent = '';
  $('#password-modal').style.display = 'flex';
});
$('#password-modal-close').addEventListener('click', () => { $('#password-modal').style.display = 'none'; });
$('#password-cancel').addEventListener('click', () => { $('#password-modal').style.display = 'none'; });

$('#password-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#password-error').textContent = '';
  $('#password-success').textContent = '';
  const currentPassword = $('#current-password').value;
  const newPassword = $('#new-password').value;
  try {
    await api('/api/change-password', { method: 'POST', body: { currentPassword, newPassword } });
    $('#password-success').textContent = 'Password updated.';
    $('#password-form').reset();
    setTimeout(() => { $('#password-modal').style.display = 'none'; }, 1200);
  } catch (err) {
    $('#password-error').textContent = err.message;
  }
});

// ---------- Tabs ----------

$$('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    $$('.tab-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    const tab = btn.dataset.tab;
    $('#tab-calendar').style.display = tab === 'calendar' ? 'block' : 'none';
    $('#tab-documents').style.display = tab === 'documents' ? 'block' : 'none';
  });
});

// ---------- Periods ----------

async function loadPeriods() {
  periodsCache = await api('/api/periods');
  renderPeriods();
}

function renderPeriods() {
  const container = $('#periods-container');
  container.innerHTML = '';
  $('#empty-state').style.display = periodsCache.length === 0 ? 'block' : 'none';

  // newest period first
  const sorted = [...periodsCache].sort((a, b) => (a.start_date < b.start_date ? 1 : -1));

  for (const period of sorted) {
    const block = document.createElement('div');
    block.className = 'period-block';

    const header = document.createElement('div');
    header.className = 'period-header';
    header.innerHTML = `
      <div>
        <h3>${escapeHtml(period.label)}</h3>
        <div class="period-range">${period.start_date} – ${period.end_date}</div>
      </div>
    `;
    if (me.isAdmin) {
      const del = document.createElement('button');
      del.className = 'period-delete';
      del.textContent = 'Delete period';
      del.addEventListener('click', async () => {
        if (!confirm(`Delete "${period.label}" and all its weeks? This can't be undone.`)) return;
        await api(`/api/periods/${period.id}`, { method: 'DELETE' });
        await loadPeriods();
      });
      header.appendChild(del);
    }
    block.appendChild(header);

    const grid = document.createElement('div');
    grid.className = 'week-grid';
    for (const week of period.weeks) {
      grid.appendChild(renderWeekCard(week));
    }
    block.appendChild(grid);

    container.appendChild(block);
  }
}

function renderWeekCard(week) {
  const card = document.createElement('div');
  card.className = `week-card status-${week.status}` + (week.finalized_family ? ` family-${week.finalized_family}` : '');
  card.addEventListener('click', () => openWeekModal(week.id));

  let statusHtml = '';
  if (week.status === 'open') {
    statusHtml = `<div class="week-status">Open</div>`;
  } else if (week.status === 'requested') {
    statusHtml = `<div class="week-status">Requested</div>`;
  } else {
    statusHtml = `<div class="week-status finalized ${week.finalized_family}">${week.finalized_family}</div>`;
  }

  let pillsHtml = '';
  if (week.status === 'requested' && week.requests.length) {
    pillsHtml = `<div class="week-req-pills">` +
      week.requests.map((r) => `<span class="pill ${r.family}">${r.family}</span>`).join('') +
      `</div>`;
  }

  card.innerHTML = `
    <div class="week-range">${week.range_label}</div>
    ${statusHtml}
    ${pillsHtml}
  `;
  return card;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ---------- New period modal ----------

const periodStartPicker = attachDatePicker($('#period-start'));
const periodEndPicker = attachDatePicker($('#period-end'));

$('#new-period-btn').addEventListener('click', () => {
  $('#period-error').textContent = '';
  $('#period-form').reset();
  periodStartPicker.clear();
  periodEndPicker.clear();
  periodStartPicker.close();
  periodEndPicker.close();
  $('#period-modal').style.display = 'flex';
});
$('#period-cancel').addEventListener('click', () => {
  $('#period-modal').style.display = 'none';
  periodStartPicker.close();
  periodEndPicker.close();
});

$('#period-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#period-error').textContent = '';
  const label = $('#period-label').value.trim();
  const start_date = $('#period-start').dataset.iso;
  const end_date = $('#period-end').dataset.iso;
  if (!start_date || !end_date) {
    $('#period-error').textContent = 'Please pick both a start and end date.';
    return;
  }
  try {
    await api('/api/periods', { method: 'POST', body: { label, start_date, end_date } });
    $('#period-modal').style.display = 'none';
    periodStartPicker.close();
    periodEndPicker.close();
    await loadPeriods();
  } catch (err) {
    $('#period-error').textContent = err.message;
  }
});

// ---------- Week modal ----------

function findWeek(weekId) {
  for (const period of periodsCache) {
    const w = period.weeks.find((w) => w.id === weekId);
    if (w) return w;
  }
  return null;
}

async function openWeekModal(weekId) {
  openWeekId = weekId;
  renderWeekModal();
  $('#week-modal').style.display = 'flex';
}

$('#week-close').addEventListener('click', () => { $('#week-modal').style.display = 'none'; openWeekId = null; });

function renderWeekModal() {
  const week = findWeek(openWeekId);
  if (!week) return;

  $('#week-title').textContent = week.range_label;

  const statusRow = $('#week-status-row');
  if (week.status === 'finalized') {
    statusRow.innerHTML = `<span class="family-badge ${week.finalized_family}">Finalized — ${week.finalized_family}</span>`;
  } else if (week.status === 'requested') {
    statusRow.innerHTML = `<span style="color:var(--requested); font-weight:700;">Requested — awaiting Brett to finalize</span>`;
  } else {
    statusRow.innerHTML = `<span style="color:var(--muted); font-weight:700;">Open — no one has requested this week yet</span>`;
  }

  // Requests list
  const reqDiv = $('#week-requests');
  if (week.requests.length === 0) {
    reqDiv.innerHTML = `<p class="empty-state" style="padding:8px 0;">No requests yet.</p>`;
  } else {
    reqDiv.innerHTML = week.requests.map((r) => `
      <div class="request-row">
        <span><span class="pill ${r.family}">${r.family}</span> ${r.note ? escapeHtml(r.note) : ''}</span>
        <span class="comment-meta">${fmtWhen(r.created_at)}</span>
      </div>
    `).join('');
  }

  // Request/withdraw action for logged-in family
  const actionsDiv = $('#week-request-actions');
  actionsDiv.innerHTML = '';
  const myRequest = week.requests.find((r) => r.family === me.family);
  if (week.status !== 'finalized') {
    if (myRequest) {
      const btn = document.createElement('button');
      btn.className = 'secondary-btn';
      btn.textContent = `Withdraw ${me.family}'s request`;
      btn.addEventListener('click', async () => {
        const updated = await api(`/api/weeks/${week.id}/request`, { method: 'DELETE' });
        updateWeekEverywhere(updated);
      });
      actionsDiv.appendChild(btn);
    } else {
      const btn = document.createElement('button');
      btn.className = 'primary-btn';
      btn.textContent = `Request this week for ${me.family}`;
      btn.addEventListener('click', async () => {
        const note = prompt('Optional note for the other families (dates flexibility, etc.)') || '';
        try {
          const updated = await api(`/api/weeks/${week.id}/request`, { method: 'POST', body: { note } });
          updateWeekEverywhere(updated);
        } catch (err) {
          alert(err.message);
        }
      });
      actionsDiv.appendChild(btn);
    }
  }

  // Admin finalize controls
  const finalizeSection = $('#week-finalize-actions').closest('.week-section') || $('#week-finalize-actions').parentElement;
  finalizeSection.style.display = me.isAdmin ? '' : 'none';
  const finDiv = $('#week-finalize-actions');
  finDiv.innerHTML = '';
  if (me.isAdmin) {
    for (const fam of FAMILIES) {
      const btn = document.createElement('button');
      btn.className = `finalize-btn ${fam}`;
      btn.textContent = week.status === 'finalized' && week.finalized_family === fam ? `✓ ${fam}` : `Assign to ${fam}`;
      btn.addEventListener('click', async () => {
        const updated = await api(`/api/weeks/${week.id}/finalize`, { method: 'POST', body: { family: fam } });
        updateWeekEverywhere(updated);
      });
      finDiv.appendChild(btn);
    }
    if (week.status !== 'open') {
      const reopen = document.createElement('button');
      reopen.className = 'finalize-btn reopen';
      reopen.textContent = 'Reopen week';
      reopen.addEventListener('click', async () => {
        const updated = await api(`/api/weeks/${week.id}/finalize`, { method: 'POST', body: { family: null } });
        updateWeekEverywhere(updated);
      });
      finDiv.appendChild(reopen);
    }
  }

  // Comments
  const commentsDiv = $('#week-comments');
  if (week.comments.length === 0) {
    commentsDiv.innerHTML = `<p class="empty-state" style="padding:8px 0;">No notes yet.</p>`;
  } else {
    commentsDiv.innerHTML = week.comments.map((c) => `
      <div class="comment-row">
        <div class="comment-meta">${c.family} · ${fmtWhen(c.created_at)}</div>
        <div>${escapeHtml(c.message)}</div>
      </div>
    `).join('');
  }
}

$('#comment-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#comment-input');
  const message = input.value.trim();
  if (!message || !openWeekId) return;
  const updated = await api(`/api/weeks/${openWeekId}/comments`, { method: 'POST', body: { message } });
  input.value = '';
  updateWeekEverywhere(updated);
});

function updateWeekEverywhere(updatedWeek) {
  for (const period of periodsCache) {
    const idx = period.weeks.findIndex((w) => w.id === updatedWeek.id);
    if (idx !== -1) period.weeks[idx] = updatedWeek;
  }
  renderPeriods();
  if (openWeekId === updatedWeek.id) renderWeekModal();
}

boot();
