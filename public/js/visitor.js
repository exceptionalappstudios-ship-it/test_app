import {
  $, $$, api, esc, formatDate, formatShortDate, formatPhone, formatWhen, dayParts, plural, statusChip, photoTag, contactButtons,
  toast, openSheet, confirmSheet, busy, createRouter, liveStream, homeFor, enablePush, pushSupported, registerServiceWorker, PERIOD_ICONS,
} from './common.js';
import { icons } from './icons.js';
import { renderLogin, renderProfileSetup } from './login.js';
import { photoPicker, uploadPhoto } from './photo.js';

const outlet = $('#app');
let user = null;
let config = null;
let stopStream = null;

const TABS = [['book', 'Book', icons.calendar], ['visit', 'My visit', icons.ticket], ['updates', 'Updates', icons.bell], ['profile', 'Profile', icons.user]];
for (const [key, label, icon] of TABS) $(`[data-tab="${key}"]`).innerHTML = `${icon}<span>${label}</span>`;

function header(title, subtitle = '', steps = 0, step = 0) {
  $('#title').textContent = title;
  $('#subtitle').textContent = subtitle;
  $('#steps').classList.toggle('hidden', !steps);
  $('#steps').innerHTML = Array.from({ length: steps }, (_, i) => `<span class="${i < step ? 'on' : ''}"></span>`).join('');
}

function setUser(u) {
  user = u;
  const ready = Boolean(u?.profileComplete);
  $('#tabbar').classList.toggle('hidden', !ready);
  document.body.classList.toggle('no-nav', !ready);
  $('#me').classList.toggle('hidden', !ready);
  $('#me').innerHTML = u?.photo ? `<img src="${esc(u.photo)}" alt="">` : icons.user;
  stopStream?.();
  stopStream = null;
  if (ready) {
    stopStream = liveStream('/api/me/stream', {
      notification: (n) => { toast(n.title); refreshBadge(); window.dispatchEvent(new CustomEvent('app:update')); },
    });
    refreshBadge();
  }
}

async function refreshBadge() {
  try {
    const { unread } = await api('/api/me');
    const link = $('[data-tab="updates"]');
    $('.dot', link)?.remove();
    if (unread) link.insertAdjacentHTML('beforeend', `<span class="dot">${unread}</span>`);
  } catch { /* offline */ }
}

function onUpdate(ctx, fn) {
  const handler = () => { if (ctx.isCurrent() && !document.activeElement?.matches('input, textarea')) fn(); };
  window.addEventListener('app:update', handler);
  ctx.onCleanup(() => window.removeEventListener('app:update', handler));
}

// ---- Login & first-time setup ----------------------------------------------------

function loginView(ctx) {
  header('Meet Gurudev', 'Book your visit in a few simple steps.');
  renderLogin(ctx.el, {
    onDone: (u) => {
      if (homeFor(u) !== '/') { location.href = homeFor(u); return; }
      setUser(u);
      location.hash = u.profileComplete ? '#/book' : '#/setup';
    },
    footer: '<p class="center small muted" style="margin-top:18px">Security staff? <a href="/security.html">Register or log in here</a></p>',
  });
}

function setupView(ctx) {
  header('Welcome 🙏', 'One quick step before you book.');
  renderProfileSetup(ctx.el, user, { onDone: (u) => { setUser(u); location.hash = '#/book'; } });
}

// ---- Book ----------------------------------------------------------------------------

