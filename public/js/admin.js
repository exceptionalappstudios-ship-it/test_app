import {
  $, $$, api, esc, formatDate, formatShortDate, formatPhone, formatTime, formatWhen, addDays, plural, statusChip, photoTag,
  contactButtons, toast, openSheet, confirmSheet, busy, throttle, createRouter, liveStream, homeFor, PERIOD_ICONS,
} from './common.js';
import { icons } from './icons.js';
import { renderLogin, renderProfileSetup } from './login.js';
import { renderChart, legendHtml } from './chart.js';

const outlet = $('#app');
let user = null;
let config = null;
let today = null;
let stopStream = null;

const TABS = [['home', 'Dashboard', icons.home], ['requests', 'Requests', icons.inbox], ['visitors', 'Visitors', icons.users], ['security', 'Security', icons.shield], ['more', 'More', icons.more]];
for (const [key, label, icon] of TABS) $(`[data-tab="${key}"]`).innerHTML = `${icon}<span>${label}</span>`;

function header(title, subtitle = '', extra = '') {
  $('#title').textContent = title;
  $('#subtitle').textContent = subtitle;
  $('#heroExtra').innerHTML = extra;
}

function setUser(u) {
  user = u;
  const ready = Boolean(u?.profileComplete);
  $('#tabbar').classList.toggle('hidden', !ready);
  document.body.classList.toggle('no-nav', !ready);
  $('#me').classList.toggle('hidden', !ready);
  $('#live').classList.toggle('hidden', !ready);
  $('#me').innerHTML = u?.photo ? `<img src="${esc(u.photo)}" alt="">` : icons.user;
  stopStream?.();
  stopStream = null;
  if (ready) {
    const notify = throttle(() => { refreshBadges(); window.dispatchEvent(new CustomEvent('admin:changed')); }, 2500);
    stopStream = liveStream('/api/staff/stream', { changed: notify }, (up) => $('#live').classList.toggle('off', !up));
    refreshBadges();
  }
}

async function refreshBadges() {
  try {
    const { summary, today: t } = await api('/api/admin/dashboard');
    today = t;
    for (const [tab, n] of [['requests', summary.pending], ['security', summary.securityPending]]) {
      const link = $(`[data-tab="${tab}"]`);
      $('.dot', link)?.remove();
      if (n) link.insertAdjacentHTML('beforeend', `<span class="dot">${n}</span>`);
    }
  } catch { /* offline */ }
}

// Re-render when the server reports a change (throttled), unless someone is typing.
function onChanged(ctx, fn) {
  const handler = () => { if (ctx.isCurrent() && !document.activeElement?.matches('input, textarea')) fn(); };
  window.addEventListener('admin:changed', handler);
  ctx.onCleanup(() => window.removeEventListener('admin:changed', handler));
}

// Prev / date / next control shown in the header.
function dayNav(date, onPick) {
  $('#heroExtra').innerHTML = `<div class="day-nav">
    <button class="icon-btn" data-prev aria-label="Previous day">${icons.back}</button>
    <input type="date" value="${date}" aria-label="Choose a day" style="max-width:180px">
    <button class="icon-btn" data-next aria-label="Next day">${icons.next}</button>
    ${date !== today ? '<button class="btn small light" data-today style="margin-left:auto">Today</button>' : '<span class="lbl" style="margin-left:auto">Today</span>'}
  </div>`;
  $('[data-prev]').onclick = () => onPick(addDays(date, -1));
  $('[data-next]').onclick = () => onPick(addDays(date, 1));
  $('#heroExtra input').onchange = (e) => e.target.value && onPick(e.target.value);
  const t = $('[data-today]');
  if (t) t.onclick = () => onPick(today);
}

// ---- Appointment card & actions -------------------------------------------------------

