import {
  $, $$, api, esc, formatDate, formatShortDate, formatSlot, formatTimestamp, formatClock, statusChip, toast, setBusy,
  createRouter, authView, liveStream,
} from './common.js';
import { icons } from './icons.js';
import { renderChart, legendHtml } from './chart.js';

const outlet = $('#app');
let me = null;
let stopStream = null;

const TABS = [
  ['dashboard', 'Dashboard', icons.chart],
  ['requests', 'Requests', icons.inbox],
  ['scan', 'Scan', icons.scan],
  ['messages', 'Messages', icons.chat],
  ['manage', 'Manage', icons.settings],
];
for (const [key, label, icon] of TABS) {
  $(`[data-tab="${key}"]`).innerHTML = key === 'scan' ? `<span class="bubble">${icon}</span><span>${label}</span>` : `${icon}<span>${label}</span>`;
}

function setLoggedIn(user) {
  me = user;
  $('#tabbar').classList.toggle('hidden', !user);
  $('#live').classList.toggle('hidden', !user);
  stopStream?.();
  stopStream = null;
  if (user) {
    stopStream = liveStream('/api/admin/stream', {
      changed: (e) => { refreshBadges(); window.dispatchEvent(new CustomEvent('admin:changed', { detail: e })); },
    }, (up) => $('#live').classList.toggle('off', !up));
    refreshBadges();
  }
}

async function refreshBadges() {
  try {
    const { pending, unreadMessages } = await api('/api/admin/summary');
    for (const [tab, n] of [['requests', pending], ['messages', unreadMessages]]) {
      const link = $(`[data-tab="${tab}"]`);
      $('.dot', link)?.remove();
      if (n) link.insertAdjacentHTML('beforeend', `<span class="dot">${n}</span>`);
    }
  } catch (err) {
    if (err.status === 401 || err.status === 403) { setLoggedIn(null); location.hash = '#/login'; }
  }
}

// Calls `fn` whenever the server reports a change of one of `kinds`.
function onChanged(ctx, kinds, fn) {
  const handler = (e) => {
    if (!ctx.isCurrent() || (kinds && !kinds.includes(e.detail.kind))) return;
    if (document.activeElement?.matches('input, textarea')) return;
    fn(e.detail);
  };
  window.addEventListener('admin:changed', handler);
  ctx.onCleanup(() => window.removeEventListener('admin:changed', handler));
}

const addDays = (date, n) => {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};

// ---- Check-in sheet (used by the scanner and the dashboard) --------------------

