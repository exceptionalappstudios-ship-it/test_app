// Shared helpers for the visitor app and the admin app.
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// ---- Formatting ------------------------------------------------------------

const parseDate = (date) => { const [y, m, d] = date.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const fmt = (date, opts) => parseDate(date).toLocaleDateString(undefined, { timeZone: 'UTC', ...opts });

export const formatDate = (date) => fmt(date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
export const formatShortDate = (date) => fmt(date, { weekday: 'short', day: 'numeric', month: 'short' });
export const dayParts = (date) => ({ dow: fmt(date, { weekday: 'short' }), day: fmt(date, { day: 'numeric' }), month: fmt(date, { month: 'short' }) });
export const formatSlot = (slot) => `${formatShortDate(slot.date)} · ${slot.start_time}–${slot.end_time}`;

// SQLite datetime('now') is UTC without a zone marker.
export const sqlToDate = (sql) => new Date(sql.replace(' ', 'T') + 'Z');
export function formatTimestamp(sql) {
  return sqlToDate(sql).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}
export const formatClock = (sql) => sqlToDate(sql).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

export function statusChip(status, checkedIn) {
  if (checkedIn) return '<span class="status checked-in">Checked in</span>';
  return `<span class="status ${esc(status)}">${esc(status)}</span>`;
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

export function setBusy(button, busy) {
  button.disabled = busy;
}

// ---- Hash router -------------------------------------------------------------

// Each view gets a context: `el` to render into, `isCurrent()` to drop stale
// async results, and `onCleanup(fn)` for intervals, streams and cameras.
export function createRouter({ outlet, routes, fallback, guard, onChange }) {
  let current = null;
  async function run() {
    current?.cleanups.forEach((fn) => fn());
    const hash = location.hash || fallback;
    const ctx = { el: outlet, cleanups: [], isCurrent: () => current === ctx, onCleanup: (fn) => ctx.cleanups.push(fn) };
    current = ctx;
    for (const route of routes) {
      const match = hash.match(route.path);
      if (!match) continue;
      const redirect = guard?.(route, hash);
      if (redirect && redirect !== hash) { location.hash = redirect; return; }
      onChange?.(route, hash);
      window.scrollTo(0, 0);
      outlet.innerHTML = '<div class="spinner"></div>';
      try {
        await route.view(ctx, ...match.slice(1));
      } catch (err) {
        if (ctx.isCurrent()) outlet.innerHTML = `<div class="error">${esc(err.message)}</div>`;
      }
      return;
    }
    location.hash = fallback;
  }
  window.addEventListener('hashchange', run);
  return { run };
}

// ---- Auth screens (shared by both apps) ---------------------------------------

export function authView(mode, { title, subtitle, allowSignup = true, onSuccess }) {
  return async (ctx, token) => {
    const forms = {
      login: `
        <form data-form="login" novalidate>
          <label for="email">Email</label>
          <input id="email" name="email" type="email" autocomplete="email" required>
          <label for="password">Password</label>
          <input id="password" name="password" type="password" autocomplete="current-password" required>
          <div class="error hidden" data-error></div>
          <div class="actions"><button class="btn block" type="submit">Log in</button></div>
          <p class="small" style="text-align:center"><a href="#/forgot">Forgot password?</a></p>
          ${allowSignup ? '<p class="small muted" style="text-align:center">New here? <a href="#/signup">Create an account</a></p>' : ''}
        </form>`,
      signup: `
        <form data-form="signup" novalidate>
          <label for="name">Full name</label>
          <input id="name" name="name" autocomplete="name" required maxlength="100">
          <label for="phone">Mobile number (WhatsApp)</label>
          <input id="phone" name="phone" type="tel" autocomplete="tel" required maxlength="25" placeholder="+91 98765 43210">
          <div class="hint">We'll send confirmations and reminders here on WhatsApp.</div>
          <label for="email">Email</label>
          <input id="email" name="email" type="email" autocomplete="email" required maxlength="200">
          <label for="password">Password</label>
          <input id="password" name="password" type="password" autocomplete="new-password" required minlength="8">
          <div class="hint">At least 8 characters.</div>
          <div class="error hidden" data-error></div>
          <div class="actions"><button class="btn block" type="submit">Create account</button></div>
          <p class="small muted" style="text-align:center">Already have an account? <a href="#/login">Log in</a></p>
        </form>`,
      forgot: `
        <form data-form="forgot" novalidate>
          <p class="muted">Enter your email and we'll send you a link to set a new password.</p>
          <label for="email">Email</label>
          <input id="email" name="email" type="email" autocomplete="email" required>
          <div class="error hidden" data-error></div>
          <div class="actions"><button class="btn block" type="submit">Send reset link</button></div>
          <p class="small" style="text-align:center"><a href="#/login">Back to log in</a></p>
        </form>`,
      reset: `
        <form data-form="reset" novalidate>
          <label for="password">New password</label>
          <input id="password" name="password" type="password" autocomplete="new-password" required minlength="8">
          <div class="error hidden" data-error></div>
          <div class="actions"><button class="btn block" type="submit">Set new password</button></div>
        </form>`,
    };
    const heading = { login: title, signup: 'Create your account', forgot: 'Reset password', reset: 'Choose a new password' }[mode];
    ctx.el.innerHTML = `
      <div class="narrow">
        <div class="auth-hero"><img src="/icon.svg" alt=""><h1>${esc(heading)}</h1>
          ${mode === 'login' && subtitle ? `<p class="lead">${esc(subtitle)}</p>` : ''}
          ${mode === 'signup' ? '<p class="lead">You need an account to book and receive your entry pass.</p>' : ''}
        </div>
        <div class="card">${forms[mode]}</div>
      </div>`;
    const form = $('form', ctx.el);
    const error = $('[data-error]', form);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      error.classList.add('hidden');
      if (!form.checkValidity()) { form.reportValidity(); return; }
      const button = $('button[type=submit]', form);
      setBusy(button, true);
      const data = Object.fromEntries(new FormData(form));
      try {
        if (mode === 'forgot') {
          await api('/api/auth/forgot', { method: 'POST', body: data });
          form.innerHTML = '<div class="success">If an account exists for that email, a reset link is on its way. Please check your inbox.</div><p style="text-align:center"><a href="#/login">Back to log in</a></p>';
          return;
        }
        const path = { login: '/api/auth/login', signup: '/api/auth/signup', reset: '/api/auth/reset' }[mode];
        const { user } = await api(path, { method: 'POST', body: mode === 'reset' ? { ...data, token } : data });
        await onSuccess(user);
      } catch (err) {
        error.textContent = err.message;
        error.classList.remove('hidden');
        setBusy(button, false);
      }
    });
  };
}

// ---- Push notifications --------------------------------------------------------

export async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return null;
  try { return await navigator.serviceWorker.register('/sw.js'); } catch { return null; }
}

function urlBase64ToUint8Array(base64) {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

export const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

export async function enablePush(vapidPublicKey) {
  if (!pushSupported()) {
    throw new Error('This browser does not support push notifications. On iPhone, add this app to your Home Screen first. You will still get WhatsApp and email updates.');
  }
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Notifications were not allowed. You can enable them in your browser settings.');
  const reg = await registerServiceWorker();
  await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription())
    ?? await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(vapidPublicKey) });
  await api('/api/me/push-subscriptions', { method: 'POST', body: sub.toJSON() });
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
