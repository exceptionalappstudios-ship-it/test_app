import { api, esc, formatSlot, formatTimestamp, getVisitorToken, visitorHeaders, enablePush, pushSupported, toast, refreshNavBadge } from './common.js';

const $ = (id) => document.getElementById(id);
const token = getVisitorToken();

function renderAppointments(appointments) {
  if (!appointments.length) {
    $('appointments').innerHTML = '<p class="empty">No appointments yet. <a href="/">Book one</a>.</p>';
    return;
  }
  $('appointments').innerHTML = appointments.map((a) => `
    <div class="list-item">
      <div class="head">
        <span class="when">${esc(formatSlot(a.slot))}</span>
        <span class="status ${esc(a.status)}">${esc(a.status)}</span>
      </div>
      <p class="muted">${esc(a.purpose)}</p>
      ${a.admin_note ? `<p><strong>Note from the ashram:</strong> ${esc(a.admin_note)}</p>` : ''}
      ${['pending', 'approved'].includes(a.status)
        ? `<div class="actions"><button class="btn danger small" data-cancel="${a.id}">Cancel appointment</button></div>` : ''}
    </div>`).join('');
}

function renderNotifications(notifications, unread) {
  $('unreadCount').innerHTML = unread ? `<span class="badge-count">${unread} new</span>` : '';
  $('markRead').classList.toggle('hidden', !unread);
  $('notifications').innerHTML = notifications.length
    ? notifications.map((n) => `
      <div class="list-item notification ${n.read_at ? '' : 'unread'}">
        <div class="head"><strong>${esc(n.title)}</strong><span class="time">${esc(formatTimestamp(n.created_at))}</span></div>
        <p>${esc(n.body)}</p>
      </div>`).join('')
    : '<p class="empty">No updates yet.</p>';
}

async function load() {
  try {
    const { appointments, notifications, unread } = await api('/api/me', { headers: visitorHeaders() });
    renderAppointments(appointments);
    renderNotifications(notifications, unread);
    refreshNavBadge();
  } catch (err) {
    if (err.status === 401) {
      $('content').classList.add('hidden');
      $('noVisitor').classList.remove('hidden');
    } else {
      toast(err.message);
    }
  }
}

function updatePushCard() {
  if (!pushSupported()) {
    $('pushStatus').textContent = "This browser doesn't support push notifications. Keep this page open, or check back here for updates.";
    $('enablePush').classList.add('hidden');
  } else if (Notification.permission === 'granted') {
    $('pushStatus').textContent = 'Notifications are on for this device.';
    $('enablePush').classList.add('hidden');
    enablePush().catch(() => {}); // make sure the subscription is registered
  }
}

// Live updates while the page is open.
function connectStream() {
  const source = new EventSource(`/api/me/stream?token=${encodeURIComponent(token)}`);
  source.addEventListener('notification', (e) => {
    const n = JSON.parse(e.data);
    toast(`${n.title}: ${n.body}`);
    load();
  });
}

$('appointments').addEventListener('click', async (e) => {
  const id = e.target.dataset.cancel;
  if (!id || !confirm('Cancel this appointment?')) return;
  try {
    await api(`/api/me/appointments/${id}/cancel`, { method: 'POST', headers: visitorHeaders() });
    load();
  } catch (err) {
    toast(err.message);
  }
});

$('markRead').addEventListener('click', async () => {
  await api('/api/me/notifications/read', { method: 'POST', headers: visitorHeaders() });
  load();
});

$('enablePush').addEventListener('click', async () => {
  const msg = $('pushMsg');
  try {
    await enablePush();
    msg.className = 'success';
    msg.textContent = 'Notifications are on.';
    updatePushCard();
  } catch (err) {
    msg.className = 'error';
    msg.textContent = err.message;
  }
});

if (!token) {
  $('noVisitor').classList.remove('hidden');
} else {
  $('content').classList.remove('hidden');
  updatePushCard();
  load();
  connectStream();
}
