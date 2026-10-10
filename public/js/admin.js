import {
  $, $$, api, esc, formatDate, formatShortDate, formatPhone, formatTime, formatWhen, addDays, plural, statusChip, photoTag,
  contactButtons, toast, openSheet, confirmSheet, busy, throttle, createRouter, goBack, liveStream, homeFor, wrongAccount, PERIOD_ICONS, phoneField, isTenDigits,
  visitTimer, stars, askForAlerts, registerServiceWorker,
} from './common.js';
import { reportHtml, shareReport, saveReportPdf } from './report.js';
import { icons } from './icons.js';
import { renderProfileSetup } from './login.js';
import { photoPicker } from './photo.js';
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
  if (ready && u.role === 'admin') askForAlerts(config.vapidPublicKey, 'Get an alert on this phone when someone asks for a visit.');
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
  // Also once a minute, so "min left" timers and "Inside now" stay current.
  const timer = setInterval(handler, 60000);
  ctx.onCleanup(() => { window.removeEventListener('admin:changed', handler); clearInterval(timer); });
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
      <div style="margin-top:6px" class="chips">${statusChip(a.status, a.checkedInAt)}${visitTimer(a)}${a.express ? '<span class="status express">⚡ Express</span>' : ''}</div></div>
      <div class="contact" style="display:flex;flex-direction:column;gap:8px">${contactButtons(a.phone)}</div></div>
    <dl class="details">
      <dt>Day</dt><dd><strong>${esc(formatShortDate(a.date))} · ${esc(a.periodLabel)}</strong></dd>
      <dt>People</dt><dd><strong>${esc(plural(a.peopleCount, 'person', 'people'))}</strong></dd>
      ${a.people.length ? `<dt>With</dt><dd>${a.people.map((p) => `${esc(p.name)} · <a href="tel:${esc(p.phone)}">${esc(formatPhone(p.phone))}</a>`).join('<br>')}</dd>` : ''}
      ${a.reference || a.refPhone ? `<dt>Reference</dt><dd>
        <div class="row" style="align-items:flex-start;gap:8px"><div class="grow"><strong>${esc(a.reference || '—')}</strong>${a.refDesignation ? `<br><span class="muted">${esc(a.refDesignation)}</span>` : ''}${a.refPhone ? `<br><span class="muted">${esc(formatPhone(a.refPhone))}</span>` : ''}</div>
        ${a.refPhone ? `<div class="contact" style="display:flex;gap:6px">${contactButtons(a.refPhone)}</div>` : ''}</div></dd>` : ''}
      ${a.express ? `<dt>Express pass</dt><dd>Created by ${esc(a.createdBy ?? 'an admin')}</dd>` : ''}
      ${a.purposes.length ? `<dt>Purpose</dt><dd>${a.purposes.map((p) => `<span class="tag">${esc(p)}</span>`).join(' ')}</dd>` : ''}
      ${a.description ? `<dt>Details</dt><dd>${esc(a.description)}</dd>` : ''}
      ${a.adminNote ? `<dt>Note</dt><dd>${esc(a.adminNote)}</dd>` : ''}
      ${a.checkedInAt ? `<dt>Checked in</dt><dd><strong>${esc(formatTime(a.checkedInAt))}</strong>${a.checkedInBy ? ` by ${esc(a.checkedInBy)}` : ''}<br>${esc(`${a.checkedInCount} of ${plural(a.peopleCount, 'person', 'people')} came`)}</dd>` : ''}
      ${a.feedbackRating ? `<dt>Feedback</dt><dd>${stars(a.feedbackRating, 18)}${a.feedbackComment ? `<br>“${esc(a.feedbackComment)}”` : ''}</dd>` : ''}
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

// One-tap buttons for how many of the group came in.
export function countButtons(max, selected) {
  return `<div class="count-picker" role="group" aria-label="How many came">${Array.from({ length: max }, (_, i) => i + 1)
    .map((n) => `<button type="button" data-count="${n}" class="${n === selected ? 'on' : ''}" aria-pressed="${n === selected}">${n}</button>`).join('')}</div>`;
}