function apptDetails(a) {
  return `
    <div class="row">${photoTag(a.photo, a.name, 'lg')}<div class="grow">
      <div style="font-weight:800;font-size:1.1rem">${esc(a.name)}</div>
      <div class="small muted">${esc(formatPhone(a.phone))}</div>
      <div style="margin-top:6px">${statusChip(a.status, a.checkedInAt)}</div></div>
      <div class="contact" style="display:flex;flex-direction:column;gap:8px">${contactButtons(a.phone)}</div></div>
    <dl class="details">
      <dt>Day</dt><dd><strong>${esc(formatShortDate(a.date))} · ${esc(a.periodLabel)}</strong></dd>
      <dt>People</dt><dd><strong>${esc(plural(a.peopleCount, 'person', 'people'))}</strong></dd>
      ${a.people.length ? `<dt>With</dt><dd>${a.people.map((p) => `${esc(p.name)} · <a href="tel:${esc(p.phone)}">${esc(formatPhone(p.phone))}</a>`).join('<br>')}</dd>` : ''}
      <dt>Reference</dt><dd>${esc(a.reference)}</dd>
      <dt>Purpose</dt><dd>${a.purposes.map((p) => `<span class="tag">${esc(p)}</span>`).join(' ')}</dd>
      ${a.description ? `<dt>Details</dt><dd>${esc(a.description)}</dd>` : ''}
      ${a.adminNote ? `<dt>Note</dt><dd>${esc(a.adminNote)}</dd>` : ''}
      ${a.checkedInAt ? `<dt>Checked in</dt><dd><strong>${esc(formatTime(a.checkedInAt))}</strong>${a.checkedInBy ? ` by ${esc(a.checkedInBy)}` : ''}</dd>` : ''}
      ${a.reviewedBy && !['pending'].includes(a.status) ? `<dt>Reviewed by</dt><dd>${esc(a.reviewedBy)}</dd>` : ''}
      <dt>Requested</dt><dd>${esc(formatWhen(a.createdAt))}</dd>
    </dl>`;
}

function apptActions(a) {
  if (a.status === 'pending') return `<div class="actions"><button class="btn" data-act="approve">${icons.check} Approve</button><button class="btn amber" data-act="hold">${icons.pause} Hold</button><button class="btn danger" data-act="reject">${icons.x} Decline</button></div>`;
  if (a.status === 'hold') return `<div class="actions"><button class="btn" data-act="approve">${icons.check} Approve</button><button class="btn danger" data-act="reject">${icons.x} Decline</button></div>`;
  if (a.status === 'approved' && !a.checkedInAt) return `<div class="actions"><button class="btn blue" data-act="checkin">${icons.scan} Check in now</button><button class="btn danger" data-act="cancel">${icons.x} Cancel</button></div>`;
  return '';
}

// Runs an action on an appointment; resolves true when something changed.
async function act(a, action, button) {
  if (action === 'checkin') {
    const scan = await busy(button, () => api('/api/staff/scan', { method: 'POST', body: { appointmentId: a.id } }));
    if (!scan.canAdmit) {
      if (!scan.adminOverride) { toast(scan.message); return false; }
      if (!await confirmSheet({ title: 'Check in anyway?', message: scan.message, confirm: 'Yes, check in' })) return false;
    }
    await busy(button, () => api('/api/staff/admit', { method: 'POST', body: { appointmentId: a.id, override: !scan.canAdmit } }));
    toast(`${a.name} checked in.`);
    return true;
  }
  let note = '';
  if (action === 'reject' || action === 'cancel') {
    const answer = await new Promise((resolve) => {
      let ok = false;
      const { el, close } = openSheet(`<h2 style="margin:0 0 6px">${action === 'reject' ? 'Decline this request?' : 'Cancel this appointment?'}</h2>
        <p class="sub">${esc(a.name)} will be told on WhatsApp.</p>
        <label for="note">Reason <span class="muted small">(optional, sent to them)</span></label><textarea id="note" maxlength="500"></textarea>
        <div class="actions"><button class="btn light" data-close>Go back</button><button class="btn red" data-yes>${action === 'reject' ? 'Decline' : 'Cancel appointment'}</button></div>`,
      { onClose: () => resolve(ok ? $('#note', el).value : null) });
      $('[data-yes]', el).addEventListener('click', () => { ok = true; close(); });
    });
    if (answer === null) return false;
    note = answer;
  }
  await busy(button, () => api(`/api/admin/appointments/${a.id}/${action}`, { method: 'POST', body: { note } }));
  toast({ approve: `Approved. ${a.name} will get a WhatsApp confirmation.`, hold: 'Moved to On hold.', reject: 'Declined.', cancel: 'Cancelled.' }[action]);
  return true;
}

function openAppointment(a, onChange) {
  const { el, close } = openSheet(`${apptDetails(a)}${apptActions(a)}<button class="btn ghost block" data-close style="margin-top:8px">Close</button>`);
  el.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    try { if (await act(a, b.dataset.act, b)) { close(); onChange(); } } catch { /* shown */ }
  });
}

// ---- Dashboard -----------------------------------------------------------------------

let dashDate = null;

const ensureToday = async () => { today ??= (await api('/api/admin/dashboard')).today; };