function openAdmitSheet(lookupBody, { onClose } = {}) {
  const backdrop = document.createElement('div');
  backdrop.className = 'backdrop';
  const sheet = document.createElement('div');
  sheet.className = 'sheet';
  sheet.setAttribute('role', 'dialog');
  sheet.innerHTML = '<div class="grab"></div><div class="spinner"></div>';
  document.body.append(backdrop, sheet);
  const close = () => { backdrop.remove(); sheet.remove(); onClose?.(); };
  backdrop.addEventListener('click', close);

  const banner = (kind, icon, text) => `<div class="result-banner ${kind}">${icon}<span>${esc(text)}</span></div>`;
  const details = (a) => `
    <div class="appt-when">${esc(a.name)}</div>
    <dl class="detail">
      <dt>Time</dt><dd>${esc(formatDate(a.slot.date))}, ${esc(a.slot.start_time)}–${esc(a.slot.end_time)}</dd>
      <dt>Phone</dt><dd><a href="tel:${esc(a.phone)}">${esc(a.phone)}</a></dd>
      <dt>Purpose</dt><dd>${esc(a.purpose)}</dd>
      ${a.admin_note ? `<dt>Note</dt><dd>${esc(a.admin_note)}</dd>` : ''}
      ${a.checked_in_at ? `<dt>Checked in</dt><dd>${esc(formatClock(a.checked_in_at))}${a.checked_in_by ? ` by ${esc(a.checked_in_by)}` : ''}</dd>` : ''}
    </dl>`;

  (async () => {
    let result;
    try {
      result = await api('/api/admin/checkin/lookup', { method: 'POST', body: lookupBody });
    } catch (err) {
      sheet.innerHTML = `<div class="grab"></div>${banner('bad', icons.x, err.message)}<button class="btn secondary block" data-close>Close</button>`;
      $('[data-close]', sheet).addEventListener('click', close);
      return;
    }
    const a = result.appointment;
    let head;
    if (!result.canAdmit) head = banner('bad', icons.x, a.checked_in_at ? 'Already checked in' : result.reason);
    else if (result.needsOverride) head = banner('warn', icons.alert, result.reason);
    else head = banner('good', icons.check, 'Valid pass — ready to admit');
    sheet.innerHTML = `<div class="grab"></div>${head}${details(a)}
      <div class="actions">
        ${result.canAdmit ? `<button class="btn ${result.needsOverride ? 'secondary' : 'ok'} block" data-admit>${icons.check} ${result.needsOverride ? 'Admit anyway' : 'Admit'}</button>` : ''}
        <button class="btn secondary block" data-close>${result.canAdmit ? 'Cancel' : 'Close'}</button>
      </div>`;
    $('[data-close]', sheet).addEventListener('click', close);
    $('[data-admit]', sheet)?.addEventListener('click', async (e) => {
      setBusy(e.currentTarget, true);
      try {
        const { appointment } = await api('/api/admin/checkin', { method: 'POST', body: { ...lookupBody, override: result.needsOverride } });
        sheet.innerHTML = `<div class="grab"></div>${banner('good', icons.check, `${appointment.name} is checked in`)}${details(appointment)}
          <div class="actions"><button class="btn block" data-close>Done</button></div>`;
        $('[data-close]', sheet).addEventListener('click', close);
        if (navigator.vibrate) navigator.vibrate(80);
      } catch (err) {
        toast(err.message);
        setBusy(e.currentTarget, false);
      }
    });
  })();
  return close;
}

// ---- Dashboard ------------------------------------------------------------------

let range = null; // { preset, from, to }

