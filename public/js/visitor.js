import {
  $, $$, api, esc, formatDate, formatSlot, formatTimestamp, formatClock, dayParts, statusChip, toast, setBusy,
  createRouter, authView, enablePush, pushSupported, registerServiceWorker, liveStream,
} from './common.js';
import { icons } from './icons.js';

const outlet = $('#app');
let user = null;
let config = null;
let stopStream = null;

const TABS = [
  ['book', 'Book', icons.calendar],
  ['appointments', 'My visits', icons.ticket],
  ['updates', 'Updates', icons.bell],
  ['contact', 'Contact', icons.chat],
];
for (const [key, label, icon] of TABS) $(`[data-tab="${key}"]`).innerHTML = `${icon}<span>${label}</span>`;
$('#profileLink').innerHTML = icons.user;

function setLoggedIn(u) {
  user = u;
  $('#tabbar').classList.toggle('hidden', !u);
  $('#profileLink').classList.toggle('hidden', !u);
  stopStream?.();
  stopStream = null;
  if (u) {
    stopStream = liveStream('/api/me/stream', {
      notification: (n) => { toast(`${n.title}: ${n.body}`); refreshBadges(); window.dispatchEvent(new CustomEvent('app:update')); },
      message: () => { refreshBadges(); window.dispatchEvent(new CustomEvent('app:message')); },
    });
    refreshBadges();
  }
}

async function refreshBadges() {
  if (!user) return;
  try {
    const { unread, unreadMessages } = await api('/api/me');
    for (const [tab, n] of [['updates', unread], ['contact', unreadMessages]]) {
      const link = $(`[data-tab="${tab}"]`);
      $('.dot', link)?.remove();
      if (n) link.insertAdjacentHTML('beforeend', `<span class="dot">${n}</span>`);
    }
  } catch { /* ignore */ }
}

// Re-render the current view when something changes, unless the user is typing.
function onLiveUpdate(ctx, event, fn) {
  const handler = () => { if (ctx.isCurrent() && !document.activeElement?.matches('input, textarea')) fn(); };
  window.addEventListener(event, handler);
  ctx.onCleanup(() => window.removeEventListener(event, handler));
}

// ---- Book --------------------------------------------------------------------