async function homeView(ctx) {
  await ensureToday();
  dashDate ??= today;
  const pick = (d) => { dashDate = d; homeView(ctx); };
  const load = async () => {
    const d = await api(`/api/admin/dashboard?date=${dashDate}`);
    if (!ctx.isCurrent()) return;
    today = d.today;
    header(dashDate === today ? 'Today' : formatDate(dashDate), dashDate === today ? formatDate(today) : '');
    dayNav(dashDate, pick);
    const s = d.summary;
    const pct = s.people ? Math.round((s.checkedInPeople / s.people) * 100) : 0;
    const ring = `<svg class="ring" viewBox="0 0 36 36" role="img" aria-label="${pct}% checked in"><circle cx="18" cy="18" r="15.5" fill="none" stroke="#e8f1fd" stroke-width="4"/>
      <circle cx="18" cy="18" r="15.5" fill="none" stroke="url(#g)" stroke-width="4" stroke-linecap="round" stroke-dasharray="${(pct / 100) * 97.4} 97.4" transform="rotate(-90 18 18)"/>
      <defs><linearGradient id="g"><stop offset="0" stop-color="#2f7de1"/><stop offset="1" stop-color="#1fbf63"/></linearGradient></defs>
      <text x="18" y="21" text-anchor="middle" font-size="7.5" font-weight="800" fill="#0f1f3d">${pct}%</text></svg>`;
    ctx.el.innerHTML = `
      <div class="kpis">
        <div class="kpi main">${ring}<div><div class="l">People checked in</div><div class="v">${s.checkedInPeople}<span class="muted" style="font-size:1.1rem;font-weight:700"> / ${s.people}</span></div></div></div>
        <div class="kpi"><div class="l">Yet to arrive</div><div class="v">${s.remainingPeople}</div></div>
        <div class="kpi"><div class="l">Bookings</div><div class="v">${s.bookings}</div></div>
        <div class="kpi"><div class="l">Checked in</div><div class="v">${s.checkedInBookings}</div></div>
      </div>
      <div style="margin-top:14px">
        ${s.pending ? `<a class="alert-link" href="#/requests"><span class="count">${s.pending}</span>New requests to review${icons.next}</a>` : ''}
        ${s.hold ? `<a class="alert-link" href="#/requests?hold"><span class="count violet">${s.hold}</span>Requests on hold${icons.next}</a>` : ''}
        ${s.securityPending ? `<a class="alert-link" href="#/security"><span class="count blue">${s.securityPending}</span>Security staff waiting for approval${icons.next}</a>` : ''}
      </div>
      <div class="two-col">
        <div class="card">
          <h2>Sessions</h2>
          ${d.sessions.length ? d.sessions.map((x) => {
            const p = x.people ? Math.round((x.checkedInPeople / x.people) * 100) : 0;
            return `<div class="session-row"><div class="row" style="gap:8px"><span style="color:var(--blue-700);display:grid">${PERIOD_ICONS[x.period].replace('<svg', '<svg width="20" height="20"')}</span><strong>${esc(x.label)}</strong></div>
              <div class="meter" title="${x.checkedInPeople} of ${x.people} people"><span style="width:${p}%"></span></div>
              <span class="n">${x.checkedInPeople} / ${x.people}</span></div>`;
          }).join('') + '<div class="small muted" style="margin-top:6px">People checked in / people confirmed</div>' : '<div class="empty">No sessions open on this day. <a href="#/sessions">Open days</a></div>'}
        </div>
        <div class="card">
          <h2>Last 7 days and next 7 days</h2>
          ${legendHtml()}
          <div class="chart" id="chart"></div>
        </div>
      </div>
      <div class="section-title"><span>Recent check-ins</span><a href="#/visitors" class="small">See all</a></div>
      <div class="card flush">${d.recent.length ? d.recent.map((a) => `
        <div class="person">${photoTag(a.photo, a.name)}<div class="grow"><div class="name">${esc(a.name)}</div>
          <div class="meta">${esc(plural(a.peopleCount, 'person', 'people'))} · ${esc(a.periodLabel)}${a.checkedInBy ? ` · by ${esc(a.checkedInBy)}` : ''}</div></div>
          <span class="meta">${esc(formatTime(a.checkedInAt))}</span></div>`).join('') : '<div class="empty">No one has checked in yet.</div>'}</div>`;
    renderChart($('#chart', ctx.el), d.days, dashDate);
  };
  await load();
  onChanged(ctx, load);
  const onResize = throttle(() => ctx.isCurrent() && load(), 500);
  window.addEventListener('resize', onResize);
  ctx.onCleanup(() => window.removeEventListener('resize', onResize));
}

// ---- Requests (pending / on hold) -----------------------------------------------------