async function dashboardView(ctx) {
  ctx.el.innerHTML = `
    <div class="section-head" style="margin-top:0"><h1>Dashboard</h1></div>
    <div class="chip-row" id="presets">
      <button class="chip" data-preset="fortnight">Past week &amp; next 2 weeks</button>
      <button class="chip" data-preset="next30">Next 30 days</button>
      <button class="chip" data-preset="past30">Past 30 days</button>
    </div>
    <div id="dash"><div class="spinner"></div></div>`;
  let today = null;
  let lastDays = null;

  const rangeFor = (preset, t) => ({
    fortnight: { from: addDays(t, -6), to: addDays(t, 13) },
    next30: { from: t, to: addDays(t, 29) },
    past30: { from: addDays(t, -29), to: t },
  }[preset]);

  async function load() {
    const dash = $('#dash', ctx.el);
    $('.chart-card', dash)?.classList.add('stale');
    const query = range ? `?from=${range.from}&to=${range.to}` : '';
    const stats = await api(`/api/admin/stats${query}`);
    if (!ctx.isCurrent()) return;
    today = stats.today;
    if (!range) range = { preset: 'fortnight', ...rangeFor('fortnight', today) };
    $$('#presets .chip', ctx.el).forEach((c) => c.classList.toggle('on', c.dataset.preset === range.preset));
    const s = stats.summary;
    const pct = s.booked ? Math.round((s.checkedIn / s.booked) * 100) : 0;
    const totals = stats.days.reduce((acc, d) => ({ booked: acc.booked + d.booked, checkedIn: acc.checkedIn + d.checkedIn }), { booked: 0, checkedIn: 0 });
    lastDays = stats.days;

    dash.innerHTML = `
      <div class="muted small" style="margin-bottom:8px">Today · ${esc(formatDate(today))}</div>
      <div class="tiles">
        <div class="tile hero"><div class="label">Booked today</div><div class="value">${s.booked}</div></div>
        <div class="tile"><div class="label">Checked in</div><div class="value">${s.checkedIn}</div>
          <div class="meter" aria-hidden="true"><span style="width:${pct}%"></span></div><div class="small muted" style="margin-top:4px">${pct}% of today's bookings</div></div>
        <div class="tile"><div class="label">Yet to arrive</div><div class="value">${s.awaiting}</div></div>
        <a class="tile" href="#/requests" style="color:inherit;text-decoration:none"><div class="label">Pending requests today</div><div class="value">${s.pending}</div></a>
      </div>

      <div class="card chart-card">
        <h2 style="margin-bottom:2px">Appointments by date</h2>
        <div class="small muted">${esc(formatShortDate(range.from))} – ${esc(formatShortDate(range.to))} · ${totals.booked} booked, ${totals.checkedIn} checked in</div>
        ${legendHtml()}
        <div id="chart" style="position:relative"></div>
        <details style="margin-top:10px"><summary class="small" style="cursor:pointer">Show as table</summary>
          <div class="scroll-x"><table class="data">
            <thead><tr><th>Date</th><th>Booked</th><th>Checked in</th><th>Pending</th><th>Open slots</th></tr></thead>
            <tbody>${stats.days.map((d) => `<tr class="${d.date === today ? 'today' : ''}"><td>${esc(formatShortDate(d.date))}</td><td>${d.booked}</td><td>${d.checkedIn}</td><td>${d.pending}</td><td>${d.open}</td></tr>`).join('')}</tbody>
          </table></div>
        </details>
      </div>

      <div class="section-head"><h2>Today's visitors</h2><a class="btn small" href="#/scan">${icons.scan} Scan</a></div>
      <div class="card flush">
        ${stats.todayList.length ? stats.todayList.map((a) => `
          <div class="item">
            <div class="head">
              <div><div class="title">${esc(a.slot.start_time)} · ${esc(a.name)}</div><div class="small muted">${esc(a.phone)}</div></div>
              ${a.checked_in_at
                ? `<span class="status checked-in">${icons.check.replace('<svg', '<svg width="14" height="14"')} ${esc(formatClock(a.checked_in_at))}</span>`
                : `<button class="btn small secondary" data-checkin="${a.id}">Check in</button>`}
            </div>
          </div>`).join('') : '<div class="empty">No confirmed visitors today.</div>'}
      </div>`;
    renderChart($('#chart', dash), stats.days, today);
  }

  $('#presets', ctx.el).addEventListener('click', (e) => {
    const preset = e.target.closest('[data-preset]')?.dataset.preset;
    if (!preset || !today) return;
    range = { preset, ...rangeFor(preset, today) };
    load();
  });
  ctx.el.addEventListener('click', (e) => {
    const id = e.target.closest('[data-checkin]')?.dataset.checkin;
    if (id) openAdmitSheet({ appointmentId: Number(id) });
  });
  const onResize = () => lastDays && $('#chart', ctx.el) && renderChart($('#chart', ctx.el), lastDays, today);
  window.addEventListener('resize', onResize);
  ctx.onCleanup(() => window.removeEventListener('resize', onResize));
  onChanged(ctx, ['appointment', 'checkin', 'slots'], load);
  const timer = setInterval(load, 60000); // keeps "today" correct past midnight
  ctx.onCleanup(() => clearInterval(timer));
  await load();
}

// ---- Requests ---------------------------------------------------------------------

let requestStatus = 'pending';