async function bookView(ctx) {
  const { slots } = await api('/api/slots');
  if (!ctx.isCurrent()) return;
  const byDate = new Map();
  for (const s of slots) byDate.set(s.date, [...(byDate.get(s.date) ?? []), s]);
  const dates = [...byDate.keys()];
  let date = dates[0];
  let slot = null;

  ctx.el.innerHTML = `
    <h1>Book an appointment</h1>
    <p class="lead">Choose a time to meet Gurudev. Times are in ${esc(config.timeZone.replace('_', ' '))} time.</p>
    <div class="steps"><span class="on"></span><span></span><span></span></div>
    <section id="pick">
      ${dates.length ? `
        <div class="chip-row" id="dates" role="listbox" aria-label="Date"></div>
        <div class="card"><h3 id="dateTitle"></h3><div class="time-grid" id="times"></div></div>
        <button class="btn block" id="next" disabled>Continue</button>`
      : '<div class="card empty">No slots are open right now. Please check back soon, or <a href="#/contact">contact us</a>.</div>'}
    </section>
    <section id="details" class="hidden">
      <div class="card">
        <div class="head" style="display:flex;justify-content:space-between;align-items:center;gap:8px">
          <div><div class="muted small">Selected time</div><div class="appt-when" id="chosen"></div></div>
          <button class="btn secondary small" id="change" type="button">Change</button>
        </div>
      </div>
      <form class="card" id="form" novalidate>
        <h2>Your details</h2>
        <label for="name">Full name</label>
        <input id="name" name="name" required maxlength="100" value="${esc(user.name)}">
        <div class="row">
          <div><label for="phone">Mobile (WhatsApp)</label><input id="phone" name="phone" type="tel" required maxlength="25" value="${esc(user.phone)}"></div>
          <div><label for="email">Email</label><input id="email" name="email" type="email" required maxlength="200" value="${esc(user.email)}"></div>
        </div>
        <label for="purpose">Purpose of meeting</label>
        <textarea id="purpose" name="purpose" required maxlength="2000" placeholder="Briefly share why you'd like to meet Gurudev"></textarea>
        <div class="error hidden" id="err"></div>
        <div class="actions"><button class="btn block" type="submit" id="submit">Request appointment</button></div>
      </form>
    </section>
    <section id="done" class="hidden">
      <div class="card" style="text-align:center">
        <div class="check-big">${icons.check}</div>
        <h2>Request sent 🙏</h2>
        <p>Your request for <strong id="doneSlot"></strong> is waiting for approval.</p>
        <p class="muted">We'll confirm in the app, by WhatsApp and by email. Your entry QR code will appear in the app ${config.qrLeadMinutes} minutes before your meeting.</p>
        <div class="actions" style="justify-content:center">
          ${pushSupported() && Notification.permission !== 'granted' ? `<button class="btn" id="push">${icons.bell} Turn on notifications</button>` : ''}
          <a class="btn secondary" href="#/appointments">View my visits</a>
        </div>
      </div>
    </section>`;

  const step = (n) => {
    $$('.steps span', ctx.el).forEach((s, i) => s.classList.toggle('on', i < n));
    $('#pick', ctx.el).classList.toggle('hidden', n !== 1);
    $('#details', ctx.el).classList.toggle('hidden', n !== 2);
    $('#done', ctx.el).classList.toggle('hidden', n !== 3);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  function renderDates() {
    $('#dates', ctx.el).innerHTML = dates.map((d) => {
      const p = dayParts(d);
      const n = byDate.get(d).length;
      return `<button class="date-pill ${d === date ? 'on' : ''}" data-date="${d}" role="option" aria-selected="${d === date}">
        <div class="dow">${esc(p.dow)}</div><div class="day">${esc(p.day)}</div><div class="count">${esc(p.month)}</div><div class="count">${n} open</div></button>`;
    }).join('');
    $('#dateTitle', ctx.el).textContent = formatDate(date);
    $('#times', ctx.el).innerHTML = byDate.get(date).map((s) =>
      `<button class="time-btn ${slot?.id === s.id ? 'on' : ''}" data-id="${s.id}">${esc(s.start_time)}<span class="end">to ${esc(s.end_time)}</span></button>`).join('');
    $('#next', ctx.el).disabled = !slot;
  }

  if (dates.length) {
    renderDates();
    $('#dates', ctx.el).addEventListener('click', (e) => {
      const b = e.target.closest('[data-date]');
      if (b) { date = b.dataset.date; renderDates(); }
    });
    $('#times', ctx.el).addEventListener('click', (e) => {
      const b = e.target.closest('[data-id]');
      if (b) { slot = slots.find((s) => s.id === Number(b.dataset.id)); renderDates(); }
    });
    $('#next', ctx.el).addEventListener('click', () => {
      $('#chosen', ctx.el).textContent = formatSlot(slot);
      step(2);
    });
  }
  $('#change', ctx.el).addEventListener('click', () => step(1));

  $('#form', ctx.el).addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const err = $('#err', ctx.el);
    err.classList.add('hidden');
    if (!form.checkValidity()) { form.reportValidity(); return; }
    setBusy($('#submit', ctx.el), true);
    try {
      const { appointment } = await api('/api/appointments', { method: 'POST', body: { ...Object.fromEntries(new FormData(form)), slotId: slot.id } });
      $('#doneSlot', ctx.el).textContent = formatSlot(appointment.slot);
      step(3);
      $('#push', ctx.el)?.addEventListener('click', async (ev) => {
        try { await enablePush(config.vapidPublicKey); ev.target.closest('button').remove(); toast('Notifications are on.'); } catch (x) { toast(x.message); }
      });
    } catch (x) {
      err.textContent = x.message;
      err.classList.remove('hidden');
      if (x.status === 409 && /slot/.test(x.message)) setTimeout(() => ctx.isCurrent() && bookView(ctx), 2500);
    } finally {
      setBusy($('#submit', ctx.el), false);
    }
  });
}

// ---- My visits ---------------------------------------------------------------

function passButton(a) {
  const p = a.pass;
  if (p.state === 'ready') return `<a class="btn block" href="#/pass/${a.id}">${icons.ticket} Show entry QR code</a>`;
  if (p.state === 'checked_in') return `<a class="btn secondary block" href="#/pass/${a.id}">${icons.check} Checked in</a>`;
  if (p.state === 'not_yet') return `<a class="btn secondary block" href="#/pass/${a.id}">${icons.ticket} Entry pass · opens ${config.qrLeadMinutes} min before</a>`;
  return '';
}

