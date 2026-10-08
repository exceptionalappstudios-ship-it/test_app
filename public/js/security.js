import { $, api, esc, formatTime, formatPhone, plural, photoTag, openSheet, toast, createRouter, liveStream, homeFor, throttle } from './common.js';
import { icons } from './icons.js';
import { renderLogin, renderProfileSetup } from './login.js';
import { startScanner } from './scanner.js';

const outlet = $('#app');
let user = null;
let stopStream = null;

function header(title, subtitle = '') {
  $('#title').textContent = title;
  $('#subtitle').textContent = subtitle;
}

function setUser(u) {
  user = u;
  const ready = Boolean(u?.profileComplete);
  $('#me').classList.toggle('hidden', !ready);
  $('#me').innerHTML = u?.photo ? `<img src="${esc(u.photo)}" alt="">` : icons.user;
  stopStream?.();
  stopStream = null;
  if (ready) {
    // Approval or removal by an admin takes effect immediately.
    stopStream = liveStream('/api/me/stream', { status: () => location.reload(), notification: (n) => toast(n.title) });
  }
}

$('#me').addEventListener('click', () => {
  const { el, close } = openSheet(`<div class="center">${photoTag(user.photo, user.name, 'lg')}<h2 style="margin-top:8px">${esc(user.name)}</h2><p class="sub">${esc(formatPhone(user.phone))}</p></div>
    <button class="btn danger block" data-logout>${icons.logout} Log out</button><button class="btn ghost block" data-close>Close</button>`);
  $('[data-logout]', el).addEventListener('click', async () => {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
    close();
    setUser(null);
    location.hash = '#/login';
  });
});

function loginView(ctx) {
  header('Security staff', 'Log in or register to scan visitor passes.');
  renderLogin(ctx.el, {
    signupAs: 'security',
    onDone: (u) => {
      if (u.role === 'visitor') { location.href = '/'; return; }
      setUser(u);
      location.hash = u.profileComplete ? '#/scan' : '#/setup';
    },
    footer: '<p class="center small muted" style="margin-top:18px">Visiting Gurudev? <a href="/">Book a visit here</a></p>',
  });
}

function setupView(ctx) {
  header('Register as security', 'Your name and photo are shown to the admin for approval.');
  renderProfileSetup(ctx.el, user, { intro: 'Add your name and a clear photo of your face. An admin will approve your access.', onDone: (u) => { setUser(u); location.hash = '#/scan'; } });
}

async function scanView(ctx) {
  if (user.role === 'security' && user.status !== 'active') {
    const waiting = user.status === 'pending';
    header(waiting ? 'Waiting for approval' : 'No access');
    ctx.el.innerHTML = `<div class="card center narrow">
      ${photoTag(user.photo, user.name, 'xl')}
      <h2 style="margin-top:12px">${esc(user.name)}</h2>
      <div class="big-icon ${waiting ? 'wait' : 'bad'}" style="margin-top:14px">${waiting ? icons.clock : icons.xCircle}</div>
      <p class="sub">${waiting ? 'An admin needs to approve your account before you can scan passes. This page will open the scanner as soon as you are approved.' : 'Your scanner access has been removed. Please speak to the admin.'}</p>
    </div>`;
    return;
  }
  header('Scan pass', 'Scan the QR code on the visitor\'s phone.');
  const area = document.createElement('div');
  const recent = document.createElement('div');
  ctx.el.replaceChildren(area, recent);
  const loadRecent = async () => {
    const { checkins, people } = await api('/api/staff/recent');
    if (!ctx.isCurrent()) return;
    recent.innerHTML = `<div class="section-title"><span>Let in by you today</span><span>${esc(plural(people, 'person', 'people'))}</span></div>
      <div class="card flush">${checkins.length ? checkins.map((a) => `<div class="person">${photoTag(a.photo, a.name)}<div class="grow"><div class="name">${esc(a.name)}</div><div class="meta">${esc(plural(a.peopleCount, 'person', 'people'))} · ${esc(a.periodLabel)}</div></div><span class="meta">${esc(formatTime(a.checkedInAt))}</span></div>`).join('') : '<div class="empty">No one yet today.</div>'}</div>`;
  };
  const stop = await startScanner(area, { isAdmin: user.role === 'admin', onDone: loadRecent });
  ctx.onCleanup(stop);
  if (!ctx.isCurrent()) stop();
  await loadRecent();
  const refresh = throttle(loadRecent, 3000);
  ctx.onCleanup(liveStream('/api/staff/stream', { changed: (e) => e.kind === 'checkin' && refresh() }, (up) => $('#live').classList.toggle('off', !up)));
  $('#live').classList.remove('hidden');
}

const router = createRouter({
  outlet,
  fallback: '#/scan',
  routes: [
    { path: /^#\/login$/, view: loginView, public: true },
    { path: /^#\/setup$/, view: setupView, setup: true },
    { path: /^#\/scan$/, view: scanView },
  ],
  guard: (route) => {
    if (!user) return route.public ? null : '#/login';
    if (route.public) return '#/scan';
    if (!user.profileComplete && !route.setup) return '#/setup';
    return null;
  },
});

({ user } = await api('/api/auth/me'));
if (user?.role === 'visitor') location.replace(homeFor(user));
else { setUser(user); router.run(); }