async function requestsView(ctx) {
  ctx.el.innerHTML = `
    <h1>Requests</h1>
    <div class="chip-row" id="status">
      ${['pending', 'approved', 'rejected', 'cancelled', ''].map((s) => `<button class="chip" data-status="${s}">${s ? s[0].toUpperCase() + s.slice(1) : 'All'}</button>`).join('')}
    </div>
    <div id="list"><div class="spinner"></div></div>`;

  async function load() {
    const { appointments, counts } = await api(`/api/admin/appointments?status=${requestStatus}`);
    if (!ctx.isCurrent()) return;
    $$('#status .chip', ctx.el).forEach((c) => {
      const n = c.dataset.status ? counts[c.dataset.status] ?? 0 : null;
      c.classList.toggle('on', c.dataset.status === requestStatus);
      c.textContent = (c.dataset.status ? c.dataset.status[0].toUpperCase() + c.dataset.status.slice(1) : 'All') + (n ? ` (${n})` : '');
    });
    $('#list', ctx.el).innerHTML = appointments.length ? appointments.map((a) => `
      <div class="card" data-id="${a.id}">
        <div class="head" style="display:flex;justify-content:space-between;gap:8px">
          <div><div class="appt-when">${esc(formatShortDate(a.slot.date))} · ${esc(a.slot.start_time)}</div><div class="title">${esc(a.name)}</div></div>
          ${statusChip(a.status, a.checked_in_at)}
        </div>
        <dl class="detail">
          <dt>Phone</dt><dd><a href="tel:${esc(a.phone)}">${esc(a.phone)}</a> · <a href="https://wa.me/${esc(a.phone.replace(/\D/g, ''))}" target="_blank" rel="noopener">WhatsApp</a></dd>
          <dt>Email</dt><dd><a href="mailto:${esc(a.email)}">${esc(a.email)}</a></dd>
          <dt>Purpose</dt><dd style="white-space:pre-wrap">${esc(a.purpose)}</dd>
          <dt>Requested</dt><dd>${esc(formatTimestamp(a.created_at))}</dd>
          ${a.admin_note ? `<dt>Note</dt><dd>${esc(a.admin_note)}</dd>` : ''}
        </dl>
        ${a.status === 'pending' ? `
          <label for="note-${a.id}">Note to visitor (optional)</label>
          <input id="note-${a.id}" maxlength="1000" placeholder="e.g. Please bring a photo ID">
          <div class="actions">
            <button class="btn ok" data-action="approve" style="flex:1">${icons.check} Approve</button>
            <button class="btn danger" data-action="reject" style="flex:1">Decline</button>
          </div>` : ''}
        ${a.status === 'approved' && !a.checked_in_at ? '<div class="actions"><button class="btn danger small" data-action="cancel">Cancel appointment</button></div>' : ''}
      </div>`).join('') : '<div class="card empty">Nothing here.</div>';
  }

  $('#status', ctx.el).addEventListener('click', (e) => {
    const chip = e.target.closest('[data-status]');
    if (chip) { requestStatus = chip.dataset.status; load(); }
  });
  $('#list', ctx.el).addEventListener('click', async (e) => {
    const button = e.target.closest('[data-action]');
    if (!button) return;
    const card = button.closest('[data-id]');
    const { action } = button.dataset;
    if (action === 'cancel' && !confirm('Cancel this approved appointment? The visitor will be notified.')) return;
    setBusy(button, true);
    try {
      await api(`/api/admin/appointments/${card.dataset.id}/${action}`, { method: 'POST', body: { note: $('input', card)?.value ?? '' } });
      toast({ approve: 'Approved — confirmation sent by app, WhatsApp and email.', reject: 'Declined — the visitor has been notified.', cancel: 'Cancelled — the visitor has been notified.' }[action]);
      load();
    } catch (err) {
      toast(err.message);
      setBusy(button, false);
    }
  });
  onChanged(ctx, ['appointment'], load);
  await load();
}

// ---- Scanner -----------------------------------------------------------------------

function loadJsQR() {
  if (window.jsQR) return Promise.resolve(window.jsQR);
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = '/vendor/jsQR.js';
    s.onload = () => resolve(window.jsQR);
    s.onerror = reject;
    document.head.append(s);
  });
}

