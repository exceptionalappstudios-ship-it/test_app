// Shared helpers for the visitor, security and admin apps.
import { icons } from './icons.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export async function api(path, { method = 'GET', body, raw } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: raw ? { 'Content-Type': 'image/jpeg' } : body ? { 'Content-Type': 'application/json' } : {},
      body: raw ?? (body ? JSON.stringify(body) : undefined),
      credentials: 'same-origin',
    });
  } catch {
    throw Object.assign(new Error('No internet connection. Please check your network and try again.'), { status: 0 });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Something went wrong (${res.status})`), { status: res.status, data });
  return data;
}

// ---- Phone numbers ---------------------------------------------------------------
// Every phone box takes exactly 10 digits. Pasted numbers like "+91 98765 43210"
// or "098765 43210" are reduced to their 10 digits.
export function tenDigits(value) {
  let d = String(value ?? '').replace(/\D/g, '');
  if (d.length > 10 && d.startsWith('91')) d = d.slice(2);
  if (d.length > 10 && d.startsWith('0')) d = d.slice(1);
  return d.slice(0, 10);
}
export const isTenDigits = (value) => /^\d{10}$/.test(String(value ?? ''));
export function phoneField(id, value = '', placeholder = '9876543210') {
  return `<div class="phone-field"><span>+91</span><input id="${id}" type="tel" inputmode="numeric" autocomplete="off" maxlength="14" pattern="[0-9]{10}" placeholder="${placeholder}" value="${esc(tenDigits(value))}" data-phone></div>`;
}
document.addEventListener('input', (e) => {
  if (!e.target.matches?.('input[data-phone]')) return;
  const clean = tenDigits(e.target.value);
  if (e.target.value !== clean) e.target.value = clean;
});

// ---- Formatting --------------------------------------------------------------

const parseDate = (date) => { const [y, m, d] = date.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const fmt = (date, opts) => parseDate(date).toLocaleDateString('en-IN', { timeZone: 'UTC', ...opts });
export const formatDate = (date) => fmt(date, { weekday: 'long', day: 'numeric', month: 'long' });
export const formatShortDate = (date) => fmt(date, { weekday: 'short', day: 'numeric', month: 'short' });
export const dayParts = (date) => ({ dow: fmt(date, { weekday: 'short' }), day: fmt(date, { day: 'numeric' }), mon: fmt(date, { month: 'short' }) });
export const addDays = (date, n) => { const d = parseDate(date); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
export const formatPhone = (p) => (p?.startsWith('+91') && p.length === 13 ? `+91 ${p.slice(3, 8)} ${p.slice(8)}` : p ?? '');
export const sqlToDate = (sql) => new Date(sql.replace(' ', 'T') + 'Z');
export const formatTime = (sql) => sqlToDate(sql).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
export function formatWhen(sql) {
  const d = sqlToDate(sql);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}
export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
export const PERIOD_ICONS = { morning: icons.sun, afternoon: icons.sunHigh, evening: icons.moon };

const STATUS_WORDS = { pending: 'Waiting', hold: 'On hold', approved: 'Confirmed', rejected: 'Declined', cancelled: 'Cancelled', active: 'Active', revoked: 'Removed' };
export function statusChip(status, checkedIn) {
  if (checkedIn) return `<span class="status checked-in">${icons.check.replace('<svg', '<svg width="14" height="14"')} Checked in</span>`;
  return `<span class="status ${esc(status)}">${esc(STATUS_WORDS[status] ?? status)}</span>`;
}

export function photoTag(src, name, cls = '') {
  if (!src) return `<span class="photo ${cls}" aria-hidden="true">${esc((name ?? '?').trim()[0]?.toUpperCase() ?? '?')}</span>`;
  return `<img class="photo ${cls}" src="${esc(src)}" alt="" loading="lazy" decoding="async">`;
}

// One-tap call and WhatsApp buttons for a number.
export function contactButtons(phone) {
  const digits = String(phone ?? '').replace(/\D/g, '');
  return `<a class="icon-btn call" href="tel:+${digits}" aria-label="Call ${esc(phone)}">${icons.phone}</a>
    <a class="icon-btn wa" href="https://wa.me/${digits}" target="_blank" rel="noopener" aria-label="WhatsApp ${esc(phone)}">${icons.whatsapp}</a>`;
}

export function toast(message) {
  $$('.toast').forEach((t) => t.remove());
  const el = document.createElement('div');
  el.className = 'toast';
  el.setAttribute('role', 'status');
  el.textContent = message;
  document.body.append(el);
  setTimeout(() => el.remove(), 4500);
}

// Bottom sheet; returns { el, close }. The phone's Back button closes it.
const openSheets = [];
window.addEventListener('popstate', () => openSheets.at(-1)?.close(true));
export function closeAllSheets() { while (openSheets.length) openSheets.at(-1).close(true); }

export function openSheet(html, { onClose } = {}) {
  const backdrop = document.createElement('div');
  backdrop.className = 'backdrop';
  const sheet = document.createElement('div');
  sheet.className = 'sheet';
  sheet.setAttribute('role', 'dialog');
  sheet.innerHTML = `<div class="grab"></div>${html}`;
  document.body.append(backdrop, sheet);
  history.pushState({ sheet: true }, '');
  let closed = false;
  const entry = {
    close(fromBack = false) {
      if (closed) return;
      closed = true;
      openSheets.splice(openSheets.indexOf(entry), 1);
      backdrop.remove();
      sheet.remove();
      if (!fromBack && history.state?.sheet) history.back();
      onClose?.();
    },
  };
  openSheets.push(entry);
  const close = () => entry.close();
  backdrop.addEventListener('click', close);
  sheet.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) close(); });
  return { el: sheet, close };
}

// Asks "are you sure?" inside the page (works everywhere, unlike confirm()).
export function confirmSheet({ title, message, confirm = 'Yes', danger = false }) {
  return new Promise((resolve) => {
    let answer = false;
    const { el, close } = openSheet(`
      <h2 style="margin:0 0 6px">${esc(title)}</h2>
      ${message ? `<p class="sub">${esc(message)}</p>` : ''}
      <div class="actions"><button class="btn light" data-close>No, go back</button><button class="btn ${danger ? 'red' : ''}" data-yes>${esc(confirm)}</button></div>`,
    { onClose: () => resolve(answer) });
    $('[data-yes]', el).addEventListener('click', () => { answer = true; close(); });
  });
}

// Runs an action from a button: disables it meanwhile and shows errors.
// Disables the button while `fn` runs. Errors pop up as a toast, unless the
// screen shows them itself (`quiet`).
export async function busy(button, fn, { quiet = false } = {}) {
  if (button) button.disabled = true;
  try { return await fn(); } catch (err) { if (!quiet) toast(err.message); throw err; } finally { if (button?.isConnected) button.disabled = false; }
}

// Calls fn at most once per `ms`, always running the last call.
export function throttle(fn, ms) {
  let timer = null;
  let pending = false;
  return () => {
    if (timer) { pending = true; return; }
    fn();
    timer = setTimeout(function tick() { timer = null; if (pending) { pending = false; fn(); timer = setTimeout(tick, ms); } }, ms);
  };
}

// ---- Hash router ------------------------------------------------------------------

// Each view gets a context: `el` to render into, `isCurrent()` to drop stale
// async results, and `onCleanup(fn)` for timers, streams and cameras.
// Routes with `back` (a hash, or a function returning one) show a back arrow.
const visited = [];
// Swaps the current screen without adding a history entry. Built from the
// page's own address so it also works inside embedded documents.
export function replaceHash(hash) {
  location.replace(location.href.split('#')[0] + hash);
}
export function goBack(fallback) {
  if (visited.length > 1) history.back();
  else replaceHash(fallback);
}

export function createRouter({ outlet, routes, fallback, guard, onChange }) {
  let current = null;
  let enterTimer = null;
  const backBtn = document.getElementById('back');
  backBtn?.addEventListener('click', () => current?.back && goBack(current.back));
  async function run() {
    current?.cleanups.forEach((fn) => fn());
    closeAllSheets();
    const hash = location.hash || fallback;
    if (visited.at(-2) === hash) visited.pop(); else if (visited.at(-1) !== hash) visited.push(hash);
    const ctx = { el: outlet, cleanups: [], isCurrent: () => current === ctx, onCleanup: (fn) => ctx.cleanups.push(fn) };
    current = ctx;
    for (const route of routes) {
      const match = hash.match(route.path);
      if (!match) continue;
      const redirect = guard?.(route, hash);
      if (redirect && redirect !== hash) { visited.pop(); replaceHash(redirect); return; }
      ctx.back = typeof route.back === 'function' ? route.back(...match.slice(1)) : route.back;
      backBtn?.classList.toggle('hidden', !ctx.back);
      onChange?.(route, hash);
      window.scrollTo(0, 0);
      outlet.innerHTML = '<div class="card"><div class="spinner"></div></div>';
      // A new screen slides in gently once; later live refreshes don't animate.
      outlet.classList.remove('enter');
      void outlet.offsetWidth;
      outlet.classList.add('enter');
      clearTimeout(enterTimer);
      enterTimer = setTimeout(() => outlet.classList.remove('enter'), 900);
      try {
        await route.view(ctx, ...match.slice(1));
      } catch (err) {
        if (ctx.isCurrent()) {
          outlet.innerHTML = `<div class="card"><div class="notice bad">${icons.alert}<span>${esc(err.message)}</span></div><div class="actions"><button class="btn light" data-retry>Try again</button></div></div>`;
          outlet.querySelector('[data-retry]').addEventListener('click', () => location.reload());
        }
      }
      return;
    }
    location.hash = fallback;
  }
  window.addEventListener('hashchange', run);
  // Tapping the link for the screen you're on reloads it (e.g. to refresh).
  document.addEventListener('click', (e) => {
    const a = e.target.closest?.('a[href^="#"]');
    if (a && a.getAttribute('href') === location.hash && !e.defaultPrevented) { e.preventDefault(); run(); }
  });
  return { run };
}

// EventSource that reconnects and reports its connection state.
export function liveStream(url, handlers, onState) {
  let source;
  let closed = false;
  let retry;
  function connect() {
    source = new EventSource(url);
    source.onopen = () => onState?.(true);
    source.onerror = () => {
      onState?.(false);
      source.close();
      if (!closed) retry = setTimeout(connect, 5000);
    };
    for (const [event, fn] of Object.entries(handlers)) source.addEventListener(event, (e) => fn(JSON.parse(e.data)));
  }
  connect();
  return () => { closed = true; clearTimeout(retry); source.close(); };
}

// Sends people to the app for their role.
export function homeFor(user) {
  if (!user) return null;
  if (user.role === 'admin') return '/admin.html';
  if (user.role === 'security') return '/security.html';
  return '/';
}

// Shown when someone opens the admin or security app with a number that has no access.
// Without this they were silently sent to the visitor app and couldn't tell why.
export function wrongAccount(el, user, pageName) {
  const roleName = { admin: 'an admin', security: 'security staff', visitor: 'a visitor' }[user.role] || user.role;
  el.innerHTML = `
    <div class="card narrow center">
      <h2>This page is for ${esc(pageName)}</h2>
      <p class="sub">You are logged in as <b>${esc(formatPhone(user.phone))}</b>, which is registered as ${esc(roleName)}.</p>
      <div class="actions" style="flex-direction:column">
        <button class="btn block" type="button" data-switch>${icons.logout} Log out and use another number</button>
        <a class="btn ghost block" href="${homeFor(user)}">Go to my page</a>
      </div>
    </div>`;
  el.querySelector('[data-switch]').addEventListener('click', async () => {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
    location.replace(location.pathname);
  });
}

// ---- Push notifications -------------------------------------------------------------

export async function registerServiceWorker() {
  if (window.__DEMO__ || !('serviceWorker' in navigator)) return null;
  try { return await navigator.serviceWorker.register('/sw.js'); } catch { return null; }
}
const b64 = (s) => Uint8Array.from(atob((s + '='.repeat((4 - (s.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
export const pushSupported = () => !window.__DEMO__ && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
export async function enablePush(vapidPublicKey) {
  if (!pushSupported()) throw new Error('This phone does not support app notifications. You will still get every update on WhatsApp.');
  if (await Notification.requestPermission() !== 'granted') throw new Error('Notifications were not allowed. You will still get every update on WhatsApp.');
  const reg = await registerServiceWorker();
  await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription()) ?? await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(vapidPublicKey) });
  await api('/api/me/push-subscriptions', { method: 'POST', body: sub.toJSON() });
}
