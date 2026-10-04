const FAMILIES = ['Stevens', 'Furr', 'Wagner'];
let adminKey = null;

const $ = (sel) => document.querySelector(sel);

async function api(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    credentials: 'same-origin',
  });
  let data = null;
  try { data = await res.json(); } catch (e) { /* no body */ }
  if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
  return data;
}

function fmtWhen(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) + ' at ' +
    d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

$('#key-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#key-error').textContent = '';
  const candidate = $('#admin-key').value;
  try {
    const statuses = await api('/api/admin/status', { adminKey: candidate });
    adminKey = candidate; // only kept in memory for this page load
    $('#key-screen').style.display = 'none';
    $('#admin-screen').style.display = 'block';
    renderFamilies(statuses);
    loadNotifyStatus();
  } catch (err) {
    $('#key-error').textContent = err.message;
  }
});

function renderFamilies(statuses) {
  const container = $('#family-rows');
  container.innerHTML = '';
  for (const status of statuses) {
    const row = document.createElement('div');
    row.className = 'family-row';

    const info = document.createElement('div');
    info.className = 'family-row-info';
    const statusText = status.hasPassword
      ? `Password set ${fmtWhen(status.updatedAt)} (${status.updatedBy === 'self' ? 'by the family' : 'by admin'})`
      : 'No password set yet';
    info.innerHTML = `
      <span class="family-badge ${status.family}">${status.family}</span>
      <span class="family-row-status">${statusText}</span>
    `;

    const form = document.createElement('form');
    form.className = 'family-row-form';
    form.innerHTML = `
      <input type="password" placeholder="New password" minlength="6" required autocomplete="new-password" />
      <button type="submit" class="secondary-btn">${status.hasPassword ? 'Reset' : 'Set'} password</button>
      <span class="family-row-msg"></span>
    `;
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = form.querySelector('input');
      const msg = form.querySelector('.family-row-msg');
      msg.textContent = '';
      msg.style.color = '';
      try {
        await api('/api/admin/reset-password', { adminKey, family: status.family, newPassword: input.value });
        msg.textContent = '✓ Updated';
        msg.style.color = 'var(--furr)';
        input.value = '';
        const fresh = await api('/api/admin/status', { adminKey });
        renderFamilies(fresh);
      } catch (err) {
        msg.textContent = err.message;
        msg.style.color = '#dc2626';
      }
    });

    row.appendChild(info);
    row.appendChild(form);
    container.appendChild(row);
  }
}


// ---------- Email notifications ----------

async function loadNotifyStatus() {
  const el = $('#notify-status');
  try {
    const st = await api('/api/admin/notify/status', { adminKey });
    const r = st.recipients;
    const modeText = st.mode === 'send' ? 'ON — sending real emails'
      : st.mode === 'log' ? 'LOG ONLY (nothing is sent)'
      : 'OFF — email is not configured yet';
    el.textContent = `Status: ${modeText}. Recipients — Brett: ${r.admin}, Stevens: ${r.Stevens}, Wagner: ${r.Wagner}. ` +
      `Alerts fire at ${st.thresholdPct}% assigned (periods of ${st.minWeeks}+ weeks), batched every ${st.batchMinutes} min. ` +
      `Waiting to send: ${st.pendingAdminAlerts} admin alert(s), ${st.pendingOutcomeEmails} outcome email(s).`;
  } catch (err) {
    el.textContent = err.message;
  }
}

$('#notify-test-btn').addEventListener('click', async () => {
  const msg = $('#notify-test-msg');
  msg.textContent = 'Sending…';
  msg.style.color = '';
  try {
    const res = await api('/api/admin/notify/test', { adminKey, group: $('#notify-test-group').value });
    msg.textContent = `✓ Sent to ${res.sentTo.join(', ')}`;
    msg.style.color = 'var(--furr)';
  } catch (err) {
    msg.textContent = err.message;
    msg.style.color = '#dc2626';
  }
});

$('#notify-preview-btn').addEventListener('click', async () => {
  const msg = $('#notify-preview-msg');
  const box = $('#notify-preview');
  msg.textContent = '';
  box.innerHTML = '';
  try {
    const { periods } = await api('/api/admin/notify/catchup-preview', { adminKey });
    if (!periods.length) {
      box.textContent = 'Nothing to catch up: no pending requests in a period that is past the threshold.';
      return;
    }
    let total = 0;
    for (const p of periods) {
      const h = document.createElement('p');
      h.style.fontWeight = '600';
      h.textContent = `${p.period} — ${p.assigned} of ${p.total} weeks assigned (${p.percent}%)`;
      box.appendChild(h);
      const ul = document.createElement('ul');
      for (const r of p.requests) {
        total += 1;
        const li = document.createElement('li');
        li.textContent = `${r.family} family: ${r.week} (requested ${r.requested})` +
          (r.alreadyAlerted ? ' — Brett was already alerted' : '');
        ul.appendChild(li);
      }
      box.appendChild(ul);
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'secondary-btn';
    btn.textContent = `Send catch-up alert for ${total} request(s)`;
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        const res = await api('/api/admin/notify/catchup', { adminKey });
        const problems = (res.errors || []).concat(res.warnings || []);
        msg.textContent = problems.length ? `Done with issues: ${problems.join('; ')}` : `✓ Sent (${res.adminSent} request(s) to Brett)`;
        msg.style.color = problems.length ? '#dc2626' : 'var(--furr)';
        box.innerHTML = '';
        loadNotifyStatus();
      } catch (err) {
        msg.textContent = err.message;
        msg.style.color = '#dc2626';
        btn.disabled = false;
      }
    });
    box.appendChild(btn);
  } catch (err) {
    msg.textContent = err.message;
    msg.style.color = '#dc2626';
  }
});
