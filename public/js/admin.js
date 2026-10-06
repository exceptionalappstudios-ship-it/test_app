import { api, esc, formatDate, formatSlot, formatTimestamp, toast } from './common.js';

const $ = (id) => document.getElementById(id);
const TOKEN_KEY = 'adminToken';
let adminToken = (() => { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } })();
let currentStatus = 'pending';

const adminApi = (path, opts = {}) =>
  api(path, { ...opts, headers: { Authorization: `Bearer ${adminToken}` } }).catch((err) => {
    if (err.status === 401) showLogin();
    throw err;
  });

function showLogin() {
  adminToken = null;
  try { localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
  $('dashboard').classList.add('hidden');
  $('logout').classList.add('hidden');
  $('loginView').classList.remove('hidden');
}

function showDashboard() {
  $('loginView').classList.add('hidden');
  $('dashboard').classList.remove('hidden');
  $('logout').classList.remove('hidden');
  loadRequests();
}

// ---- Requests ----------------------------------------------------------

async function loadRequests() {
  const { appointments, counts } = await adminApi(`/api/admin/appointments?status=${currentStatus}`);
  document.querySelectorAll('#statusTabs button').forEach((b) => {
    const n = b.dataset.status ? counts[b.dataset.status] ?? 0 : null;
    b.textContent = b.textContent.replace(/ \(\d+\)$/, '') + (n ? ` (${n})` : '');
  });
  $('requests').innerHTML = appointments.length ? appointments.map((a) => `
    <div class="list-item" data-id="${a.id}">
      <div class="head">
        <span class="when">${esc(formatSlot(a.slot))}</span>
        <span class="status ${esc(a.status)}">${esc(a.status)}</span>
      </div>
      <dl class="detail">
        <dt>Name</dt><dd>${esc(a.name)}</dd>
        <dt>Phone</dt><dd><a href="tel:${esc(a.phone)}">${esc(a.phone)}</a></dd>
        <dt>Email</dt><dd><a href="mailto:${esc(a.email)}">${esc(a.email)}</a></dd>
        <dt>Purpose</dt><dd style="white-space:pre-wrap">${esc(a.purpose)}</dd>
        <dt>Requested</dt><dd>${esc(formatTimestamp(a.created_at))}</dd>
        ${a.admin_note ? `<dt>Note</dt><dd>${esc(a.admin_note)}</dd>` : ''}
      </dl>
      ${a.status === 'pending' ? `
        <label for="note-${a.id}">Note to visitor (optional)</label>
        <input id="note-${a.id}" maxlength="1000" placeholder="e.g. Please bring a photo ID">
        <div class="actions">
          <button class="btn ok small" data-action="approve">Approve</button>
          <button class="btn danger small" data-action="reject">Decline</button>
        </div>` : ''}
      ${a.status === 'approved' ? `
        <div class="actions"><button class="btn danger small" data-action="cancel">Cancel appointment</button></div>` : ''}
    </div>`).join('') : '<p class="empty">Nothing here.</p>';
}

$('requests').addEventListener('click', async (e) => {
  const action = e.target.dataset.action;
  if (!action) return;
  const item = e.target.closest('[data-id]');
  const id = item.dataset.id;
  if (action === 'cancel' && !confirm('Cancel this approved appointment? The visitor will be notified.')) return;
  e.target.disabled = true;
  try {
    const note = item.querySelector('input')?.value ?? '';
    await adminApi(`/api/admin/appointments/${id}/${action}`, { method: 'POST', body: { note } });
    toast({ approve: 'Approved — the visitor has been notified.', reject: 'Declined — the visitor has been notified.', cancel: 'Cancelled — the visitor has been notified.' }[action]);
    loadRequests();
  } catch (err) {
    toast(err.message);
    e.target.disabled = false;
  }
});

$('statusTabs').addEventListener('click', (e) => {
  if (!e.target.matches('button')) return;
  currentStatus = e.target.dataset.status;
  document.querySelectorAll('#statusTabs button').forEach((b) => b.classList.toggle('on', b === e.target));
  loadRequests();
});

// ---- Slots -------------------------------------------------------------

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
$('weekdays').innerHTML = DAYS.map((d, i) =>
  `<label><input type="checkbox" value="${i}" checked> ${d}</label>`).join('');

async function loadSlots() {
  const { slots } = await adminApi('/api/admin/slots');
  if (!slots.length) {
    $('slotList').innerHTML = '<p class="empty">No upcoming slots. Add some above.</p>';
    return;
  }
  const byDate = slots.reduce((m, s) => m.set(s.date, [...(m.get(s.date) ?? []), s]), new Map());
  $('slotList').innerHTML = [...byDate].map(([date, list]) => `
    <div class="day">
      <h3>${esc(formatDate(date))}</h3>
      <div class="slot-grid">
        ${list.map((s) => {
          const state = s.appointment_status ?? (s.is_blocked ? 'blocked' : 'free');
          const label = s.appointment_status ? `${s.appointment_status} · ${s.visitor_name}` : state;
          return `
          <div class="slot-cell" data-slot="${s.id}">
            <div><strong>${esc(s.start_time)}–${esc(s.end_time)}</strong> <span class="status ${esc(state)}">${esc(label)}</span></div>
            ${s.appointment_status ? '' : `<div class="btns">
              <button class="btn secondary small" data-slot-action="${s.is_blocked ? 'unblock' : 'block'}">${s.is_blocked ? 'Unblock' : 'Block'}</button>
              <button class="btn danger small" data-slot-action="delete">Delete</button>
            </div>`}
          </div>`;
        }).join('')}
      </div>
    </div>`).join('');
}

$('slotList').addEventListener('click', async (e) => {
  const action = e.target.dataset.slotAction;
  if (!action) return;
  const id = e.target.closest('[data-slot]').dataset.slot;
  try {
    if (action === 'delete') await adminApi(`/api/admin/slots/${id}`, { method: 'DELETE' });
    else await adminApi(`/api/admin/slots/${id}`, { method: 'PATCH', body: { blocked: action === 'block' } });
    loadSlots();
  } catch (err) {
    toast(err.message);
  }
});

$('slotForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('slotMsg');
  const data = Object.fromEntries(new FormData(e.target));
  const weekdays = [...document.querySelectorAll('#weekdays input:checked')].map((i) => Number(i.value));
  try {
    const { created, skipped } = await adminApi('/api/admin/slots', {
      method: 'POST',
      body: { ...data, duration: Number(data.duration), gap: Number(data.gap), weekdays },
    });
    msg.className = 'success';
    msg.textContent = `Created ${created} slot${created === 1 ? '' : 's'}${skipped ? ` (${skipped} already existed)` : ''}.`;
    loadSlots();
  } catch (err) {
    msg.className = 'error';
    msg.textContent = err.message;
  }
});