async function requestsView(ctx, query) {
  let status = query === '?hold' ? 'hold' : 'pending';
  header('Requests', 'Approve, hold or decline. Approved visitors get a WhatsApp confirmation.',
    `<div class="segments" style="max-width:960px;margin:16px auto 0"><button data-s="pending">Waiting</button><button data-s="hold">On hold</button></div>`);
  const load = async () => {
    $$('#heroExtra [data-s]').forEach((b) => b.classList.toggle('on', b.dataset.s === status));
    const { appointments } = await api(`/api/admin/appointments?status=${status}`);
    if (!ctx.isCurrent()) return;
    ctx.el.innerHTML = appointments.length ? appointments.map((a) => `<div class="card" data-id="${a.id}">${apptDetails(a)}${apptActions(a)}</div>`).join('')
      : `<div class="card empty">${status === 'pending' ? 'No new requests. 🎉' : 'Nothing on hold.'}</div>`;
    ctx.el.onclick = async (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const a = appointments.find((x) => x.id === Number(b.closest('[data-id]').dataset.id));
      try { if (await act(a, b.dataset.act, b)) { load(); refreshBadges(); } } catch { /* shown */ }
    };
  };
  $('#heroExtra').onclick = (e) => { const b = e.target.closest('[data-s]'); if (b) { status = b.dataset.s; load(); } };
  ctx.onCleanup(() => { $('#heroExtra').onclick = null; });
  await load();
  onChanged(ctx, load);
}

// ---- Visitors by date ------------------------------------------------------------------

let visitDate = null;
let visitFilter = 'all';

async function visitorsView(ctx) {
  await ensureToday();
  visitDate ??= today;
  let q = '';
  const pick = (d) => { visitDate = d; visitorsView(ctx); };
  header('Visitors', formatDate(visitDate));
  dayNav(visitDate, pick);
  ctx.el.innerHTML = `
    <div class="card" id="stats"><div class="spinner"></div></div>
    <div class="search" style="margin-bottom:10px">${icons.search}<input id="q" type="search" placeholder="Search name, phone or reference" autocomplete="off"></div>
    <div class="filter-row" id="filters">
      ${[['all', 'Everyone'], ['out', 'Not arrived'], ['in', 'Checked in'], ['pending', 'Waiting'], ['hold', 'On hold']].map(([k, l]) => `<button class="filter ${visitFilter === k ? 'on' : ''}" data-f="${k}">${l}</button>`).join('')}
    </div>
    <div class="card flush" id="list" style="margin-top:8px"></div>
    <button class="btn blue block" id="msgAll">${icons.whatsapp} Send WhatsApp message to this day's visitors</button>`;
  const load = async () => {
    const params = new URLSearchParams({ date: visitDate });
    if (['in', 'out'].includes(visitFilter)) params.set('checked', visitFilter);
    if (['pending', 'hold'].includes(visitFilter)) params.set('status', visitFilter);
    if (q) params.set('q', q);
    const { appointments, stats: s } = await api(`/api/admin/appointments?${params}`);
    if (!ctx.isCurrent()) return;
    $('#stats', ctx.el).innerHTML = `
      <div class="kpis" style="grid-template-columns:repeat(3,1fr)">
        <div><div class="l small muted">Confirmed</div><div style="font-size:1.6rem;font-weight:800">${s.approved}</div><div class="small muted">${plural(s.people, 'person', 'people')}</div></div>
        <div><div class="l small muted">Checked in</div><div style="font-size:1.6rem;font-weight:800;color:var(--green-dark)">${s.checkedIn}</div><div class="small muted">${plural(s.checkedInPeople, 'person', 'people')}</div></div>
        <div><div class="l small muted">Not arrived</div><div style="font-size:1.6rem;font-weight:800;color:var(--blue-700)">${s.remaining}</div><div class="small muted">${plural(s.remainingPeople, 'person', 'people')}</div></div>
      </div>`;
    const list = $('#list', ctx.el);
    list.innerHTML = appointments.length ? appointments.map((a) => `
      <div class="person" data-id="${a.id}" style="cursor:pointer">
        ${photoTag(a.photo, a.name)}
        <div class="grow"><div class="name">${esc(a.name)}</div>
          <div class="meta">${esc(a.periodLabel)} · ${esc(plural(a.peopleCount, 'person', 'people'))}${a.checkedInAt ? ` · in at ${esc(formatTime(a.checkedInAt))}${a.checkedInBy ? ` by ${esc(a.checkedInBy)}` : ''}` : ''}</div>
          <div style="margin-top:4px">${statusChip(a.status, a.checkedInAt)}</div></div>
        <div class="contact">${contactButtons(a.phone)}</div>
      </div>`).join('') : '<div class="empty">No visitors match.</div>';
    list.onclick = (e) => {
      if (e.target.closest('a')) return;
      const row = e.target.closest('[data-id]');
      if (row) openAppointment(appointments.find((a) => a.id === Number(row.dataset.id)), load);
    };
  };
  let t;
  $('#q', ctx.el).addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => { q = e.target.value.trim(); load(); }, 250); });
  $('#filters', ctx.el).addEventListener('click', (e) => {
    const b = e.target.closest('[data-f]');
    if (!b) return;
    visitFilter = b.dataset.f;
    $$('#filters .filter', ctx.el).forEach((x) => x.classList.toggle('on', x === b));
    load();
  });
  $('#msgAll', ctx.el).addEventListener('click', () => broadcastSheet(visitDate));
  await load();
  onChanged(ctx, load);
}

