// Shared helpers for all pages.
export const VISITOR_KEY = 'visitorToken';

export function getVisitorToken() {
  try { return localStorage.getItem(VISITOR_KEY); } catch { return null; }
}
export function setVisitorToken(token) {
  try { localStorage.setItem(VISITOR_KEY, token); } catch { /* storage unavailable */ }
}

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export async function api(path, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(path, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export const visitorHeaders = () => {
  const token = getVisitorToken();
  return token ? { 'X-Visitor-Token': token } : {};
};

export function formatDate(date) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
  });
}

export function formatSlot(slot) {
  return `${formatDate(slot.date)} · ${slot.start_time}–${slot.end_time}`;
}

// SQLite datetime('now') is UTC without a zone marker.
export function formatTimestamp(sqlDate) {
  return new Date(sqlDate.replace(' ', 'T') + 'Z').toLocaleString(undefined, {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

export function toast(message) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = message;
  document.body.append(el);
  setTimeout(() => el.remove(), 4000);
}

export async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return null;
  try { return await navigator.serviceWorker.register('/sw.js'); } catch { return null; }
}

function urlBase64ToUint8Array(base64) {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

export const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

// Asks for notification permission and registers this device for push.
export async function enablePush() {
  if (!pushSupported()) throw new Error('This browser does not support push notifications. You will still see updates in the app.');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Notifications were not allowed. You can enable them in your browser settings.');
  const reg = await registerServiceWorker();
  await navigator.serviceWorker.ready;
  const { vapidPublicKey } = await api('/api/config');
  const sub = (await reg.pushManager.getSubscription())
    ?? await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(vapidPublicKey) });
  await api('/api/me/push-subscriptions', { method: 'POST', body: sub.toJSON(), headers: visitorHeaders() });
}

// Shows the unread count next to the "My appointments" nav link.
export async function refreshNavBadge() {
  const link = document.querySelector('[data-nav="my"]');
  if (!link || !getVisitorToken()) return;
  try {
    const { unread } = await api('/api/me', { headers: visitorHeaders() });
    link.querySelector('.badge-count')?.remove();
    if (unread) link.insertAdjacentHTML('beforeend', `<span class="badge-count">${unread}</span>`);
  } catch { /* ignore */ }
}

registerServiceWorker();