async function appointmentsView(ctx) {
  const render = async () => {
    const { appointments } = await api('/api/me');
    if (!ctx.isCurrent()) return;
    const upcoming = appointments.filter((a) => ['pending', 'approved'].includes(a.status) && !a.past && !a.checked_in_at);
    const past = appointments.filter((a) => !upcoming.includes(a));
    const card = (a) => `
      <div class="card">
        <div class="head" style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start">
          <div><div class="appt-when">${esc(formatDate(a.slot.date))}</div><div class="muted">${esc(a.slot.start_time)}–${esc(a.slot.end_time)}</div></div>
          ${statusChip(a.status, a.checked_in_at)}
        </div>
        <p class="muted small" style="margin:10px 0 0;white-space:pre-wrap">${esc(a.purpose)}</p>
        ${a.admin_note ? `<div class="notice small"><strong>Note from the ashram:</strong> ${esc(a.admin_note)}</div>` : ''}
        ${a.status === 'pending' ? '<p class="small muted">Waiting for approval. You\'ll be notified by WhatsApp, email and here.</p>' : ''}
        <div class="actions">${passButton(a)}
          ${['pending', 'approved'].includes(a.status) && !a.checked_in_at && !a.past
            ? `<button class="btn danger small" data-cancel="${a.id}">Cancel</button>` : ''}
        </div>
      </div>`;
    ctx.el.innerHTML = `
      <h1>My visits</h1>
      <p class="lead">Your appointment requests and entry passes.</p>
      ${upcoming.length ? upcoming.map(card).join('') : '<div class="card empty">No upcoming visits.<div class="actions" style="justify-content:center"><a class="btn" href="#/book">Book an appointment</a></div></div>'}
      ${past.length ? `<div class="section-head"><h2>Past &amp; closed</h2></div>${past.map(card).join('')}` : ''}`;
  };
  await render();
  onLiveUpdate(ctx, 'app:update', render);
  ctx.el.addEventListener('click', async (e) => {
    const id = e.target.closest('[data-cancel]')?.dataset.cancel;
    if (!id || !confirm('Cancel this appointment?')) return;
    try { await api(`/api/me/appointments/${id}/cancel`, { method: 'POST' }); render(); } catch (x) { toast(x.message); }
  });
}

// ---- Entry pass ---------------------------------------------------------------

async function passView(ctx, id) {
  const render = async () => {
    const { appointment: a, pass } = await api(`/api/me/appointments/${id}/pass`);
    if (!ctx.isCurrent()) return;
    let body;
    if (pass.state === 'ready') {
      body = `<p class="muted">Show this QR code at the entrance.</p>
        <div class="qr">${pass.svg}</div>
        <div class="big">${esc(a.name)}</div>
        <div class="muted">${esc(formatSlot(a.slot))}</div>
        <p class="code">Code: ${esc(pass.code)}</p>`;
    } else if (pass.state === 'checked_in') {
      body = `<div class="check-big">${icons.check}</div><div class="big">You're checked in</div>
        <p class="muted">Welcome, ${esc(a.name)}. Checked in at ${esc(formatClock(a.checked_in_at))}.</p>`;
    } else if (pass.state === 'not_yet') {
      const opens = new Date(Date.now() + pass.opensInMinutes * 60000);
      const h = Math.floor(pass.opensInMinutes / 60);
      const m = pass.opensInMinutes % 60;
      const days = Math.floor(h / 24);
      const label = days >= 1 ? `${days} day${days > 1 ? 's' : ''}` : h ? `${h}h ${m}m` : `${m} min`;
      body = `<div class="muted">Your QR code appears in</div><div class="countdown">${label}</div>
        <p class="muted">It becomes available ${config.qrLeadMinutes} minutes before your meeting (${esc(formatSlot(a.slot))}), around ${esc(opens.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }))} your time. We'll notify you when it's ready.</p>`;
    } else if (pass.state === 'expired') {
      body = '<div class="big">This pass has expired</div><p class="muted">The time for this meeting has passed.</p>';
    } else {
      body = `<div class="big">No entry pass</div><p class="muted">This appointment is ${esc(a.status)}.</p>`;
    }
    ctx.el.innerHTML = `
      <a class="btn ghost small" href="#/appointments">${icons.back} My visits</a>
      <div class="card pass narrow" style="margin-top:8px"><h2>Entry pass</h2>${body}</div>`;
  };
  await render();
  const timer = setInterval(render, 30000);
  ctx.onCleanup(() => clearInterval(timer));
  onLiveUpdate(ctx, 'app:update', render);
}