function broadcastSheet(date) {
  const { el, close } = openSheet(`
    <h2 style="margin:0 0 4px">Message visitors</h2>
    <p class="sub">Sent on WhatsApp and in the app to everyone confirmed for <strong>${esc(formatDate(date))}</strong>.</p>
    <label for="bp">Who</label>
    <select id="bp"><option value="">Everyone that day</option>${Object.entries(config.periods).map(([k, p]) => `<option value="${k}">${esc(p.label)} only</option>`).join('')}</select>
    <label for="bm">Message</label>
    <textarea id="bm" maxlength="600" placeholder="For example: Today's meeting has moved to the main hall. Please come by 10:30 AM."></textarea>
    <div class="actions"><button class="btn light" data-close>Cancel</button><button class="btn" data-send>${icons.send} Send</button></div>`);
  $('[data-send]', el).addEventListener('click', async (e) => {
    const message = $('#bm', el).value.trim();
    if (!message) { toast('Please write a message.'); return; }
    const { recipients } = await busy(e.currentTarget, () => api('/api/admin/broadcast', { method: 'POST', body: { date, period: $('#bp', el).value || null, message } }));
    close();
    toast(`Message sent to ${plural(recipients, 'visitor')}.`);
  });
}

// ---- Security staff ------------------------------------------------------------------

async function securityView(ctx) {
  let q = '';
  let tab = 'pending';
  header('Security staff', 'Approve new staff, call them, or remove access.',
    `<div class="segments" style="max-width:960px;margin:16px auto 0"><button data-s="pending">Waiting</button><button data-s="active">Active</button><button data-s="removed">Removed</button></div>`);
  ctx.el.innerHTML = `<div class="search" style="margin-bottom:10px">${icons.search}<input id="q" type="search" placeholder="Search name or phone" autocomplete="off"></div><div id="list"></div>`;
  const load = async () => {
    const { staff } = await api(`/api/admin/security${q ? `?q=${encodeURIComponent(q)}` : ''}`);
    if (!ctx.isCurrent()) return;
    const groups = { pending: staff.filter((s) => s.status === 'pending'), active: staff.filter((s) => s.status === 'active'), removed: staff.filter((s) => ['revoked', 'rejected'].includes(s.status)) };
    $$('#heroExtra [data-s]').forEach((b) => { b.classList.toggle('on', b.dataset.s === tab); b.textContent = `${{ pending: 'Waiting', active: 'Active', removed: 'Removed' }[b.dataset.s]} (${groups[b.dataset.s].length})`; });
    const list = groups[tab];
    $('#list', ctx.el).innerHTML = list.length ? `<div class="card flush">${list.map((s) => `
      <div class="person" data-id="${s.id}" style="flex-wrap:wrap">
        ${photoTag(s.photo, s.name, 'lg')}
        <div class="grow"><div class="name">${esc(s.name)}</div><div class="meta">${esc(formatPhone(s.phone))}</div>
          <div class="meta">${s.status === 'active' ? `Let in ${plural(s.checkinsToday, 'group')} today` : `Registered ${esc(formatWhen(s.createdAt))}`}${s.reviewedBy ? ` · by ${esc(s.reviewedBy)}` : ''}</div></div>
        <div class="contact">${contactButtons(s.phone)}</div>
        <div class="actions" style="width:100%;margin-top:6px">
          ${s.status === 'pending' ? `<button class="btn small" data-a="approve">${icons.check} Approve</button><button class="btn small danger" data-a="reject">Reject</button>` : ''}
          ${s.status === 'active' ? `<button class="btn small danger" data-a="revoke">${icons.x} Remove access</button>` : ''}
          ${['revoked', 'rejected'].includes(s.status) ? `<button class="btn small" data-a="approve">Give access again</button>` : ''}
        </div>
      </div>`).join('')}</div>` : `<div class="card empty">${{ pending: 'No one is waiting.', active: 'No active security staff yet.', removed: 'No one here.' }[tab]}</div>`;
  };
  $('#heroExtra').onclick = (e) => { const b = e.target.closest('[data-s]'); if (b) { tab = b.dataset.s; load(); } };
  ctx.onCleanup(() => { $('#heroExtra').onclick = null; });
  let t;
  $('#q', ctx.el).addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => { q = e.target.value.trim(); load(); }, 250); });
  $('#list', ctx.el).addEventListener('click', async (e) => {
    const b = e.target.closest('[data-a]');
    if (!b) return;
    const id = b.closest('[data-id]').dataset.id;
    const name = $('.name', b.closest('[data-id]')).textContent;
    if (b.dataset.a !== 'approve' && !await confirmSheet({ title: b.dataset.a === 'revoke' ? `Remove ${name}'s access?` : `Reject ${name}?`, message: 'They will not be able to scan passes.', confirm: 'Yes', danger: true })) return;
    await busy(b, () => api(`/api/admin/security/${id}/${b.dataset.a}`, { method: 'POST' }));
    toast({ approve: `${name} can now scan passes.`, revoke: `${name}'s access was removed.`, reject: 'Rejected.' }[b.dataset.a]);
    load();
    refreshBadges();
  });
  await load();
  onChanged(ctx, load);
}