function openAppointment(a, onChange) {
  const countEdit = a.checkedInAt && a.peopleCount > 1 ? `<div class="label">How many came?</div>${countButtons(a.peopleCount, a.checkedInCount)}` : '';
  const { el, close } = openSheet(`${apptDetails(a)}${countEdit}${apptActions(a)}<button class="btn ghost block" data-close style="margin-top:8px">Close</button>`);
  el.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-count]');
    if (!b) return;
    await busy(b, () => api('/api/staff/count', { method: 'POST', body: { appointmentId: a.id, count: Number(b.dataset.count) } }));
    toast(`Updated: ${plural(Number(b.dataset.count), 'person', 'people')} came.`);
    close();
    onChange();
  });
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
        <div class="kpi inside"><div class="l">Inside now</div><div class="v">${s.insideNow}</div></div>
      </div>
      <div class="actions" style="margin-top:14px"><a class="btn blue" href="#/express">⚡ Express pass</a><a class="btn light" href="#/report">📊 Day report</a><a class="btn light" href="#/sessions">${icons.calendar} Slots</a></div>
      <div style="margin-top:14px">
        ${s.pending ? `<a class="alert-link" href="#/requests"><span class="count">${s.pending}</span>New requests to review${icons.next}</a>` : ''}
        ${s.hold ? `<a class="alert-link" href="#/requests?hold"><span class="count violet">${s.hold}</span>Requests on hold${icons.next}</a>` : ''}
        ${s.securityPending ? `<a class="alert-link" href="#/security"><span class="count blue">${s.securityPending}</span>Security staff waiting for approval${icons.next}</a>` : ''}
      </div>
      <div class="two-col">
        <div class="card">
          <div class="row" style="justify-content:space-between"><h2>Sessions</h2><a class="small" href="#/sessions">Manage slots</a></div>
          ${d.sessions.length ? d.sessions.map((x) => {
            const p = x.people ? Math.round((x.checkedInPeople / x.people) * 100) : 0;
            return `<div class="session-row"><div class="row" style="gap:8px"><span style="color:var(--blue-700);display:grid">${PERIOD_ICONS[x.period].replace('<svg', '<svg width="20" height="20"')}</span><strong>${esc(x.label)}</strong></div>
              <div class="meter" title="${x.checkedInPeople} of ${x.people} people"><span style="width:${p}%"></span></div>
              <span class="n">${x.checkedInPeople} / ${x.people}</span></div>`;
          }).join('') + '<div class="small muted" style="margin-top:6px">People checked in / people confirmed</div>' : '<div class="empty">No sessions open on this day. <a href="#/sessions">Bookings &amp; slots</a></div>'}
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
          <div class="meta">${esc(plural(a.checkedInCount ?? a.peopleCount, 'person', 'people'))} · ${esc(a.periodLabel)}${a.checkedInBy ? ` · by ${esc(a.checkedInBy)}` : ''}</div></div>
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
    <div class="card flush" id="list" style="margin-top:8px"></div>`;
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
        <div class="grow"><div class="name">${esc(a.name)}${a.express ? ' <span class="status express" style="font-size:.7rem;padding:2px 7px">⚡ Express</span>' : ''}</div>
          <div class="meta">${esc(a.periodLabel)} · ${a.checkedInAt && a.checkedInCount !== a.peopleCount ? `${a.checkedInCount} of ${a.peopleCount} came` : esc(plural(a.peopleCount, 'person', 'people'))}${a.checkedInAt ? ` · in at ${esc(formatTime(a.checkedInAt))}${a.checkedInBy ? ` by ${esc(a.checkedInBy)}` : ''}` : ''}</div>
          <div style="margin-top:4px" class="chips">${statusChip(a.status, a.checkedInAt)}${visitTimer(a)}${a.feedbackRating ? `<span class="status left">${stars(a.feedbackRating, 12)}</span>` : ''}</div></div>
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
  await load();
  onChanged(ctx, load);
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
        <div class="grow"><div class="name">${esc(s.name)}</div><div class="meta">${esc(formatPhone(s.phone))}${s.reference ? ` · Ref: ${esc(s.reference)}` : ''}</div>
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
      ${link('#/report', icons.list, 'Day report', 'People who came, scans, feedback · share or save')}
      ${link('#/feedback', icons.message, 'Feedback ⭐', 'Stars and notes from visitors')}
      ${link('#/sessions', icons.calendar, 'Bookings & slots', 'Open or close bookings, open days, set slots')}
      ${link('#/express', icons.ticket, 'Express pass', 'Let someone in today with just a name and number')}
      ${link('/security.html#/scan', icons.scan, 'Scan passes', 'Open the scanner')}
      ${link('#/admins', icons.key, 'Admins', 'Who can open the admin app')}
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
  header('Bookings & slots', 'Open or close bookings, and set how many people each session can take.');
  // New days default to 5 days: the chosen start date and the 4 days after it.
  const SPAN = 4;
  ctx.el.innerHTML = `
    <div class="card" id="master"><div class="spinner"></div></div>
    <details class="card" id="addBox">
      <summary style="font-weight:800;cursor:pointer;font-size:1.05rem">${icons.plus.replace('<svg', '<svg width="18" height="18" style="vertical-align:-3px"')} Open new days</summary>
      <form id="add">
        <div class="two-col">
          <div><label for="from">From</label><input id="from" name="fromDate" type="date" value="${today}" min="${today}" required></div>
          <div><label for="to">To</label><input id="to" name="toDate" type="date" value="${addDays(today, SPAN)}" min="${today}" required></div>
        </div>
        <div class="hint">Every day from the start date to the end date is opened.</div>
        <div class="label">Times of day</div>
        <div class="chips">${Object.entries(config.periods).map(([k, p]) => `<label class="tag pick"><input type="checkbox" name="period" value="${k}" checked> ${esc(p.label)}</label>`).join('')}</div>
        <label for="cap">Slots per session (people)</label>
        <input id="cap" name="capacity" type="number" min="1" max="10000" value="100" required inputmode="numeric">
        <div class="actions"><button class="btn block" type="submit">${icons.plus} Open these days</button></div>
      </form>
    </details>
    <div class="section-title">Next 30 days</div><div id="list"></div>`;

  const loadMaster = async () => {
    const st = await api('/api/admin/booking-status');
    if (!ctx.isCurrent()) return;
    $('#master', ctx.el).innerHTML = `
      <div class="row" style="align-items:flex-start">
        <div class="grow"><h2 style="margin:0">New bookings are ${st.open ? '<span style="color:var(--green-dark)">open</span>' : '<span style="color:var(--red)">closed</span>'}</h2>
          <p class="sub" style="margin:4px 0 0">${st.open ? 'Visitors can request appointments.' : 'Visitors see a "bookings are closed" message. Confirmed visits and express passes still work.'}</p></div>
        <button class="switch ${st.open ? 'on' : ''}" role="switch" aria-checked="${st.open}" aria-label="Accept new bookings" data-master></button>
      </div>
      ${st.open ? '' : `<label for="cm">Message shown to visitors</label><div class="row"><input id="cm" maxlength="200" value="${esc(st.message)}" placeholder="For example: Bookings reopen on Monday."><button class="btn small light" data-save-msg style="min-height:50px">Save</button></div>`}`;
    $('[data-master]', ctx.el).addEventListener('click', async (e) => {
      const open = !st.open;
      if (!open && !await confirmSheet({ title: 'Stop all new bookings?', message: 'Visitors will not be able to request appointments until you turn this back on.', confirm: 'Stop bookings', danger: true })) return;
      await busy(e.currentTarget, () => api('/api/admin/booking-status', { method: 'POST', body: { open, message: st.message } }));
      toast(open ? 'Bookings are open.' : 'Bookings are closed.');
      loadMaster();
    });
    $('[data-save-msg]', ctx.el)?.addEventListener('click', async (e) => {
      await busy(e.currentTarget, () => api('/api/admin/booking-status', { method: 'POST', body: { open: false, message: $('#cm', ctx.el).value } }));
      toast('Message saved.');
    });
  };

  let sessions = [];
  const load = async () => {
    ({ sessions } = await api(`/api/admin/sessions?from=${today}&to=${addDays(today, 30)}`));
    if (!ctx.isCurrent()) return;
    const byDate = new Map();
    for (const x of sessions) if (x.capacity > 0) byDate.set(x.date, [...(byDate.get(x.date) ?? []), x]);
    $('#list', ctx.el).innerHTML = byDate.size ? [...byDate].map(([date, list]) => {
      const allClosed = list.every((x) => x.is_closed);
      return `<div class="card" data-date="${date}">
        <div class="row" style="justify-content:space-between;margin-bottom:6px"><h3 style="margin:0">${esc(formatDate(date))}</h3>
          <button class="btn small ${allClosed ? '' : 'danger'}" data-day="${allClosed ? 'open' : 'close'}">${allClosed ? 'Open day' : 'Close day'}</button></div>
        ${list.map((x) => `
          <div class="slot-row ${x.is_closed ? 'closed' : ''}" data-id="${x.id}">
            <div class="slot-name"><span class="ic">${PERIOD_ICONS[x.period]}</span><div><strong>${esc(x.label)}</strong>
              <div class="small muted">${x.booked} booked${x.is_closed ? ' · <strong style="color:var(--red)">Closed</strong>' : ''}</div></div></div>
            <div class="slot-qty" aria-label="Slots">
              <button type="button" data-step="-1" aria-label="Fewer slots">${icons.minus}</button>
              <input type="number" inputmode="numeric" min="${Math.max(1, x.booked)}" max="10000" value="${x.capacity}" aria-label="Slots for ${esc(x.label)}">
              <button type="button" data-step="1" aria-label="More slots">${icons.plus}</button>
            </div>
            <button class="switch ${x.is_closed ? '' : 'on'}" role="switch" aria-checked="${!x.is_closed}" aria-label="${esc(x.label)} open for booking" data-toggle></button>
          </div>`).join('')}
        <div class="small muted" style="margin-top:6px">Slots = how many people can book. Switch off to stop bookings for that session.</div>
      </div>`;
    }).join('') : '<div class="card empty">No days open yet. Use "Open new days" above.</div>';
  };

  // The end date follows the start date (5 days) until it is changed by hand.
  const from = $('#from', ctx.el);
  const to = $('#to', ctx.el);
  let toEdited = false;
  to.addEventListener('input', () => { toEdited = true; });
  from.addEventListener('input', () => {
    if (!from.value) return;
    to.min = from.value;
    if (!toEdited || to.value < from.value) to.value = addDays(from.value, SPAN);
  });

  $('#add', ctx.el).addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const body = {
      fromDate: f.fromDate.value, toDate: f.toDate.value, capacity: Number(f.capacity.value),
      periods: $$('[name=period]:checked', f).map((i) => i.value),
    };
    if (body.toDate < body.fromDate) { toast('The end date must be on or after the start date.'); return; }
    if (!body.periods.length) { toast('Please choose Morning, Evening or both.'); return; }
    const { created, skipped } = await busy($('button[type=submit]', f), () => api('/api/admin/sessions', { method: 'POST', body }));
    toast(`${plural(created, 'session')} opened${skipped ? ` (${skipped} already open)` : ''}.`);
    $('#addBox', ctx.el).open = false;
    load();
  });

  // Slot changes save on their own, shortly after the last tap.
  const timers = {};
  const saveQty = (row) => {
    clearTimeout(timers[row.dataset.id]);
    timers[row.dataset.id] = setTimeout(async () => {
      const input = $('input', row);
      const capacity = Number(input.value);
      const x = sessions.find((y) => y.id === Number(row.dataset.id));
      if (!Number.isInteger(capacity) || capacity < 1) { input.value = x.capacity; return; }
      if (capacity < x.booked) { toast(`${x.booked} people are already booked. Slots can't be fewer than that.`); input.value = x.capacity; return; }
      try {
        await api(`/api/admin/sessions/${x.id}`, { method: 'PATCH', body: { capacity } });
        x.capacity = capacity;
        toast(`${x.label}: ${capacity} slots.`);
      } catch (err) { toast(err.message); input.value = x.capacity; }
    }, 700);
  };
  $('#list', ctx.el).addEventListener('click', async (e) => {
    const row = e.target.closest('[data-id]');
    const step = e.target.closest('[data-step]');
    if (step && row) {
      const input = $('input', row);
      input.value = Math.max(1, Number(input.value || 0) + Number(step.dataset.step) * (Number(input.value) >= 50 ? 5 : 1));
      saveQty(row);
      return;
    }
    if (e.target.closest('[data-toggle]') && row) {
      const x = sessions.find((y) => y.id === Number(row.dataset.id));
      await busy(e.target.closest('[data-toggle]'), () => api(`/api/admin/sessions/${x.id}`, { method: 'PATCH', body: { closed: !x.is_closed } }));
      toast(`${x.label} ${x.is_closed ? 'opened' : 'closed'} for booking.`);
      load();
      return;
    }
    const day = e.target.closest('[data-day]');
    if (day) {
      const date = day.closest('[data-date]').dataset.date;
      await busy(day, () => api('/api/admin/sessions/day', { method: 'POST', body: { date, closed: day.dataset.day === 'close' } }));
      toast(`${formatShortDate(date)} ${day.dataset.day === 'close' ? 'closed' : 'opened'} for booking.`);
      load();
    }
  });
  $('#list', ctx.el).addEventListener('change', (e) => { const row = e.target.closest('[data-id]'); if (row && e.target.matches('input')) saveQty(row); });
  await Promise.all([loadMaster(), load()]);
}