$('fromDate').addEventListener('change', () => {
  if (!$('toDate').value || $('toDate').value < $('fromDate').value) $('toDate').value = $('fromDate').value;
});

// ---- Shell -------------------------------------------------------------

$('mainTabs').addEventListener('click', (e) => {
  if (!e.target.matches('button')) return;
  const tab = e.target.dataset.tab;
  document.querySelectorAll('#mainTabs button').forEach((b) => b.classList.toggle('on', b === e.target));
  $('requestsTab').classList.toggle('hidden', tab !== 'requests');
  $('slotsTab').classList.toggle('hidden', tab !== 'slots');
  (tab === 'slots' ? loadSlots : loadRequests)().catch((err) => toast(err.message));
});

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    ({ token: adminToken } = await api('/api/admin/login', { method: 'POST', body: { password: $('password').value } }));
    try { localStorage.setItem(TOKEN_KEY, adminToken); } catch { /* ignore */ }
    $('loginError').classList.add('hidden');
    showDashboard();
  } catch (err) {
    $('loginError').textContent = err.message;
    $('loginError').classList.remove('hidden');
  }
});

$('logout').addEventListener('click', async (e) => {
  e.preventDefault();
  await adminApi('/api/admin/logout', { method: 'POST' }).catch(() => {});
  showLogin();
});

// Keep the request list fresh while the dashboard is open.
setInterval(() => {
  if (adminToken && !$('requestsTab').classList.contains('hidden') && !document.querySelector('#requests input:focus')) {
    loadRequests().catch(() => {});
  }
}, 30000);

const today = new Date().toISOString().slice(0, 10);
$('fromDate').value = today;
$('toDate').value = today;
adminToken ? showDashboard() : showLogin();
