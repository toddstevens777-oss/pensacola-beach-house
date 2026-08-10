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