async function scanView(ctx) {
  ctx.el.innerHTML = `
    <div class="narrow">
      <h1>Scan entry pass</h1>
      <p class="lead">Point the camera at the visitor's QR code.</p>
      <div class="scanner"><video playsinline muted></video><div class="frame"></div><div class="msg" id="msg">Starting camera…</div></div>
      <form class="card" id="manual" style="margin-top:14px">
        <label for="code" style="margin-top:0">Or enter the code below the QR</label>
        <div style="display:flex;gap:8px"><input id="code" name="code" autocomplete="off" autocapitalize="off" spellcheck="false" required><button class="btn">Check</button></div>
      </form>
    </div>`;
  const video = $('video', ctx.el);
  const msg = $('#msg', ctx.el);
  let stream = null;
  let paused = false;
  let raf = null;

  const handleCode = (code) => {
    paused = true;
    if (navigator.vibrate) navigator.vibrate(40);
    const close = openAdmitSheet({ code }, { onClose: () => { paused = false; } });
    ctx.onCleanup(close);
  };

  $('#manual', ctx.el).addEventListener('submit', (e) => {
    e.preventDefault();
    const code = e.target.code.value.trim().replace(/^Code:\s*/i, '');
    if (code) { e.target.reset(); handleCode(code); }
  });

  ctx.onCleanup(() => { cancelAnimationFrame(raf); stream?.getTracks().forEach((t) => t.stop()); });

  if (!navigator.mediaDevices?.getUserMedia) {
    msg.textContent = 'Camera not available here (it needs HTTPS). Use the code box below.';
    return;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
  } catch {
    msg.textContent = 'Camera permission was denied. Allow camera access, or use the code box below.';
    return;
  }
  if (!ctx.isCurrent()) { stream.getTracks().forEach((t) => t.stop()); return; }
  video.srcObject = stream;
  await video.play();
  msg.textContent = 'Looking for a QR code…';

  let detect;
  if ('BarcodeDetector' in window && (await BarcodeDetector.getSupportedFormats?.())?.includes('qr_code')) {
    const detector = new BarcodeDetector({ formats: ['qr_code'] });
    detect = async () => (await detector.detect(video))[0]?.rawValue;
  } else {
    const jsQR = await loadJsQR();
    const canvas = document.createElement('canvas');
    const g = canvas.getContext('2d', { willReadFrequently: true });
    detect = async () => {
      const w = video.videoWidth;
      const h = video.videoHeight;
      if (!w) return null;
      const scale = Math.min(1, 640 / Math.max(w, h));
      canvas.width = w * scale;
      canvas.height = h * scale;
      g.drawImage(video, 0, 0, canvas.width, canvas.height);
      return jsQR(g.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height, { inversionAttempts: 'dontInvert' })?.data;
    };
  }

  let last = 0;
  const tick = async (t) => {
    if (!ctx.isCurrent()) return;
    if (!paused && t - last > 200 && video.readyState >= 2) {
      last = t;
      try {
        const code = await detect();
        if (code && !paused && ctx.isCurrent()) handleCode(code);
      } catch { /* keep scanning */ }
    }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
}

// ---- Messages --------------------------------------------------------------------

async function messagesView(ctx) {
  const load = async () => {
    const { threads } = await api('/api/admin/threads');
    if (!ctx.isCurrent()) return;
    ctx.el.innerHTML = `
      <h1>Messages</h1>
      <p class="lead">Questions from visitors.</p>
      <div class="card flush">${threads.length ? threads.map((t) => `
        <a class="item link ${t.unread ? 'unread' : ''}" href="#/messages/${t.user_id}">
          <div class="head"><span class="title">${esc(t.name)}${t.unread ? ` <span class="status pending">${t.unread} new</span>` : ''}</span><span class="time">${esc(formatTimestamp(t.last_at))}</span></div>
          <p class="muted small" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${t.last_from_admin ? 'You: ' : ''}${esc(t.last_body)}</p>
        </a>`).join('') : '<div class="empty">No messages yet.</div>'}</div>`;
  };
  onChanged(ctx, ['message'], load);
  await load();
}

async function threadView(ctx, userId) {
  ctx.el.innerHTML = `
    <a class="btn ghost small" href="#/messages">${icons.back} Messages</a>
    <div id="who" style="margin:8px 0 12px"></div>
    <div class="card flush">
      <div class="thread" id="thread"></div>
      <form class="composer" id="composer">
        <textarea name="body" placeholder="Reply…" maxlength="2000" required aria-label="Reply"></textarea>
        <button class="btn" type="submit" aria-label="Send">${icons.send}</button>
      </form>
    </div>
    <div id="visits"></div>`;
  const load = async () => {
    const { user, messages, appointments } = await api(`/api/admin/threads/${userId}`);
    if (!ctx.isCurrent()) return;
    $('#who', ctx.el).innerHTML = `<h1>${esc(user.name)}</h1>
      <div class="small"><a href="tel:${esc(user.phone)}">${esc(user.phone)}</a> · <a href="https://wa.me/${esc(user.phone.replace(/\D/g, ''))}" target="_blank" rel="noopener">WhatsApp</a> · <a href="mailto:${esc(user.email)}">${esc(user.email)}</a></div>`;
    const thread = $('#thread', ctx.el);
    thread.innerHTML = messages.map((m) => `
      <div class="bubble-msg ${m.from_admin ? 'mine' : 'theirs'}">${esc(m.body)}
        <span class="meta">${m.from_admin ? `${esc(m.sender_name)} · ` : ''}${esc(formatTimestamp(m.created_at))}</span></div>`).join('') || '<div class="empty small">No messages.</div>';
    thread.scrollTop = thread.scrollHeight;
    $('#visits', ctx.el).innerHTML = appointments.length ? `<div class="section-head"><h2>Their visits</h2></div><div class="card flush">${appointments.map((a) => `
      <div class="item"><div class="head"><span>${esc(formatSlot(a.slot))}</span>${statusChip(a.status, a.checked_in_at)}</div></div>`).join('')}</div>` : '';
    refreshBadges();
  };
  $('#composer', ctx.el).addEventListener('submit', async (e) => {
    e.preventDefault();
    const field = e.target.body;
    if (!field.value.trim()) return;
    const button = $('button', e.target);
    setBusy(button, true);
    try { await api(`/api/admin/threads/${userId}`, { method: 'POST', body: { body: field.value } }); field.value = ''; await load(); } catch (x) { toast(x.message); }
    setBusy(button, false);
  });
  onChanged(ctx, ['message'], (d) => String(d.userId) === String(userId) && load());
  await load();
}

// ---- Manage: slots and admins -------------------------------------------------------

async function manageView(ctx) {
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const today = new Date().toISOString().slice(0, 10);
  ctx.el.innerHTML = `
    <h1>Manage</h1>
    <div class="chip-row" id="sections">
      <button class="chip on" data-sec="slots">Slots</button>
      <button class="chip" data-sec="admins">Admins</button>
      <button class="chip" data-sec="account">My account</button>
    </div>

    <section data-sec="slots">
      <form class="card" id="slotForm">
        <h2>Add slots</h2>
        <div class="row">
          <div><label for="fromDate">From date</label><input id="fromDate" name="fromDate" type="date" required value="${today}"></div>
          <div><label for="toDate">To date</label><input id="toDate" name="toDate" type="date" required value="${today}"></div>
        </div>
        <div class="row">
          <div><label for="startTime">Daily start</label><input id="startTime" name="startTime" type="time" value="10:00" required></div>
          <div><label for="endTime">Daily end</label><input id="endTime" name="endTime" type="time" value="12:00" required></div>
        </div>
        <div class="row">
          <div><label for="duration">Meeting length (min)</label><input id="duration" name="duration" type="number" min="5" max="480" value="15" required></div>
          <div><label for="gap">Break between (min)</label><input id="gap" name="gap" type="number" min="0" max="240" value="5" required></div>
        </div>
        <label>Days of the week</label>
        <div class="weekdays">${DAYS.map((d, i) => `<label><input type="checkbox" value="${i}" checked> ${d}</label>`).join('')}</div>
        <div class="actions"><button class="btn block" type="submit">Create slots</button></div>
      </form>
      <div class="section-head"><h2>Upcoming slots</h2></div>
      <div id="slotList"><div class="spinner"></div></div>
    </section>

    <section data-sec="admins" class="hidden">
      <form class="card" id="adminForm" novalidate>
        <h2>Add an admin</h2>
        <p class="small muted" style="margin-top:0">If the email already has an account, it will be given admin access. Otherwise a new admin account is created with this password.</p>
        <label for="aEmail">Email</label><input id="aEmail" name="email" type="email" required>
        <div class="row">
          <div><label for="aName">Name</label><input id="aName" name="name" maxlength="100"></div>
          <div><label for="aPhone">Mobile</label><input id="aPhone" name="phone" type="tel" maxlength="25"></div>
        </div>
        <label for="aPass">Temporary password</label><input id="aPass" name="password" type="text" minlength="8" autocomplete="off">
        <div class="actions"><button class="btn block" type="submit">Add admin</button></div>
      </form>
      <div class="card flush" id="adminList"></div>
    </section>

    <section data-sec="account" class="hidden">
      <div class="card">
        <h2>${esc(me.name)}</h2>
        <p class="muted" style="margin-top:0">${esc(me.email)}</p>
        <div class="actions">
          <a class="btn secondary" href="/" target="_blank">Open visitor app</a>
          <button class="btn danger" id="logout">${icons.logout} Log out</button>
        </div>
      </div>
      <form class="card" id="pwForm">
        <h2>Change password</h2>
        <label for="cur">Current password</label><input id="cur" name="currentPassword" type="password" required>
        <label for="new">New password</label><input id="new" name="newPassword" type="password" minlength="8" required>
        <div class="actions"><button class="btn secondary" type="submit">Update password</button></div>
      </form>
    </section>`;

  $('#sections', ctx.el).addEventListener('click', (e) => {
    const sec = e.target.closest('[data-sec]')?.dataset.sec;
    if (!sec) return;
    $$('#sections .chip', ctx.el).forEach((c) => c.classList.toggle('on', c.dataset.sec === sec));
    $$('section[data-sec]', ctx.el).forEach((s) => s.classList.toggle('hidden', s.dataset.sec !== sec));
    if (sec === 'admins') loadAdmins();
  });

  async function loadSlots() {
    const { slots } = await api('/api/admin/slots');
    if (!ctx.isCurrent()) return;
    const byDate = new Map();
    for (const s of slots) byDate.set(s.date, [...(byDate.get(s.date) ?? []), s]);
    $('#slotList', ctx.el).innerHTML = slots.length ? [...byDate].map(([date, list]) => `
      <div class="card"><h3>${esc(formatDate(date))}</h3><div class="slot-grid">
        ${list.map((s) => {
          const state = s.checked_in_at ? 'checked-in' : s.appointment_status ?? (s.is_blocked ? 'blocked' : 'free');
          const label = s.appointment_status ? `${s.checked_in_at ? 'checked in' : s.appointment_status} · ${s.visitor_name}` : state === 'free' ? 'open' : state;
          return `<div class="slot-cell" data-slot="${s.id}">
            <div><strong>${esc(s.start_time)}–${esc(s.end_time)}</strong></div>
            <div><span class="status ${esc(state)}" style="max-width:100%;overflow:hidden;text-overflow:ellipsis">${esc(label)}</span></div>
            ${s.appointment_status ? '' : `<div class="btns">
              <button class="btn secondary small" data-slot-action="${s.is_blocked ? 'unblock' : 'block'}">${s.is_blocked ? 'Unblock' : 'Block'}</button>
              <button class="btn danger small" data-slot-action="delete" aria-label="Delete">${icons.x}</button></div>`}
          </div>`;
        }).join('')}
      </div></div>`).join('') : '<div class="card empty">No upcoming slots. Add some above.</div>';
  }

  async function loadAdmins() {
    const { admins } = await api('/api/admin/admins');
    if (!ctx.isCurrent()) return;
    $('#adminList', ctx.el).innerHTML = admins.map((a) => `
      <div class="item"><div class="head">
        <div><div class="title">${esc(a.name)}${a.id === me.id ? ' (you)' : ''}</div><div class="small muted">${esc(a.email)}</div></div>
        ${a.id === me.id ? '' : `<button class="btn danger small" data-remove="${a.id}">Remove</button>`}
      </div></div>`).join('');
  }

  $('#slotList', ctx.el).addEventListener('click', async (e) => {
    const button = e.target.closest('[data-slot-action]');
    if (!button) return;
    const id = button.closest('[data-slot]').dataset.slot;
    const action = button.dataset.slotAction;
    try {
      if (action === 'delete') await api(`/api/admin/slots/${id}`, { method: 'DELETE' });
      else await api(`/api/admin/slots/${id}`, { method: 'PATCH', body: { blocked: action === 'block' } });
      loadSlots();
    } catch (err) { toast(err.message); }
  });

  $('#fromDate', ctx.el).addEventListener('change', () => {
    const to = $('#toDate', ctx.el);
    if (!to.value || to.value < $('#fromDate', ctx.el).value) to.value = $('#fromDate', ctx.el).value;
  });
  $('#slotForm', ctx.el).addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.target));
    const weekdays = $$('.weekdays input:checked', ctx.el).map((i) => Number(i.value));
    try {
      const { created, skipped } = await api('/api/admin/slots', { method: 'POST', body: { ...data, duration: Number(data.duration), gap: Number(data.gap), weekdays } });
      toast(`Created ${created} slot${created === 1 ? '' : 's'}${skipped ? ` (${skipped} already existed)` : ''}.`);
      loadSlots();
    } catch (err) { toast(err.message); }
  });

  $('#adminForm', ctx.el).addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.target));
    try {
      const { admin, promoted } = await api('/api/admin/admins', { method: 'POST', body: data });
      toast(promoted ? `${admin.name} is now an admin.` : `Admin account created for ${admin.email}.`);
      e.target.reset();
      loadAdmins();
    } catch (err) { toast(err.message); }
  });
  $('#adminList', ctx.el).addEventListener('click', async (e) => {
    const id = e.target.closest('[data-remove]')?.dataset.remove;
    if (!id || !confirm('Remove admin access for this person?')) return;
    try { await api(`/api/admin/admins/${id}`, { method: 'DELETE' }); loadAdmins(); } catch (err) { toast(err.message); }
  });

  $('#pwForm', ctx.el).addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!e.target.checkValidity()) { e.target.reportValidity(); return; }
    try { await api('/api/auth/change-password', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) }); e.target.reset(); toast('Password updated.'); } catch (err) { toast(err.message); }
  });
  $('#logout', ctx.el).addEventListener('click', async () => {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
    setLoggedIn(null);
    location.hash = '#/login';
  });

  onChanged(ctx, ['slots', 'appointment', 'checkin'], loadSlots);
  await loadSlots();
}

