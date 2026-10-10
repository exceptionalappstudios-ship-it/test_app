import { $, api, esc, formatTime, formatPhone, plural, photoTag, openSheet, toast, busy, createRouter, liveStream, homeFor, wrongAccount, throttle } from './common.js';
import { icons } from './icons.js';
import { renderLogin, renderProfileSetup } from './login.js';
import { startScanner } from './scanner.js';

const outlet = $('#app');
let user = null;
let config = null;
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
  header('Security 🛡️', 'Log in to scan passes');
  renderLogin(ctx.el, {
    signupAs: 'security',
    onDone: (u) => {
      if (u.role === 'visitor') { wrongAccount(ctx.el, u, 'security staff'); return; }
      setUser(u);
      location.hash = u.profileComplete ? '#/scan' : '#/setup';
    },
    footer: '<p class="center small muted" style="margin-top:18px">Visiting Gurudev? <a href="/">Book a visit here</a></p>',
  });
}

function setupView(ctx) {
  header('Join as security', 'Your reference will approve you');
  renderProfileSetup(ctx.el, user, {
    intro: 'Add your name, choose your reference and take a clear photo of your face. Your reference will approve your access.',
    references: user.status === 'pending' ? config.references : null,
    requireFace: user.status === 'pending',
    onDone: (u) => { setUser(u); location.hash = '#/scan'; },
  });
}

async function scanView(ctx) {
  if (user.role === 'security' && user.status !== 'active') {
    const waiting = user.status === 'pending';
    header(waiting ? 'Almost there ⏳' : 'No access');
    ctx.el.innerHTML = `<div class="card center narrow">
      ${photoTag(user.photo, user.name, 'xl')}
      <h2 style="margin-top:12px">${esc(user.name)}</h2>
      <div class="big-icon ${waiting ? 'wait' : 'bad'}" style="margin-top:14px">${waiting ? icons.clock : icons.xCircle}</div>
      <p class="sub">${waiting ? `Sent to <strong>${esc(config.references.find((r) => r.id === user.referenceId)?.name ?? 'your reference')}</strong>. The scanner opens here once approved.` : 'Access removed. Please speak to the admin.'}</p>
      ${waiting ? `<a class="btn ghost small" href="#/setup">${icons.edit} Change details</a>` : ''}
    </div>`;
    return;
  }
  header('Scan pass', 'Point at the QR code');
  const area = document.createElement('div');
  const recent = document.createElement('div');
  ctx.el.replaceChildren(area, recent);
  const loadRecent = async () => {
    const { checkins, people } = await api('/api/staff/recent');
    if (!ctx.isCurrent()) return;
    recent.innerHTML = `<div class="section-title"><span>Let in by you today</span><span>${esc(plural(people, 'person', 'people'))}</span></div>
      <div class="card flush">${checkins.length ? checkins.map((a) => `<button type="button" class="person person-btn" data-id="${a.id}">${photoTag(a.photo, a.name)}<div class="grow"><div class="name">${esc(a.name)}</div><div class="meta">${esc(a.checkedInCount !== a.peopleCount ? `${a.checkedInCount} of ${a.peopleCount} came` : plural(a.peopleCount, 'person', 'people'))} · ${esc(a.periodLabel)}</div></div><span class="meta">${esc(formatTime(a.checkedInAt))}</span>${a.peopleCount > 1 ? `<span class="edit-hint">${icons.edit}</span>` : ''}</button>`).join('') : '<div class="empty">No one yet today.</div>'}</div>
      ${checkins.some((a) => a.peopleCount > 1) ? '<p class="small muted center">Tap a group to change how many came in.</p>' : ''}`;
    recent.onclick = (e) => {
      const row = e.target.closest('[data-id]');
      const a = row && checkins.find((x) => x.id === Number(row.dataset.id));
      if (!a || a.peopleCount < 2) return;
      const { el, close } = openSheet(`<div class="center">${photoTag(a.photo, a.name, 'lg')}<h2 style="margin-top:8px">${esc(a.name)}</h2><p class="sub">${esc(plural(a.peopleCount, 'person', 'people'))} booked. How many came in?</p></div>
        <div class="count-picker">${Array.from({ length: a.peopleCount }, (_, i) => i + 1).map((n) => `<button type="button" data-count="${n}" class="${n === a.checkedInCount ? 'on' : ''}">${n}</button>`).join('')}</div>
        <button class="btn ghost block" data-close style="margin-top:10px">Close</button>`);
      el.addEventListener('click', async (ev) => {
        const b = ev.target.closest('[data-count]');
        if (!b) return;
        await busy(b, () => api('/api/staff/count', { method: 'POST', body: { appointmentId: a.id, count: Number(b.dataset.count) } }));
        toast(`Saved ✓ ${plural(Number(b.dataset.count), 'person', 'people')} came in`);
        close();
        loadRecent();
      });
    };
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

[config, { user }] = await Promise.all([api('/api/config'), api('/api/auth/me')]);
if (user?.role === 'visitor') { header('Security staff'); wrongAccount(outlet, user, 'security staff'); }
else { setUser(user); router.run(); }