// ---- More ----------------------------------------------------------------------------

function moreView(ctx) {
  header('More');
  const link = (href, icon, title, sub) => `<a class="person item-link" href="${href}"><span class="photo" style="width:44px;height:44px;border-radius:12px">${icon}</span><div class="grow"><div class="name">${title}</div><div class="meta">${sub}</div></div>${icons.next.replace('<svg', '<svg width="20" height="20" style="color:var(--muted)"')}</a>`;
  ctx.el.innerHTML = `
    <div class="card row">${photoTag(user.photo, user.name, 'lg')}<div class="grow"><div style="font-weight:800;font-size:1.1rem">${esc(user.name)}</div><div class="muted small">${esc(formatPhone(user.phone))} · Admin</div></div></div>
    <div class="card flush">
      ${link('/security.html#/scan', icons.scan, 'Scan passes', 'Open the scanner')}
      ${link('#/sessions', icons.calendar, 'Open days and sessions', 'Choose days, Morning / Afternoon / Evening and places')}
      ${link('#/broadcast', icons.whatsapp, 'Send WhatsApp message', 'Tell a day\'s visitors about changes')}
      ${link('#/admins', icons.key, 'Admins', 'Add or remove admins')}
      ${link('#/outbox', icons.message, 'WhatsApp delivery', 'See sent and failed messages')}
    </div>
    <button class="btn danger block" data-logout>${icons.logout} Log out</button>`;
  $('[data-logout]', ctx.el).addEventListener('click', async () => {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
    setUser(null);
    location.hash = '#/login';
  });
}