// ---- Boot -------------------------------------------------------------------------

const afterLogin = async (user) => {
  if (user.role !== 'admin') {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
    throw new Error('This account does not have admin access.');
  }
  setLoggedIn(user);
  location.hash = '#/dashboard';
};
const auth = (mode) => authView(mode, { title: 'Admin login', subtitle: 'Manage appointments and check visitors in.', allowSignup: false, onSuccess: afterLogin });

const router = createRouter({
  outlet,
  fallback: '#/dashboard',
  routes: [
    { path: /^#\/login$/, view: auth('login'), public: true },
    { path: /^#\/forgot$/, view: auth('forgot'), public: true },
    { path: /^#\/reset\/([\w-]+)$/, view: auth('reset'), public: true },
    { path: /^#\/dashboard$/, view: dashboardView, tab: 'dashboard' },
    { path: /^#\/requests$/, view: requestsView, tab: 'requests' },
    { path: /^#\/scan$/, view: scanView, tab: 'scan' },
    { path: /^#\/messages$/, view: messagesView, tab: 'messages' },
    { path: /^#\/messages\/(\d+)$/, view: threadView, tab: 'messages' },
    { path: /^#\/manage$/, view: manageView, tab: 'manage' },
  ],
  guard: (route, hash) => {
    if (route.public && me && !/reset/.test(hash)) return '#/dashboard';
    if (!route.public && !me) return '#/login';
    return null;
  },
  onChange: (route) => $$('[data-tab]').forEach((a) => a.classList.toggle('on', a.dataset.tab === route.tab)),
});

const { user } = await api('/api/auth/me');
setLoggedIn(user?.role === 'admin' ? user : null);
router.run();