async function bookView(ctx) {
  header('Book a visit', 'Choose a day and a time of day.');
  const [{ days }, me] = await Promise.all([api('/api/availability'), api('/api/me')]);
  if (!ctx.isCurrent()) return;
  const existing = me.appointments.find((a) => a.upcoming);
  if (existing) {
    ctx.el.innerHTML = `<div class="card center">
      <div class="big-icon wait">${icons.ticket}</div>
      <h2>You already have an appointment</h2>
      <p class="sub">${esc(formatDate(existing.date))} · ${esc(existing.periodLabel)}<br>Each person can have one appointment at a time.</p>
      <a class="btn block" href="#/visit">See my visit</a></div>`;
    return;
  }

  const form = {
    date: days[0]?.date ?? null, session: null, phone: user.phone, reference: '', count: 1, purposes: [], description: '', people: [],
  };
  let conflicts = {};

  const STEPS = ['when', 'details', 'people', 'review'];
  const show = (step) => {
    const total = form.count > 1 ? 4 : 3;
    const index = STEPS.filter((s) => form.count > 1 || s !== 'people').indexOf(step) + 1;
    header(
      { when: 'Book a visit', details: 'About your visit', people: 'Who is coming', review: 'Check and send' }[step],
      { when: 'Choose a day and a time of day.', details: 'A few questions so we can plan your visit.', people: 'Add the name and number of each person.', review: 'Please check everything before sending.' }[step],
      total, index,
    );
    ({ when: renderWhen, details: renderDetails, people: renderPeople, review: renderReview })[step]();
    window.scrollTo({ top: 0 });
  };

  // Step 1: day and morning / afternoon / evening.
  function renderWhen() {
    if (!days.length) {
      ctx.el.innerHTML = `<div class="card center"><div class="big-icon wait">${icons.calendar}</div><h2>No dates open right now</h2><p class="sub">New dates are added regularly. Please check again soon.</p></div>`;
      return;
    }
    const day = days.find((d) => d.date === form.date);
    const byPeriod = Object.fromEntries(day.sessions.map((s) => [s.period, s]));
    ctx.el.innerHTML = `
      <div class="card">
        <h3>Choose a day</h3>
        <div class="date-strip" role="listbox" aria-label="Day">
          ${days.map((d) => { const p = dayParts(d.date); return `<button type="button" class="date-pill ${d.date === form.date ? 'on' : ''}" data-date="${d.date}" role="option" aria-selected="${d.date === form.date}"><div class="dow">${esc(p.dow)}</div><div class="day">${esc(p.day)}</div><div class="mon">${esc(p.mon)}</div></button>`; }).join('')}
        </div>
        <h3 style="margin-top:8px">${esc(formatDate(form.date))}</h3>
        <div class="choices">
          ${['morning', 'afternoon', 'evening'].map((p) => {
            const s = byPeriod[p];
            const full = !s || s.remaining < 1;
            return `<button type="button" class="choice ${form.session?.id === s?.id && s ? 'on' : ''}" data-session="${s?.id ?? ''}" ${full ? 'disabled' : ''}>
              <span class="ic">${PERIOD_ICONS[p]}</span>
              <span><span class="t">${esc(config.periods[p].label)}</span><br><span class="d">${!s ? 'Not open on this day' : full ? 'Full' : s.remaining < 10 ? `Only ${s.remaining} places left` : 'Places available'}</span></span>
              <span class="tick">${icons.check}</span></button>`;
          }).join('')}
        </div>
      </div>
      <button class="btn block" data-next ${form.session ? '' : 'disabled'}>Continue ${icons.next}</button>`;
    $('.date-strip', ctx.el).addEventListener('click', (e) => {
      const b = e.target.closest('[data-date]');
      if (b && b.dataset.date !== form.date) { form.date = b.dataset.date; form.session = null; renderWhen(); }
    });
    $$('[data-session]', ctx.el).forEach((b) => b.addEventListener('click', () => {
      form.session = days.find((d) => d.date === form.date).sessions.find((s) => s.id === Number(b.dataset.session));
      form.count = Math.min(form.count, maxPeople());
      renderWhen();
    }));
    $('[data-next]', ctx.el).addEventListener('click', () => show('details'));
  }

  const maxPeople = () => Math.max(1, Math.min(config.maxPeople, form.session?.remaining ?? config.maxPeople));

  // Step 2: photo, WhatsApp number, reference, how many people, purpose.
  function renderDetails(error = '') {
    ctx.el.innerHTML = `
      <div class="card">
        <div class="row">
          ${photoTag(user.photo, user.name, 'lg')}
          <div class="grow"><div class="name" style="font-weight:800;font-size:1.1rem">${esc(user.name)}</div>
          <div class="small muted">Security will check this photo at the entrance.</div>
          <button type="button" class="btn ghost small" data-photo>${icons.camera} Change photo</button></div>
        </div>
      </div>
      <div class="card">
        <h3>${icons.whatsapp.replace('<svg', '<svg width="20" height="20" style="vertical-align:-4px;color:#0b7d3d"')} Your entry pass</h3>
        <div data-wa>
          <p class="sub" style="margin:0">Your confirmation and QR pass will be sent on WhatsApp to <strong>${esc(formatPhone(form.phone))}</strong>.</p>
          <button type="button" class="btn ghost small" data-change-wa>${icons.edit} Use a different number</button>
        </div>
      </div>
      <form class="card" novalidate>
        <label for="reference" style="margin-top:0">Reference <span class="muted small">(required)</span></label>
        <input id="reference" name="reference" maxlength="120" required value="${esc(form.reference)}" placeholder="Who referred you? Name or centre">
        <div class="label">How many people are coming, including you?</div>
        <div class="stepper">
          <button type="button" data-dec aria-label="Fewer people">${icons.minus}</button>
          <span class="n" data-count>${form.count}</span>
          <button type="button" data-inc aria-label="More people">${icons.plus}</button>
          <span class="muted small">${form.count === 1 ? 'Just me' : `You + ${plural(form.count - 1, 'person', 'people')}`}</span>
        </div>
        ${maxPeople() < config.maxPeople ? `<div class="hint">Only ${maxPeople()} places are left in this session.</div>` : '<div class="hint">Up to 10 people.</div>'}
        <div class="label">Purpose of meeting <span class="muted small">(choose one or more)</span></div>
        <div class="choices">
          ${Object.entries(config.purposes).map(([key, label]) => `
            <button type="button" class="choice check ${form.purposes.includes(key) ? 'on' : ''}" data-purpose="${key}" aria-pressed="${form.purposes.includes(key)}">
              <span class="t" style="font-weight:600">${esc(label)}</span><span class="tick">${icons.check}</span></button>`).join('')}
        </div>
        <label for="description">Tell us in a few words ${form.purposes.includes('other') ? '<span class="muted small">(required)</span>' : '<span class="muted small">(optional)</span>'}</label>
        <textarea id="description" name="description" maxlength="500" placeholder="For example: blessings for my daughter's wedding">${esc(form.description)}</textarea>
        ${error ? `<div class="notice bad" style="margin-top:12px">${icons.alert}<span>${esc(error)}</span></div>` : ''}
      </form>
      <div class="actions" style="margin-top:0"><button class="btn light" data-back>${icons.back} Back</button><button class="btn" data-next>Continue ${icons.next}</button></div>`;

    const keep = () => { form.reference = $('#reference', ctx.el).value; form.description = $('#description', ctx.el).value; };
    $('[data-photo]', ctx.el).addEventListener('click', () => changePhoto(() => renderDetails()));
    $('[data-change-wa]', ctx.el).addEventListener('click', () => {
      $('[data-wa]', ctx.el).innerHTML = `
        <label for="wa" style="margin-top:0">WhatsApp number for your pass</label>
        <div class="phone-field"><span>+91</span><input id="wa" type="tel" inputmode="tel" maxlength="20" value="${esc(form.phone.replace(/^\+91/, ''))}"></div>
        <div class="hint">The QR pass and all updates will go to this number.</div>`;
      $('#wa', ctx.el).focus();
      $('#wa', ctx.el).addEventListener('change', (e) => { form.phone = e.target.value.trim(); });
    });
    const setCount = (n) => { keep(); form.count = Math.max(1, Math.min(maxPeople(), n)); form.people = form.people.slice(0, form.count - 1); renderDetails(); };
    $('[data-dec]', ctx.el).addEventListener('click', () => setCount(form.count - 1));
    $('[data-inc]', ctx.el).addEventListener('click', () => setCount(form.count + 1));
    $$('[data-purpose]', ctx.el).forEach((b) => b.addEventListener('click', () => {
      keep();
      const k = b.dataset.purpose;
      form.purposes = form.purposes.includes(k) ? form.purposes.filter((p) => p !== k) : [...form.purposes, k];
      renderDetails();
    }));
    $('[data-back]', ctx.el).addEventListener('click', () => { keep(); show('when'); });
    $('[data-next]', ctx.el).addEventListener('click', () => {
      keep();
      const wa = $('#wa', ctx.el);
      if (wa) form.phone = wa.value.trim();
      const problem = form.phone.replace(/\D/g, '').length < 10 ? 'Please enter the WhatsApp number for your pass.'
        : form.reference.trim().length < 2 ? 'Please tell us who referred you (reference).'
        : !form.purposes.length ? 'Please choose the purpose of your meeting.'
        : form.purposes.includes('other') && !form.description.trim() ? 'Please tell us in a few words about your visit.' : '';
      if (problem) return renderDetails(problem);
      show(form.count > 1 ? 'people' : 'review');
    });
  }

  // Step 3: the other people in the group.
  function renderPeople(error = '') {
    while (form.people.length < form.count - 1) form.people.push({ name: '', phone: '' });
    const own = conflicts[normal(form.phone)] ?? conflicts[user.phone];
    ctx.el.innerHTML = `
      ${own ? `<div class="notice bad card">${icons.alert}<span>${esc(own)}</span></div>` : ''}
      ${form.people.map((p, i) => {
        const c = conflicts[normal(p.phone)];
        return `<div class="card" data-person="${i}">
          <div class="row" style="justify-content:space-between"><h3 style="margin:0">Person ${i + 2}</h3>
            <button type="button" class="btn ghost small" data-remove="${i}" style="color:var(--red)">${icons.trash} Remove</button></div>
          <label for="pn${i}">Full name</label>
          <input id="pn${i}" data-field="name" maxlength="80" value="${esc(p.name)}" placeholder="Name">
          <label for="pp${i}">Phone number</label>
          <div class="phone-field"><span>+91</span><input id="pp${i}" data-field="phone" type="tel" inputmode="tel" maxlength="20" value="${esc(p.phone.replace(/^\+91/, ''))}" placeholder="98765 43210"></div>
          ${c ? `<div class="notice bad" style="margin-top:10px">${icons.alert}<span>${esc(c)}</span></div>` : ''}
        </div>`;
      }).join('')}
      ${error ? `<div class="notice bad" style="margin-bottom:14px">${icons.alert}<span>${esc(error)}</span></div>` : ''}
      <div class="actions" style="margin-top:0"><button class="btn light" data-back>${icons.back} Back</button><button class="btn" data-next>Continue ${icons.next}</button></div>`;
    const keep = () => $$('[data-person]', ctx.el).forEach((card) => {
      const p = form.people[Number(card.dataset.person)];
      p.name = $('[data-field=name]', card).value.trim();
      p.phone = $('[data-field=phone]', card).value.trim();
    });
    $$('[data-remove]', ctx.el).forEach((b) => b.addEventListener('click', () => {
      keep();
      form.people.splice(Number(b.dataset.remove), 1);
      form.count -= 1;
      if (form.count === 1) show('details'); else renderPeople();
    }));
    $('[data-back]', ctx.el).addEventListener('click', () => { keep(); show('details'); });
    $('[data-next]', ctx.el).addEventListener('click', async (e) => {
      keep();
      const missing = form.people.findIndex((p) => p.name.length < 2 || p.phone.replace(/\D/g, '').length < 10);
      if (missing >= 0) return renderPeople(`Please enter the name and phone number of person ${missing + 2}.`);
      const all = [form.phone, ...form.people.map((p) => p.phone)].map(normal);
      const dup = all.findIndex((p, i) => all.indexOf(p) !== i);
      if (dup >= 0) return renderPeople(`${dup === 0 ? 'Your' : `Person ${dup + 1}'s`} number is entered twice. Each person needs their own number.`);
      const { conflicts: found } = await busy(e.currentTarget, () => api('/api/appointments/check', { method: 'POST', body: { phones: [form.phone, user.phone, ...form.people.map((p) => p.phone)] } }));
      conflicts = Object.fromEntries(found.map((c) => [c.phone, c.message]));
      if (found.length) return renderPeople('Some people already have an appointment. Each person can have only one. Remove them, or ask them to cancel their other appointment.');
      show('review');
    });
  }

  const normal = (p) => {
    const d = String(p ?? '').replace(/\D/g, '');
    if (String(p).trim().startsWith('+')) return `+${d}`;
    const local = d.replace(/^0+/, '');
    return local.length <= 10 ? `+91${local}` : `+${local}`;
  };

  // Step 4: check and send.
  function renderReview(error = '') {
    ctx.el.innerHTML = `
      <div class="card">
        <div class="row">${photoTag(user.photo, user.name, 'lg')}<div class="grow">
          <div style="font-weight:800;font-size:1.15rem">${esc(user.name)}</div>
          <div class="muted small">${icons.whatsapp.replace('<svg', '<svg width="14" height="14" style="vertical-align:-2px"')} Pass will be sent to ${esc(formatPhone(normal(form.phone)))}</div></div></div>
        <dl class="details">
          <dt>Day</dt><dd><strong>${esc(formatDate(form.date))}</strong></dd>
          <dt>Time</dt><dd><strong>${esc(form.session.label)}</strong></dd>
          <dt>People</dt><dd>${esc(plural(form.count, 'person', 'people'))}${form.people.length ? `<br>${form.people.map((p) => esc(p.name)).join(', ')}` : ''}</dd>
          <dt>Reference</dt><dd>${esc(form.reference)}</dd>
          <dt>Purpose</dt><dd>${form.purposes.map((p) => esc(config.purposes[p])).join(', ')}</dd>
          ${form.description.trim() ? `<dt>Details</dt><dd>${esc(form.description)}</dd>` : ''}
        </dl>
      </div>
      <div class="notice info" style="margin-bottom:14px">${icons.info}<span>After the ashram confirms, you will get a message on WhatsApp. Your QR pass will be sent on the day of your visit.</span></div>
      ${error ? `<div class="notice bad" style="margin-bottom:14px">${icons.alert}<span>${esc(error)}</span></div>` : ''}
      <div class="actions" style="margin-top:0"><button class="btn light" data-back>${icons.back} Back</button><button class="btn" data-send>${icons.send} Send request</button></div>`;
    $('[data-back]', ctx.el).addEventListener('click', () => show(form.count > 1 ? 'people' : 'details'));
    $('[data-send]', ctx.el).addEventListener('click', async (e) => {
      try {
        const { appointment } = await busy(e.currentTarget, () => api('/api/appointments', { method: 'POST', body: {
          sessionId: form.session.id, phone: form.phone, reference: form.reference, peopleCount: form.count,
          people: form.people, purposes: form.purposes, description: form.description,
        } }));
        renderDone(appointment);
      } catch (err) {
        if (err.data?.conflicts?.length) {
          conflicts = Object.fromEntries(err.data.conflicts.map((c) => [c.phone, c.message]));
          if (form.count > 1) show('people'); else renderReview(err.message);
        } else if (err.status === 409) renderReview(err.message);
      }
    });
  }

  function renderDone(a) {
    header('Request sent 🙏', 'We will let you know soon.');
    ctx.el.innerHTML = `<div class="card center">
      <div class="big-icon ok">${icons.checkCircle}</div>
      <h2>Thank you, ${esc(user.name.split(' ')[0])}</h2>
      <p class="sub">Your request for <strong>${esc(formatDate(a.date))}, ${esc(a.periodLabel)}</strong> for ${esc(plural(a.peopleCount, 'person', 'people'))} has been sent.<br><br>
      We will send the confirmation on WhatsApp. On the day of your visit, your QR entry pass will be sent on WhatsApp and will also show in this app.</p>
      <a class="btn block" href="#/visit">${icons.ticket} See my visit</a></div>`;
    window.scrollTo({ top: 0 });
  }

  show('when');
}

function changePhoto(after) {
  let blob = null;
  const { el, close } = openSheet(`<h2 style="margin:0 0 4px">Change photo</h2><div data-picker></div>
    <div class="actions"><button class="btn light" data-close>Cancel</button><button class="btn" data-save disabled>${icons.check} Save photo</button></div>`);
  const save = $('[data-save]', el);
  photoPicker($('[data-picker]', el), { current: user.photo, onChange: (b) => { blob = b; save.disabled = !b; } });
  save.addEventListener('click', async () => {
    const { user: u } = await busy(save, () => uploadPhoto(blob));
    setUser(u);
    close();
    toast('Photo saved.');
    after?.();
  });
}

// ---- My visit -----------------------------------------------------------------------

async function visitView(ctx) {
  header('My visit', 'Your appointment and entry pass.');
  const render = async () => {
    const { appointments } = await api('/api/me');
    if (!ctx.isCurrent()) return;
    const current = appointments.find((a) => a.upcoming || a.pass.state === 'ready' || (a.pass.state === 'checked_in' && a.date >= new Date().toISOString().slice(0, 10)));
    const past = appointments.filter((a) => a !== current);
    let passHtml = '';
    if (current) {
      const p = current.pass;
      if (p.state === 'ready') {
        const { pass } = await api(`/api/me/appointments/${current.id}/pass`);
        if (!ctx.isCurrent()) return;
        passHtml = pass.state === 'ready' ? `<div class="pass">
          <div class="notice ok" style="justify-content:center">${icons.checkCircle}<span>Show this QR code at the entrance</span></div>
          <div class="qr">${pass.svg}</div>
          <div class="who">${esc(current.name)}</div>
          <div class="muted">${esc(plural(current.peopleCount, 'person', 'people'))} · ${esc(current.periodLabel)}</div>
          <p class="small muted">Valid only today. It can be scanned only once.</p></div>` : '';
      } else if (p.state === 'not_yet') {
        passHtml = `<div class="pass"><div class="big-icon wait">${icons.clock}</div>
          <h2>Confirmed ✅</h2><p class="sub">Your QR entry pass will be sent on WhatsApp on <strong>${esc(formatShortDate(p.opensOn))} at ${esc(p.opensAt)}</strong>. It will also show here.</p></div>`;
      } else if (p.state === 'checked_in') {
        passHtml = `<div class="pass"><div class="big-icon ok">${icons.checkCircle}</div><h2>You are checked in</h2><p class="sub">Welcome! Please take a seat.</p></div>`;
      } else if (['pending', 'hold'].includes(current.status)) {
        passHtml = `<div class="pass"><div class="big-icon wait">${icons.clock}</div><h2>Waiting for confirmation</h2>
          <p class="sub">Your request is being reviewed. We will tell you on WhatsApp and here.</p></div>`;
      }
    }
    ctx.el.innerHTML = current ? `
      <div class="card">${passHtml}</div>
      <div class="card">
        <div class="row" style="justify-content:space-between"><h3 style="margin:0">${esc(formatDate(current.date))}</h3>${statusChip(current.status, current.checkedInAt)}</div>
        <dl class="details">
          <dt>Time</dt><dd>${esc(current.periodLabel)}</dd>
          <dt>People</dt><dd>${esc(plural(current.peopleCount, 'person', 'people'))}${current.people.length ? `<br>${esc(current.name)}, ${current.people.map((p) => esc(p.name)).join(', ')}` : ''}</dd>
          <dt>WhatsApp</dt><dd>${esc(formatPhone(current.phone))}</dd>
          <dt>Reference</dt><dd>${esc(current.reference)}</dd>
          <dt>Purpose</dt><dd>${current.purposes.map(esc).join(', ')}</dd>
          ${current.adminNote ? `<dt>Note</dt><dd><strong>${esc(current.adminNote)}</strong></dd>` : ''}
        </dl>
        ${!current.checkedInAt ? `<div class="actions"><button class="btn danger" data-cancel="${current.id}">${icons.x} Cancel appointment</button></div>` : ''}
      </div>` : `
      <div class="card center"><div class="big-icon wait">${icons.calendar}</div><h2>No upcoming visit</h2><p class="sub">Book a day and time to meet Gurudev.</p><a class="btn block" href="#/book">${icons.calendar} Book a visit</a></div>`;
    if (past.length) {
      ctx.el.insertAdjacentHTML('beforeend', `<div class="section-title">Earlier</div><div class="card flush">${past.map((a) => `
        <div class="person"><div class="grow"><div class="name">${esc(formatShortDate(a.date))} · ${esc(a.periodLabel)}</div><div class="meta">${esc(plural(a.peopleCount, 'person', 'people'))}</div></div>${statusChip(a.status, a.checkedInAt)}</div>`).join('')}</div>`);
    }
    $('[data-cancel]', ctx.el)?.addEventListener('click', async (e) => {
      if (!await confirmSheet({ title: 'Cancel this appointment?', message: 'Your place will be given to someone else.', confirm: 'Yes, cancel', danger: true })) return;
      await busy(e.target, () => api(`/api/me/appointments/${e.target.dataset.cancel}/cancel`, { method: 'POST' }));
      toast('Appointment cancelled.');
      render();
    });
  };
  await render();
  onUpdate(ctx, render);
  const timer = setInterval(render, 60000);
  ctx.onCleanup(() => clearInterval(timer));
}

// ---- Updates ---------------------------------------------------------------------------

async function updatesView(ctx) {
  header('Updates', 'Every update is also sent to you on WhatsApp.');
  const render = async () => {
    const { notifications, unread } = await api('/api/me');
    if (!ctx.isCurrent()) return;
    ctx.el.innerHTML = `<div class="card flush">${notifications.length ? notifications.map((n) => `
      <div class="person" style="align-items:flex-start;${n.read_at ? '' : 'background:var(--blue-50)'}">
        <div class="grow"><div class="row" style="justify-content:space-between;align-items:flex-start"><span class="name">${esc(n.title)}</span><span class="meta" style="white-space:nowrap">${esc(formatWhen(n.created_at))}</span></div>
        <div style="margin-top:4px;white-space:pre-wrap">${esc(n.body)}</div></div></div>`).join('') : '<div class="empty">No updates yet.</div>'}</div>`;
    if (unread) { await api('/api/me/notifications/read', { method: 'POST' }); refreshBadge(); }
  };
  await render();
  onUpdate(ctx, render);
}

// ---- Profile -----------------------------------------------------------------------------

async function profileView(ctx) {
  header('My profile');
  const c = config.contact;
  ctx.el.innerHTML = `
    <div class="card center">
      ${photoTag(user.photo, user.name, 'xl')}
      <h2 style="margin-top:10px">${esc(user.name)}</h2>
      <p class="sub">${esc(formatPhone(user.phone))}</p>
      <button class="btn light small" data-photo>${icons.camera} Change photo</button>
    </div>
    <form class="card" data-name novalidate>
      <label for="name" style="margin-top:0">Full name</label>
      <input id="name" name="name" maxlength="80" value="${esc(user.name)}">
      <div class="actions"><button class="btn small" type="submit">Save name</button></div>
    </form>
    ${pushSupported() && Notification.permission !== 'granted' ? `<div class="card row"><div class="grow"><strong>Alerts on this phone</strong><div class="small muted">Get updates even when the app is closed.</div></div><button class="btn small blue" data-push>Turn on</button></div>` : ''}
    ${c.phone || c.whatsapp ? `<div class="card"><h3>Need help?</h3><div class="row"><div class="grow small muted">${c.address ? esc(c.address) : 'Call or message the ashram office.'}</div>${contactButtons(c.whatsapp ?? c.phone)}</div></div>` : ''}
    <button class="btn danger block" data-logout>${icons.logout} Log out</button>`;
  $('[data-photo]', ctx.el).addEventListener('click', () => changePhoto(() => profileView(ctx)));
  $('[data-name]', ctx.el).addEventListener('submit', async (e) => {
    e.preventDefault();
    const { user: u } = await busy($('button', e.target), () => api('/api/auth/me', { method: 'PATCH', body: { name: e.target.name.value } }));
    setUser(u);
    toast('Name saved.');
  });
  $('[data-push]', ctx.el)?.addEventListener('click', async (e) => {
    try { await enablePush(config.vapidPublicKey); e.target.closest('.card').remove(); toast('Alerts are on.'); } catch (err) { toast(err.message); }
  });
  $('[data-logout]', ctx.el).addEventListener('click', async () => {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
    setUser(null);
    location.hash = '#/login';
  });
}

// ---- Boot --------------------------------------------------------------------------------

const router = createRouter({
  outlet,
  fallback: '#/book',
  routes: [
    { path: /^#\/login$/, view: loginView, public: true },
    { path: /^#\/setup$/, view: setupView, setup: true },
    { path: /^#\/book$/, view: bookView, tab: 'book' },
    { path: /^#\/visit$/, view: visitView, tab: 'visit' },
    { path: /^#\/updates$/, view: updatesView, tab: 'updates' },
    { path: /^#\/profile$/, view: profileView, tab: 'profile' },
  ],
  guard: (route) => {
    if (!user) return route.public ? null : '#/login';
    if (route.public) return '#/book';
    if (!user.profileComplete && !route.setup) return '#/setup';
    return null;
  },
  onChange: (route) => $$('[data-tab]').forEach((a) => a.classList.toggle('on', a.dataset.tab === route.tab)),
});

registerServiceWorker();
[config, { user }] = await Promise.all([api('/api/config'), api('/api/auth/me')]);
if (user && homeFor(user) !== '/') location.replace(homeFor(user));
else { setUser(user); router.run(); }