async function sessionsView(ctx) {
  await ensureToday();
  header('Open days', 'Choose which days and times visitors can book, and how many people each can take.');
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  ctx.el.innerHTML = `
    <form class="card" id="add">
      <h2>Open more days</h2>
      <div class="two-col">
        <div><label for="from">From</label><input id="from" name="fromDate" type="date" value="${today}" required></div>
        <div><label for="to">To</label><input id="to" name="toDate" type="date" value="${addDays(today, 30)}" required></div>
      </div>
      <div class="label">Days of the week</div>
      <div class="chips">${DAYS.map((d, i) => `<label class="tag" style="margin:0;display:inline-flex;gap:6px;align-items:center;padding:8px 12px;font-size:.9rem"><input type="checkbox" name="wd" value="${i}" ${i ? 'checked' : ''} style="width:auto"> ${d}</label>`).join('')}</div>
      <div class="label">Times of day</div>
      <div class="chips">${Object.entries(config.periods).map(([k, p]) => `<label class="tag" style="margin:0;display:inline-flex;gap:6px;align-items:center;padding:8px 12px;font-size:.9rem"><input type="checkbox" name="period" value="${k}" checked style="width:auto"> ${esc(p.label)} <span class="muted">(from ${esc(p.opensAt)})</span></label>`).join('')}</div>
      <label for="cap">People per session</label>
      <input id="cap" name="capacity" type="number" min="1" max="10000" value="100" required>
      <div class="actions"><button class="btn block" type="submit">${icons.plus} Open these days</button></div>
    </form>
    <div class="section-title">Next 30 days</div><div id="list"></div>`;
  const load = async () => {
    const { sessions } = await api(`/api/admin/sessions?from=${today}&to=${addDays(today, 30)}`);
    if (!ctx.isCurrent()) return;
    const byDate = new Map();
    for (const s of sessions) byDate.set(s.date, [...(byDate.get(s.date) ?? []), s]);
    $('#list', ctx.el).innerHTML = byDate.size ? [...byDate].map(([date, list]) => `
      <div class="card"><h3>${esc(formatDate(date))}</h3>${list.map((s) => `
        <div class="session-row" data-id="${s.id}" style="grid-template-columns:auto 1fr auto">
          <strong style="min-width:92px">${esc(s.label)}</strong>
          <div><div class="meter"><span style="width:${Math.min(100, Math.round((s.booked / s.capacity) * 100))}%"></span></div>
            <div class="small muted" style="margin-top:4px">${s.booked} of ${s.capacity} places taken${s.is_closed ? ' · <strong style="color:var(--red)">Closed</strong>' : ''}</div></div>
          <button class="btn small light" data-edit>${icons.edit}</button>
        </div>`).join('')}</div>`).join('') : '<div class="card empty">No days open yet. Use the form above.</div>';
  };
  $('#add', ctx.el).addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const body = {
      fromDate: f.fromDate.value, toDate: f.toDate.value, capacity: Number(f.capacity.value),
      weekdays: $$('[name=wd]:checked', f).map((i) => Number(i.value)), periods: $$('[name=period]:checked', f).map((i) => i.value),
    };
    const { created, skipped } = await busy($('button[type=submit]', f), () => api('/api/admin/sessions', { method: 'POST', body }));
    toast(`${plural(created, 'session')} opened${skipped ? ` (${skipped} already open)` : ''}.`);
    load();
  });
  $('#list', ctx.el).addEventListener('click', async (e) => {
    const row = e.target.closest('[data-edit]')?.closest('[data-id]');
    if (!row) return;
    const id = row.dataset.id;
    const { sessions } = await api(`/api/admin/sessions?from=${today}&to=${addDays(today, 30)}`);
    const s = sessions.find((x) => x.id === Number(id));
    const { el, close } = openSheet(`<h2 style="margin:0 0 4px">${esc(formatDate(s.date))} · ${esc(s.label)}</h2><p class="sub">${s.booked} places taken.</p>
      <label for="ec">People allowed</label><input id="ec" type="number" min="1" max="10000" value="${s.capacity}">
      <div class="actions"><button class="btn" data-save>Save</button></div>
      <div class="actions">
        <button class="btn ${s.is_closed ? '' : 'amber'}" data-toggle>${s.is_closed ? 'Open for booking' : 'Close for booking'}</button>
        ${s.bookings ? '' : `<button class="btn danger" data-del>${icons.trash} Delete</button>`}
      </div>`);
    const patch = async (b, body, msg) => { await busy(b, () => api(`/api/admin/sessions/${id}`, { method: 'PATCH', body })); close(); toast(msg); load(); };
    $('[data-save]', el).addEventListener('click', (ev) => patch(ev.currentTarget, { capacity: Number($('#ec', el).value) }, 'Saved.'));
    $('[data-toggle]', el).addEventListener('click', (ev) => patch(ev.currentTarget, { closed: !s.is_closed }, s.is_closed ? 'Opened.' : 'Closed for booking.'));
    $('[data-del]', el)?.addEventListener('click', async (ev) => { await busy(ev.currentTarget, () => api(`/api/admin/sessions/${id}`, { method: 'DELETE' })); close(); toast('Deleted.'); load(); });
  });
  await load();
}

async function broadcastView(ctx) {
  await ensureToday();
  header('Send WhatsApp message', 'Tell everyone visiting on a day about a change of time, venue and so on.');
  let date = today;
  const render = async () => {
    const [{ broadcasts }, { stats }] = await Promise.all([api(`/api/admin/broadcasts?date=${date}`), api(`/api/admin/appointments?date=${date}&status=approved`)]);
    if (!ctx.isCurrent()) return;
    ctx.el.innerHTML = `
      <div class="card">
        <label for="d" style="margin-top:0">Day</label><input id="d" type="date" value="${date}">
        <p class="sub" style="margin-top:10px">${plural(stats.approved, 'confirmed visitor')} on this day (${plural(stats.people, 'person', 'people')}).</p>
        <button class="btn block" data-new ${stats.approved ? '' : 'disabled'}>${icons.whatsapp} Write a message</button>
      </div>
      <div class="section-title">Sent for this day</div>
      <div class="card flush">${broadcasts.length ? broadcasts.map((b) => `<div class="person" style="align-items:flex-start"><div class="grow"><div style="white-space:pre-wrap">${esc(b.body)}</div>
        <div class="meta" style="margin-top:4px">To ${plural(b.recipients, 'visitor')}${b.period ? ` (${esc(config.periods[b.period].label)})` : ''} · by ${esc(b.sent_by_name)} · ${esc(formatWhen(b.created_at))}</div></div></div>`).join('') : '<div class="empty">No messages sent for this day.</div>'}</div>`;
    $('#d', ctx.el).addEventListener('change', (e) => { date = e.target.value || today; render(); });
    $('[data-new]', ctx.el).addEventListener('click', () => broadcastSheet(date));
  };
  await render();
}