async function adminsView(ctx) {
  header('Admins', 'The references are the admins. They log in with their number and the admin password.');
  const { admins } = await api('/api/admin/admins');
  if (!ctx.isCurrent()) return;
  ctx.el.innerHTML = `
    <div class="notice info" style="margin-bottom:14px">${icons.info}<span>This list is fixed. To add or remove an admin, ask the app developer to change the reference list.</span></div>
    <div class="card flush">${admins.map((a) => `<div class="person">${photoTag(a.photo, a.name)}<div class="grow"><div class="name">${esc(a.name ?? '')}${a.id === user.id ? ' (you)' : ''}</div><div class="meta">${esc(formatPhone(a.phone))}</div></div></div>`).join('')}</div>`;
}

// ---- Day report and feedback -------------------------------------------------------

let reportDate = null;
async function reportView(ctx) {
  await ensureToday();
  reportDate ??= today;
  header('Day report', 'Share as picture or PDF');
  dayNav(reportDate, (d) => { reportDate = d; reportView(ctx); });
  const r = await api(`/api/admin/report?date=${reportDate}`);
  if (!ctx.isCurrent()) return;
  ctx.el.innerHTML = `
    <div class="actions report-actions" style="margin:0 0 14px">
      <button class="btn" data-share>${icons.send} Share picture</button>
      <button class="btn light" data-print>${icons.list} Download PDF</button>
    </div>
    ${reportHtml(r)}`;
  $('[data-share]', ctx.el).addEventListener('click', async (e) => {
    const how = await busy(e.currentTarget, () => shareReport(r));
    if (how === 'downloaded') toast('Picture saved ✓');
  });
  $('[data-print]', ctx.el).addEventListener('click', async (e) => {
    const how = await busy(e.currentTarget, () => saveReportPdf(r));
    if (how === 'downloaded') toast('PDF saved ✓');
  });
}