// ---- Updates -------------------------------------------------------------------

async function updatesView(ctx) {
  const render = async () => {
    const { notifications, unread } = await api('/api/me');
    if (!ctx.isCurrent()) return;
    ctx.el.innerHTML = `
      <h1>Updates</h1>
      <p class="lead">Everything about your visits. We also send these by WhatsApp and email.</p>
      <div id="pushCard"></div>
      <div class="card flush">
        ${notifications.length ? notifications.map((n) => `
          <div class="item ${n.read_at ? '' : 'unread'}">
            <div class="head"><span class="title">${esc(n.title)}</span><span class="time">${esc(formatTimestamp(n.created_at))}</span></div>
            <p>${esc(n.body)}</p>
          </div>`).join('') : '<div class="empty">No updates yet.</div>'}
      </div>`;
    renderPushCard($('#pushCard', ctx.el));
    if (unread) { await api('/api/me/notifications/read', { method: 'POST' }); refreshBadges(); }
  };
  await render();
  onLiveUpdate(ctx, 'app:update', render);
}

function renderPushCard(el) {
  if (!pushSupported() || Notification.permission === 'granted') {
    if (pushSupported()) enablePush(config.vapidPublicKey).catch(() => {});
    return;
  }
  el.innerHTML = `<div class="card" style="display:flex;gap:12px;align-items:center">
    <div style="flex:1"><strong>Get alerts on this phone</strong><div class="small muted">Approval, reminders and your entry QR code.</div></div>
    <button class="btn small">Turn on</button></div>`;
  $('button', el).addEventListener('click', async () => {
    try { await enablePush(config.vapidPublicKey); el.innerHTML = ''; toast('Notifications are on.'); } catch (x) { toast(x.message); }
  });
}

// ---- Contact -------------------------------------------------------------------

async function contactView(ctx) {
  const c = config.contact;
  const wa = c.whatsapp ? c.whatsapp.replace(/\D/g, '') : null;
  ctx.el.innerHTML = `
    <h1>Contact us</h1>
    <p class="lead">Questions about your visit? Message the ashram team or reach us directly.</p>
    ${c.phone || wa || c.email ? `<div class="contact-grid" style="margin-bottom:14px">
      ${c.phone ? `<a href="tel:${esc(c.phone)}">${icons.phone}Call</a>` : ''}
      ${wa ? `<a href="https://wa.me/${esc(wa)}" target="_blank" rel="noopener">${icons.whatsapp}WhatsApp</a>` : ''}
      ${c.email ? `<a href="mailto:${esc(c.email)}">${icons.mail}Email</a>` : ''}
    </div>` : ''}
    ${c.address ? `<div class="card small address">${icons.pin}<span>${esc(c.address)}</span></div>` : ''}
    <div class="card flush">
      <div class="item"><span class="title">Messages</span></div>
      <div class="thread" id="thread"></div>
      <form class="composer" id="composer">
        <textarea name="body" placeholder="Write a message…" maxlength="2000" required aria-label="Message"></textarea>
        <button class="btn" type="submit" aria-label="Send">${icons.send}</button>
      </form>
    </div>`;
  const thread = $('#thread', ctx.el);
  const render = async () => {
    const { messages } = await api('/api/me/messages');
    if (!ctx.isCurrent()) return;
    thread.innerHTML = messages.length ? messages.map((m) => `
      <div class="bubble-msg ${m.from_admin ? 'theirs' : 'mine'}">${esc(m.body)}
        <span class="meta">${m.from_admin ? `${esc(m.sender_name)} · ` : ''}${esc(formatTimestamp(m.created_at))}</span></div>`).join('')
      : '<div class="empty small">Send us a message and the team will reply here. You\'ll get a notification when they do.</div>';
    thread.scrollTop = thread.scrollHeight;
    refreshBadges();
  };
  await render();
  const handler = () => ctx.isCurrent() && render();
  window.addEventListener('app:message', handler);
  ctx.onCleanup(() => window.removeEventListener('app:message', handler));
  $('#composer', ctx.el).addEventListener('submit', async (e) => {
    e.preventDefault();
    const field = e.target.body;
    if (!field.value.trim()) return;
    const button = $('button', e.target);
    setBusy(button, true);
    try { await api('/api/me/messages', { method: 'POST', body: { body: field.value } }); field.value = ''; await render(); } catch (x) { toast(x.message); }
    setBusy(button, false);
  });
}