async function adminsView(ctx) {
  header('Admins', 'Admins log in with their WhatsApp number.');
  const load = async () => {
    const { admins } = await api('/api/admin/admins');
    if (!ctx.isCurrent()) return;
    ctx.el.innerHTML = `
      <form class="card" id="add">
        <h2>Add an admin</h2>
        <label for="an">Name</label><input id="an" name="name" maxlength="80">
        <label for="ap">WhatsApp number</label><div class="phone-field"><span>+91</span><input id="ap" name="phone" type="tel" inputmode="tel" maxlength="20" required></div>
        <div class="actions"><button class="btn block" type="submit">${icons.plus} Add admin</button></div>
      </form>
      <div class="card flush">${admins.map((a) => `<div class="person">${photoTag(a.photo, a.name)}<div class="grow"><div class="name">${esc(a.name ?? 'Not logged in yet')}${a.id === user.id ? ' (you)' : ''}</div><div class="meta">${esc(formatPhone(a.phone))}</div></div>
        ${a.id === user.id ? '' : `<button class="btn small danger" data-remove="${a.id}">Remove</button>`}</div>`).join('')}</div>`;
    $('#add', ctx.el).addEventListener('submit', async (e) => {
      e.preventDefault();
      await busy($('button', e.target), () => api('/api/admin/admins', { method: 'POST', body: { name: e.target.name.value, phone: e.target.phone.value } }));
      toast('Admin added. They can now log in with their WhatsApp number.');
      load();
    });
    ctx.el.querySelectorAll('[data-remove]').forEach((b) => b.addEventListener('click', async () => {
      if (!await confirmSheet({ title: 'Remove this admin?', confirm: 'Remove', danger: true })) return;
      await busy(b, () => api(`/api/admin/admins/${b.dataset.remove}`, { method: 'DELETE' }));
      load();
    }));
  };
  await load();
}

async function outboxView(ctx) {
  header('WhatsApp delivery', 'The latest messages sent by the app.');
  const { messages } = await api('/api/admin/outbox');
  if (!ctx.isCurrent()) return;
  const chip = { sent: 'approved', failed: 'rejected', queued: 'pending', sending: 'pending', logged: 'hold' };
  const word = { sent: 'Sent', failed: 'Failed', queued: 'Waiting', sending: 'Sending', logged: 'Not sent (WhatsApp not set up)' };
  ctx.el.innerHTML = `<div class="card flush">${messages.length ? messages.map((m) => `<div class="person" style="align-items:flex-start"><div class="grow">
    <div class="row" style="justify-content:space-between"><span class="name">${esc(formatPhone(m.recipient))}</span><span class="status ${chip[m.status]}">${esc(word[m.status])}</span></div>
    <div class="small" style="margin-top:4px">${esc(m.preview)}</div>
    <div class="meta">${esc(formatWhen(m.created_at))}${m.error ? ` · ${esc(m.error)}` : ''}</div></div></div>`).join('') : '<div class="empty">Nothing sent yet.</div>'}</div>`;
}

// ---- Boot -----------------------------------------------------------------------------

function loginView(ctx) {
  header('Admin', 'Log in with your WhatsApp number.');
  renderLogin(ctx.el, { onDone: (u) => {
    if (u.role !== 'admin') { location.href = homeFor(u); return; }
    setUser(u);
    location.hash = u.profileComplete ? '#/home' : '#/setup';
  } });
}

function setupView(ctx) {
  header('Welcome', 'Add your name and photo once.');
  renderProfileSetup(ctx.el, user, { onDone: (u) => { setUser(u); location.hash = '#/home'; } });
}

const router = createRouter({
  outlet,
  fallback: '#/home',
  routes: [
    { path: /^#\/login$/, view: loginView, public: true },
    { path: /^#\/setup$/, view: setupView, setup: true },
    { path: /^#\/home$/, view: homeView, tab: 'home' },
    { path: /^#\/requests(\?hold)?$/, view: requestsView, tab: 'requests' },
    { path: /^#\/visitors$/, view: visitorsView, tab: 'visitors' },
    { path: /^#\/security$/, view: securityView, tab: 'security' },
    { path: /^#\/more$/, view: moreView, tab: 'more' },
    { path: /^#\/sessions$/, view: sessionsView, tab: 'more' },
    { path: /^#\/broadcast$/, view: broadcastView, tab: 'more' },
    { path: /^#\/admins$/, view: adminsView, tab: 'more' },
    { path: /^#\/outbox$/, view: outboxView, tab: 'more' },
  ],
  guard: (route) => {
    if (!user) return route.public ? null : '#/login';
    if (route.public) return '#/home';
    if (!user.profileComplete && !route.setup) return '#/setup';
    return null;
  },
  onChange: (route) => $$('[data-tab]').forEach((a) => a.classList.toggle('on', a.dataset.tab === route.tab)),
});

[config, { user }] = await Promise.all([api('/api/config'), api('/api/auth/me')]);
if (user && user.role !== 'admin') location.replace(homeFor(user));
else {
  setUser(user);
  router.run();
}