async function feedbackView(ctx) {
  header('Feedback ⭐', 'What visitors said');
  const f = await api('/api/admin/feedback');
  if (!ctx.isCurrent()) return;
  const max = Math.max(1, ...f.stars);
  ctx.el.innerHTML = f.count ? `
    <div class="card"><div class="row" style="gap:18px;align-items:center">
      <div class="center"><div class="big-rating">${f.average}</div><div>${stars(Math.round(f.average), 20)}</div><div class="small muted">${plural(f.count, 'rating')}</div></div>
      <div class="grow">${[5, 4, 3, 2, 1].map((n) => `<div class="star-row"><span>${n}★</span><div class="meter amber"><span style="width:${Math.round((f.stars[n - 1] / max) * 100)}%"></span></div><span class="n">${f.stars[n - 1]}</span></div>`).join('')}</div>
    </div></div>
    <div class="card flush">${f.feedback.map((x) => `<div class="person" style="align-items:flex-start">${photoTag(x.photo, x.name)}
      <div class="grow"><div class="row" style="justify-content:space-between"><span class="name">${esc(x.name)}</span><span>${stars(x.rating, 14)}</span></div>
      ${x.comment ? `<div style="margin-top:4px">“${esc(x.comment)}”</div>` : ''}
      <div class="meta">${esc(formatShortDate(x.date))} · ${esc(x.periodLabel)}${x.reference ? ` · Ref: ${esc(x.reference)}` : ''}</div></div></div>`).join('')}</div>`
    : '<div class="card center"><div class="big-icon wait">⭐</div><h2>No feedback yet</h2><p class="sub">Visitors can rate their visit 30 minutes after check-in.</p></div>';
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

// ---- Express pass ----------------------------------------------------------------------

async function expressView(ctx) {
  header('Express pass', 'Let someone in today. The QR pass is sent on WhatsApp straight away.');
  let photo = null;
  let count = 1;
  const purposes = new Set();
  // The admin is usually the reference themselves.
  const mine = config.references.find((r) => r.name === user.name)?.id ?? '';
  ctx.el.innerHTML = `
    <form class="card" novalidate>
      <label for="xr" style="margin-top:0">Reference</label>
      <select id="xr">
        <option value="">No reference</option>
        ${config.references.map((r) => `<option value="${esc(r.id)}" ${r.id === mine ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}
      </select>
      <label for="xn">Name <span class="muted small">(required)</span></label>
      <input id="xn" maxlength="80" autocomplete="off" placeholder="Full name">
      <label for="xp">WhatsApp number <span class="muted small">(required)</span></label>
      ${phoneField('xp')}
      <details style="margin-top:18px">
        <summary style="font-weight:700;cursor:pointer;padding:6px 0">More details <span class="muted small">(optional)</span></summary>
        <div class="label">How many people?</div>
        <div class="stepper"><button type="button" data-dec aria-label="Fewer">${icons.minus}</button><span class="n" data-num>1</span><button type="button" data-inc aria-label="More">${icons.plus}</button><span class="muted small">Up to ${config.maxPeople}</span></div>
        <div class="label">Photo</div>
        <div data-photo></div>
        <div class="label">Purpose</div>
        <div class="choices">${Object.entries(config.purposes).map(([k, l]) => `<button type="button" class="choice check" data-purpose="${k}"><span class="t" style="font-weight:600">${esc(l)}</span><span class="tick">${icons.check}</span></button>`).join('')}</div>
        <label for="xd">Note</label><textarea id="xd" maxlength="500"></textarea>
      </details>
      <div data-error></div>
      <div class="actions"><button class="btn block" type="submit">${icons.whatsapp} Create and send pass</button></div>
    </form>`;
  const form = $('form', ctx.el);
  photoPicker($('[data-photo]', ctx.el), { prompt: 'Optional: a photo helps security recognise them.', onChange: (b) => { photo = b; } });
  const setCount = (n) => { count = Math.max(1, Math.min(config.maxPeople, n)); $('[data-num]', ctx.el).textContent = count; };
  $('[data-dec]', ctx.el).addEventListener('click', () => setCount(count - 1));
  $('[data-inc]', ctx.el).addEventListener('click', () => setCount(count + 1));
  $$('[data-purpose]', ctx.el).forEach((b) => b.addEventListener('click', () => {
    const k = b.dataset.purpose;
    purposes.has(k) ? purposes.delete(k) : purposes.add(k);
    b.classList.toggle('on', purposes.has(k));
  }));
  const submit = async (button, force = false) => {
    const err = $('[data-error]', ctx.el);
    err.innerHTML = '';
    const problem = !$('#xn', ctx.el).value.trim() ? 'Please enter their name.'
      : !isTenDigits($('#xp', ctx.el).value) ? 'Please enter their 10-digit WhatsApp number.' : '';
    if (problem) { err.innerHTML = `<div class="notice bad" style="margin-top:12px">${icons.alert}<span>${esc(problem)}</span></div>`; return; }
    try {
      let photoName = null;
      if (photo) photoName = (await busy(button, () => api('/api/admin/photos', { method: 'POST', raw: photo }))).photo;
      const { appointment: a } = await busy(button, () => api('/api/admin/express', { method: 'POST', body: {
        name: $('#xn', ctx.el).value, phone: $('#xp', ctx.el).value, peopleCount: count, photo: photoName,
        referenceId: $('#xr', ctx.el).value,
        purposes: [...purposes], description: $('#xd', ctx.el).value, force,
      } }));
      const { el } = openSheet(`<div class="center">
        <div class="big-icon ok">${icons.checkCircle}</div>
        <h2>Express pass sent</h2>
        <p class="sub"><strong>${esc(a.name)}</strong> (${esc(plural(a.peopleCount, 'person', 'people'))}) will get the QR pass on WhatsApp at ${esc(formatPhone(a.phone))}. It is valid for the rest of today and can be scanned once.</p></div>
        <div class="actions"><button class="btn light" data-close>Done</button><button class="btn" data-another>${icons.plus} Another pass</button></div>`, { onClose: () => expressView(ctx) });
      $('[data-another]', el).addEventListener('click', () => $('[data-close]', el).click());
    } catch (e) {
      if (e.status === 409 && e.data?.conflicts) {
        if (await confirmSheet({ title: 'Already has an appointment', message: e.message, confirm: 'Create express pass anyway' })) submit(button, true);
        return;
      }
      err.innerHTML = `<div class="notice bad" style="margin-top:12px">${icons.alert}<span>${esc(e.message)}</span></div>`;
    }
  };
  form.addEventListener('submit', (e) => { e.preventDefault(); submit($('button[type=submit]', form)); });
}

// ---- Boot -----------------------------------------------------------------------------

// Admins log in with their phone number and the admin password.
function loginView(ctx, error = '') {
  header('Admin', 'Log in with your phone number and password.');
  ctx.el.innerHTML = `
    <form class="card narrow" novalidate>
      <h2>Admin login</h2>
      <label for="phone">Phone number</label>
      ${phoneField('phone')}
      <label for="password">Password</label>
      <input id="password" type="password" autocomplete="current-password" maxlength="100">
      ${error ? `<div class="notice bad" style="margin-top:12px">${icons.alert}<span>${esc(error)}</span></div>` : ''}
      <div class="actions"><button class="btn block" type="submit">${icons.key} Log in</button></div>
    </form>
    <p class="center small muted" style="margin-top:18px">Visiting Gurudev? <a href="/">Book a visit here</a></p>`;
  const form = $('form', ctx.el);
  $('#phone', ctx.el).focus();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const phone = $('#phone', ctx.el).value;
    const password = $('#password', ctx.el).value;
    if (!isTenDigits(phone)) return loginView(ctx, 'Please enter your 10-digit phone number.');
    if (!password) return loginView(ctx, 'Please enter the password.');
    try {
      const { user: u } = await busy($('button', form), () => api('/api/auth/password', { method: 'POST', body: { phone, password } }), { quiet: true });
      setUser(u);
      location.hash = u.profileComplete ? '#/home' : '#/setup';
    } catch (err) {
      loginView(ctx, err.message);
      $('#phone', ctx.el).value = phone;
      $('#password', ctx.el).focus();
    }
  });
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
    { path: /^#\/express$/, view: expressView, tab: 'home', back: '#/home' },
    { path: /^#\/sessions$/, view: sessionsView, tab: 'more', back: '#/more' },
    { path: /^#\/admins$/, view: adminsView, tab: 'more', back: '#/more' },
    { path: /^#\/outbox$/, view: outboxView, tab: 'more', back: '#/more' },
    { path: /^#\/report$/, view: reportView, tab: 'home', back: '#/home' },
    { path: /^#\/feedback$/, view: feedbackView, tab: 'more', back: '#/more' },
  ],
  guard: (route) => {
    if (!user) return route.public ? null : '#/login';
    if (route.public) return '#/home';
    if (!user.profileComplete && !route.setup) return '#/setup';
    return null;
  },
  onChange: (route) => $$('[data-tab]').forEach((a) => a.classList.toggle('on', a.dataset.tab === route.tab)),
});

registerServiceWorker();
[config, { user }] = await Promise.all([api('/api/config'), api('/api/auth/me')]);
if (user && user.role !== 'admin') { header('Admin'); wrongAccount(outlet, user, 'admins'); }
else {
  setUser(user);
  router.run();
}