// ---- Profile -------------------------------------------------------------------

async function profileView(ctx) {
  ctx.el.innerHTML = `
    <div class="narrow">
      <h1>My account</h1>
      <p class="lead">${esc(user.email)}</p>
      <form class="card" id="profile" novalidate>
        <h2>Profile</h2>
        <label for="name">Full name</label><input id="name" name="name" required maxlength="100" value="${esc(user.name)}">
        <label for="phone">Mobile (WhatsApp)</label><input id="phone" name="phone" type="tel" required maxlength="25" value="${esc(user.phone)}">
        <div class="actions"><button class="btn" type="submit">Save</button></div>
      </form>
      <div id="pushCard"></div>
      <form class="card" id="password" novalidate>
        <h2>Change password</h2>
        <label for="cur">Current password</label><input id="cur" name="currentPassword" type="password" autocomplete="current-password" required>
        <label for="new">New password</label><input id="new" name="newPassword" type="password" autocomplete="new-password" minlength="8" required>
        <div class="actions"><button class="btn secondary" type="submit">Update password</button></div>
      </form>
      <button class="btn danger block" id="logout">${icons.logout} Log out</button>
    </div>`;
  renderPushCard($('#pushCard', ctx.el));
  $('#profile', ctx.el).addEventListener('submit', async (e) => {
    e.preventDefault();
    try { ({ user } = await api('/api/auth/me', { method: 'PATCH', body: Object.fromEntries(new FormData(e.target)) })); toast('Profile saved.'); profileView(ctx); } catch (x) { toast(x.message); }
  });
  $('#password', ctx.el).addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!e.target.checkValidity()) { e.target.reportValidity(); return; }
    try { await api('/api/auth/change-password', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) }); e.target.reset(); toast('Password updated.'); } catch (x) { toast(x.message); }
  });
  $('#logout', ctx.el).addEventListener('click', async () => {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
    setLoggedIn(null);
    location.hash = '#/login';
  });
}

// ---- Boot ----------------------------------------------------------------------

const afterLogin = async (u) => {
  setLoggedIn(u);
  let back = null;
  try { back = sessionStorage.getItem('returnTo'); sessionStorage.removeItem('returnTo'); } catch { /* storage blocked */ }
  location.hash = back || '#/book';
};
const auth = (mode) => authView(mode, { title: 'Welcome', subtitle: 'Log in to book your meeting with Gurudev.', onSuccess: afterLogin });

const router = createRouter({
  outlet,
  fallback: '#/book',
  routes: [
    { path: /^#\/login$/, view: auth('login'), public: true },
    { path: /^#\/signup$/, view: auth('signup'), public: true },
    { path: /^#\/forgot$/, view: auth('forgot'), public: true },
    { path: /^#\/reset\/([\w-]+)$/, view: auth('reset'), public: true },
    { path: /^#\/book$/, view: bookView, tab: 'book' },
    { path: /^#\/appointments$/, view: appointmentsView, tab: 'appointments' },
    { path: /^#\/pass\/(\d+)$/, view: passView, tab: 'appointments' },
    { path: /^#\/updates$/, view: updatesView, tab: 'updates' },
    { path: /^#\/contact$/, view: contactView, tab: 'contact' },
    { path: /^#\/profile$/, view: profileView },
  ],
  guard: (route, hash) => {
    if (route.public && user && !/reset/.test(hash)) return '#/book';
    if (!route.public && !user) {
      try { sessionStorage.setItem('returnTo', hash); } catch { /* storage blocked */ }
      return '#/signup';
    }
    return null;
  },
  onChange: (route) => $$('[data-tab]').forEach((a) => a.classList.toggle('on', a.dataset.tab === route.tab)),
});

registerServiceWorker();
[config, { user }] = await Promise.all([api('/api/config'), api('/api/auth/me')]);
setLoggedIn(user);
router.run();
