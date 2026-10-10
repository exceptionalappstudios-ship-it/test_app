import {
  $, $$, api, esc, formatDate, formatShortDate, formatPhone, formatWhen, dayParts, plural, statusChip, photoTag, contactButtons,
  toast, openSheet, confirmSheet, busy, createRouter, goBack, replaceHash, phoneField, tenDigits, isTenDigits, liveStream, homeFor, enablePush, pushSupported, registerServiceWorker, askForAlerts, PERIOD_ICONS,
  minutesLeft, stars,
} from './common.js';
import { icons } from './icons.js';
import { renderLogin, renderProfileSetup } from './login.js';
import { photoPicker, uploadPhoto } from './photo.js';

const outlet = $('#app');
let user = null;
let config = null;
let stopStream = null;

const TABS = [['book', 'Book', icons.calendar], ['visit', 'My pass', icons.ticket], ['updates', 'Updates', icons.bell], ['profile', 'Me', icons.user]];
// One line with an icon, a small label and a value (used on review and pass).
const fact = (icon, k, v) => `<div class="fact"><span class="ic">${icon}</span><div><div class="k">${esc(k)}</div><div class="v">${v}</div></div></div>`;
const firstName = (name) => String(name ?? '').split(' ')[0];
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
    askForAlerts(config.vapidPublicKey, 'Know at once when your visit is confirmed and when your pass is ready.');
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
  header('Meet Gurudev 🙏', 'Book your visit in 2 minutes');
  renderLogin(ctx.el, {
    onDone: (u) => {
      if (homeFor(u) !== '/') { location.href = homeFor(u); return; }
      setUser(u);
      location.hash = u.profileComplete ? '#/book' : '#/setup';
    },
    footer: '<p class="center small muted" style="margin-top:18px">Security staff? <a href="/security.html">Log in here</a></p>',
  });
}

function setupView(ctx) {
  header('Welcome 🙏', 'Your name and photo');
  renderProfileSetup(ctx.el, user, { onDone: (u) => { setUser(u); location.hash = '#/book'; } });
}

// ---- Book ----------------------------------------------------------------------------
// Each step has its own address (#/book, #/book/reference, #/book/purpose, #/book/people,
// #/book/review) so the phone's Back button goes one step back. The answers
// are kept in `draft` while moving between steps.

let draft = null;
let bookingDays = [];
const STEP_TITLES = {
  when: ['Book a visit', 'Pick a day'],
  reference: ['Who referred you?', 'Pick a name, type their number'],
  purpose: ['How many and why?', 'Almost done'],
  people: ['Who is coming?', 'Name and number of each person'],
  review: ['All correct?', 'Check and send'],
};
const stepList = () => ['when', 'reference', 'purpose', ...(draft?.count > 1 ? ['people'] : []), 'review'];
const stepHash = (step) => (step === 'when' ? '#/book' : `#/book/${step}`);
function stepHeader(step) {
  const steps = stepList();
  header(...STEP_TITLES[step], steps.length, steps.indexOf(step) + 1);
}
const go = (step) => { location.hash = stepHash(step); };
const normal = (p) => `+91${tenDigits(p)}`;
const maxPeople = () => Math.max(1, Math.min(config.maxPeople, draft?.session?.remaining ?? config.maxPeople));
const problemBox = (msg) => (msg ? `<div class="notice bad" style="margin-bottom:14px">${icons.alert}<span>${esc(msg)}</span></div>` : '');

// Step 1: day and morning / evening.
async function bookWhenView(ctx) {
  stepHeader('when');
  const [avail, me] = await Promise.all([api('/api/availability'), api('/api/me')]);
  if (!ctx.isCurrent()) return;
  const { days } = avail;
  const existing = me.appointments.find((a) => a.upcoming);
  if (existing) {
    header('Book a visit', '');
    ctx.el.innerHTML = `<div class="card center">
      <div class="big-icon wait">${icons.ticket}</div>
      <h2>You already have a visit</h2>
      <div class="chips-row"><span class="pill">${icons.calendar} ${esc(formatShortDate(existing.date))}</span><span class="pill">${PERIOD_ICONS[existing.period] ?? icons.clock} ${esc(existing.periodLabel)}</span></div>
      <p class="sub" style="margin-top:12px">One visit at a time.</p>
      <a class="btn block" href="#/visit">${icons.ticket} See my pass</a></div>`;
    return;
  }
  if (avail.closed) {
    header('Book a visit', '');
    ctx.el.innerHTML = `<div class="card center"><div class="big-icon wait">${icons.calendar}</div><h2>Bookings closed</h2><p class="sub">${esc(avail.closedMessage)}</p></div>`;
    return;
  }
  bookingDays = days;
  draft ??= { date: days[0]?.date ?? null, session: null, phone: user.phone, referenceId: '', refPhone: '', refOk: false, count: 1, purposes: [], description: '', people: [], conflicts: {} };
  if (!days.length) {
    ctx.el.innerHTML = `<div class="card center"><div class="big-icon wait">${icons.calendar}</div><h2>No dates yet</h2><p class="sub">Please check again soon 🙏</p></div>`;
    return;
  }
  if (!days.some((d) => d.date === draft.date)) { draft.date = days[0].date; draft.session = null; }
  const render = () => {
    const day = days.find((d) => d.date === draft.date);
    const byPeriod = Object.fromEntries(day.sessions.map((x) => [x.period, x]));
    ctx.el.innerHTML = `
      <div class="card">
        <h3>${icons.calendar.replace('<svg', '<svg width="20" height="20" style="vertical-align:-4px;color:var(--blue-700)"')} Pick a day</h3>
        <div class="date-strip" role="listbox" aria-label="Day">
          ${days.map((d) => { const p = dayParts(d.date); return `<button type="button" class="date-pill ${d.date === draft.date ? 'on' : ''}" data-date="${d.date}" role="option" aria-selected="${d.date === draft.date}"><div class="dow">${esc(p.dow)}</div><div class="day">${esc(p.day)}</div><div class="mon">${esc(p.mon)}</div></button>`; }).join('')}
        </div>
        <h3 style="margin-top:8px">${esc(formatDate(draft.date))}</h3>
        <div class="choices">
          ${Object.keys(config.periods).map((p) => {
            const x = byPeriod[p];
            const full = !x || x.remaining < 1;
            return `<button type="button" class="choice ${x && draft.session?.id === x.id ? 'on' : ''}" data-session="${x?.id ?? ''}" ${full ? 'disabled' : ''}>
              <span class="ic">${PERIOD_ICONS[p]}</span>
              <span><span class="t">${esc(config.periods[p].label)}</span><br><span class="d">${!x ? 'Not open' : full ? 'Full' : x.remaining < 10 ? `${x.remaining} places left` : '✓ Open'}</span></span>
              <span class="tick">${icons.check}</span></button>`;
          }).join('')}
        </div>
      </div>
      <button class="btn block" data-next ${draft.session ? '' : 'disabled'}>Continue ${icons.next}</button>`;
    const strip = $('.date-strip', ctx.el);
    strip.querySelector('.on')?.scrollIntoView({ inline: 'center', block: 'nearest' });
    strip.addEventListener('click', (e) => {
      const b = e.target.closest('[data-date]');
      if (b && b.dataset.date !== draft.date) { draft.date = b.dataset.date; draft.session = null; render(); }
    });
    $$('[data-session]', ctx.el).forEach((b) => b.addEventListener('click', () => {
      draft.session = day.sessions.find((x) => x.id === Number(b.dataset.session));
      draft.count = Math.min(draft.count, maxPeople());
      render();
    }));
    $('[data-next]', ctx.el).addEventListener('click', () => go('reference'));
  };
  render();
}

// Step 2: who referred them. The number is checked before moving on.
function bookReferenceView(ctx, problem = '') {
  if (!draft?.session) { replaceHash('#/book'); return; }
  stepHeader('reference');
  ctx.el.innerHTML = `
    <form class="card" novalidate>
      <div class="stamp-sm">🙏</div>
      <label for="referenceId" style="margin-top:0">Pick a name</label>
      <select id="referenceId">
        <option value="">Choose…</option>
        ${config.references.map((r) => `<option value="${esc(r.id)}" ${r.id === draft.referenceId ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}
      </select>
      <label for="refPhone">Their phone number</label>
      ${phoneField('refPhone', draft.refPhone)}
      <div class="hint">You can book only with the right number.</div>
    </form>
    ${problemBox(problem)}
    <div class="actions" style="margin-top:0"><button class="btn light" data-back>${icons.back} Back</button><button class="btn" data-next>Next ${icons.next}</button></div>`;
  const keep = () => {
    const referenceId = $('#referenceId', ctx.el).value;
    const refPhone = $('#refPhone', ctx.el).value.trim();
    if (referenceId !== draft.referenceId || tenDigits(refPhone) !== tenDigits(draft.refPhone)) draft.refOk = false;
    draft.referenceId = referenceId;
    draft.refPhone = refPhone;
  };
  $('[data-back]', ctx.el).addEventListener('click', () => { keep(); goBack('#/book'); });
  $('form', ctx.el).addEventListener('submit', (e) => { e.preventDefault(); $('[data-next]', ctx.el).click(); });
  $('[data-next]', ctx.el).addEventListener('click', async (e) => {
    keep();
    const msg = !draft.referenceId ? 'Please pick who referred you.' : !isTenDigits(draft.refPhone) ? 'Please type their 10-digit number.' : '';
    if (msg) return bookReferenceView(ctx, msg);
    if (!draft.refOk) {
      try {
        await busy(e.currentTarget, () => api('/api/reference/check', { method: 'POST', body: { referenceId: draft.referenceId, refPhone: tenDigits(draft.refPhone) } }), { quiet: true });
        draft.refOk = true;
      } catch (err) {
        return bookReferenceView(ctx, err.message);
      }
    }
    go('purpose');
  });
}

// Step 3: how many people and why.
function bookPurposeView(ctx, problem = '') {
  if (!draft?.session) { replaceHash('#/book'); return; }
  if (!draft.refOk) { replaceHash('#/book/reference'); return; }
  stepHeader('purpose');
  ctx.el.innerHTML = `
    <div class="card">
      <div class="label" style="margin-top:0">👥 How many people? <span class="muted small">(with you)</span></div>
      <div class="stepper">
        <button type="button" data-dec aria-label="Fewer people">${icons.minus}</button>
        <span class="n">${draft.count}</span>
        <button type="button" data-inc aria-label="More people">${icons.plus}</button>
        <span class="muted small">${draft.count === 1 ? 'Just me' : `You + ${plural(draft.count - 1, 'person', 'people')}`}</span>
      </div>
      <div class="hint">${maxPeople() < config.maxPeople ? `Only ${maxPeople()} places left` : `Up to ${config.maxPeople}`}</div>
    </div>
    <div class="card">
      <div class="label" style="margin-top:0">🎯 Why are you coming? <span class="muted small">(pick one or more)</span></div>
      <div class="choices">
        ${Object.entries(config.purposes).map(([key, label]) => `
          <button type="button" class="choice check ${draft.purposes.includes(key) ? 'on' : ''}" data-purpose="${key}" aria-pressed="${draft.purposes.includes(key)}">
            <span class="t" style="font-weight:600">${esc(label)}</span><span class="tick">${icons.check}</span></button>`).join('')}
      </div>
      <label for="description">✍️ A few words ${draft.purposes.includes('other') ? '' : '<span class="muted small">(optional)</span>'}</label>
      <textarea id="description" maxlength="500" placeholder="e.g. Blessings for my daughter's wedding">${esc(draft.description)}</textarea>
    </div>
    ${problemBox(problem)}
    <div class="actions" style="margin-top:0"><button class="btn light" data-back>${icons.back} Back</button><button class="btn" data-next>Next ${icons.next}</button></div>`;
  const keep = () => { draft.description = $('#description', ctx.el).value; };
  const setCount = (n) => { keep(); draft.count = Math.max(1, Math.min(maxPeople(), n)); draft.people = draft.people.slice(0, draft.count - 1); bookPurposeView(ctx); };
  $('[data-dec]', ctx.el).addEventListener('click', () => setCount(draft.count - 1));
  $('[data-inc]', ctx.el).addEventListener('click', () => setCount(draft.count + 1));
  // Ticking a reason only updates that button, so the page doesn't jump.
  $$('[data-purpose]', ctx.el).forEach((b) => b.addEventListener('click', () => {
    const k = b.dataset.purpose;
    draft.purposes = draft.purposes.includes(k) ? draft.purposes.filter((p) => p !== k) : [...draft.purposes, k];
    b.classList.toggle('on', draft.purposes.includes(k));
    b.setAttribute('aria-pressed', draft.purposes.includes(k));
    if (k === 'other') { keep(); bookPurposeView(ctx); }
  }));
  $('[data-back]', ctx.el).addEventListener('click', () => { keep(); goBack('#/book/reference'); });
  $('[data-next]', ctx.el).addEventListener('click', () => {
    keep();
    const msg = !draft.purposes.length ? 'Please pick why you are coming.'
      : draft.purposes.includes('other') && !draft.description.trim() ? 'Please write a few words.' : '';
    if (msg) return bookPurposeView(ctx, msg);
    go(draft.count > 1 ? 'people' : 'review');
  });
}

// Step 3: the other people in the group. Each number is checked as soon as
// all 10 digits are typed, and a warning clears as soon as the number changes.
function bookPeopleView(ctx, problem = '') {
  if (!draft?.session || draft.count < 2) { replaceHash('#/book'); return; }
  stepHeader('people');
  while (draft.people.length < draft.count - 1) draft.people.push({ name: '', phone: '' });
  const own = draft.conflicts[normal(draft.phone)] ?? draft.conflicts[user.phone];
  ctx.el.innerHTML = `
    ${own ? problemBox(own) : ''}
    ${draft.people.map((p, i) => `<div class="card" data-person="${i}">
        <div class="row" style="justify-content:space-between"><h3 style="margin:0">👤 Person ${i + 2}</h3>
          <button type="button" class="btn ghost small" data-remove="${i}" style="color:var(--red)">${icons.trash} Remove</button></div>
        <label for="pn${i}">Name</label>
        <input id="pn${i}" data-field="name" maxlength="80" value="${esc(p.name)}" placeholder="Name">
        <label for="pp${i}">Phone number</label>
        ${phoneField(`pp${i}`, p.phone)}
        <div data-warn></div>
      </div>`).join('')}
    <div data-problem>${problemBox(problem)}</div>
    <div class="actions" style="margin-top:0"><button class="btn light" data-back>${icons.back} Back</button><button class="btn" data-next>Continue ${icons.next}</button></div>`;

  const cards = $$('[data-person]', ctx.el);
  const keep = () => cards.forEach((card) => {
    const p = draft.people[Number(card.dataset.person)];
    p.name = $('[data-field=name]', card).value.trim();
    p.phone = tenDigits($('[data-phone]', card).value);
  });
  // A warning for one person, or none.
  const warningFor = (i) => {
    const p = draft.people[i];
    if (!isTenDigits(p.phone)) return '';
    const mine = normal(p.phone);
    if (mine === normal(draft.phone) || mine === user.phone) return 'This is your number. Please type their number.';
    const other = draft.people.findIndex((q, j) => j !== i && isTenDigits(q.phone) && normal(q.phone) === mine);
    if (other >= 0) return `Same as person ${other + 2}. Each person needs their own number.`;
    return draft.conflicts[mine] ?? '';
  };
  const showWarnings = () => {
    cards.forEach((card) => {
      const w = warningFor(Number(card.dataset.person));
      $('[data-warn]', card).innerHTML = w ? `<div class="notice bad" style="margin-top:10px">${icons.alert}<span>${esc(w)}</span></div>` : '';
    });
  };
  showWarnings();

  cards.forEach((card) => {
    const input = $('[data-phone]', card);
    input.addEventListener('input', () => {
      keep();
      $('[data-problem]', ctx.el).innerHTML = '';
      showWarnings();
      // Ask the server about this number as soon as it is complete.
      const p = draft.people[Number(card.dataset.person)];
      if (isTenDigits(p.phone) && !(normal(p.phone) in draft.conflicts)) {
        api('/api/appointments/check', { method: 'POST', body: { phones: [p.phone] } }).then(({ conflicts }) => {
          draft.conflicts[normal(p.phone)] = conflicts[0]?.message ?? '';
          if (ctx.isCurrent()) showWarnings();
        }).catch(() => {});
      }
    });
  });
  $$('[data-remove]', ctx.el).forEach((b) => b.addEventListener('click', () => {
    keep();
    draft.people.splice(Number(b.dataset.remove), 1);
    draft.count -= 1;
    if (draft.count === 1) replaceHash('#/book/purpose'); else bookPeopleView(ctx);
  }));
  $('[data-back]', ctx.el).addEventListener('click', () => { keep(); goBack('#/book/purpose'); });
  $('[data-next]', ctx.el).addEventListener('click', async (e) => {
    keep();
    const missing = draft.people.findIndex((p) => p.name.length < 2 || !isTenDigits(p.phone));
    if (missing >= 0) return bookPeopleView(ctx, `Please add the name and number of person ${missing + 2}.`);
    const { conflicts } = await busy(e.currentTarget, () => api('/api/appointments/check', { method: 'POST', body: { phones: [normal(draft.phone), user.phone, ...draft.people.map((p) => normal(p.phone))] } }));
    draft.conflicts = Object.fromEntries(conflicts.map((c) => [c.phone, c.message]));
    if (draft.people.some((_, i) => warningFor(i)) || draft.conflicts[normal(draft.phone)] || draft.conflicts[user.phone]) {
      return bookPeopleView(ctx, 'Please fix the numbers in red, or remove that person.');
    }
    go('review');
  });
}

// Step 4: check and send.
function bookReviewView(ctx, problem = '') {
  if (!draft?.session) { replaceHash('#/book'); return; }
  stepHeader('review');
  const refName = config.references.find((r) => r.id === draft.referenceId)?.name ?? '';
  // Each answer has a small "Change" link back to its step.
  const change = (hash) => `<a class="change" href="${hash}">${icons.edit} Change</a>`;
  const row = (icon, k, v, hash) => fact(icon, k, v).replace(/<\/div><\/div>$/, `</div>${change(hash)}</div>`);
  ctx.el.innerHTML = `
    <div class="card">
      <div class="hello">${photoTag(user.photo, user.name, 'lg')}<div class="grow">
        <div style="font-weight:800;font-size:1.15rem">${esc(user.name)}</div>
        <button type="button" class="btn ghost small" data-photo style="padding-left:0">${icons.camera} Change photo</button></div></div>
      <div data-wa class="wa-box">
        <div class="grow"><div class="k">${icons.whatsapp.replace('<svg', '<svg width="14" height="14" style="vertical-align:-2px;color:#0b7d3d"')} Pass will come to</div>
        <div class="big-number">${esc(formatPhone(normal(draft.phone)))}</div></div>
        <button type="button" class="change" data-change-wa>${icons.edit} Change</button>
      </div>
    </div>
    <div class="card">
      <div class="facts">
        ${row(icons.calendar, 'Day', esc(formatDate(draft.date)), '#/book')}
        ${row(PERIOD_ICONS[draft.session.period] ?? icons.clock, 'Time', esc(draft.session.label), '#/book')}
        ${row(icons.user, 'Referred by', esc(refName), '#/book/reference')}
        ${row(icons.users, 'People', `${esc(plural(draft.count, 'person', 'people'))}${draft.people.length ? `<div class="small muted" style="font-weight:500">${draft.people.map((p) => esc(p.name)).join(', ')}</div>` : ''}`, draft.count > 1 ? '#/book/people' : '#/book/purpose')}
        ${row(icons.info, 'Why', draft.purposes.map((p) => esc(config.purposes[p])).join(', '), '#/book/purpose')}
        ${draft.description.trim() ? row(icons.edit, 'Note', esc(draft.description), '#/book/purpose') : ''}
      </div>
    </div>
    <div class="notice info" style="margin-bottom:14px">${icons.whatsapp}<span>We will confirm on WhatsApp. <b>Your pass comes with it.</b></span></div>
    ${problemBox(problem)}
    <div class="actions" style="margin-top:0"><button class="btn light" data-back>${icons.back} Back</button><button class="btn" data-send>${icons.send} Send request</button></div>`;
  $('[data-photo]', ctx.el).addEventListener('click', () => changePhoto(() => bookReviewView(ctx)));
  $('[data-change-wa]', ctx.el).addEventListener('click', () => {
    $('[data-wa]', ctx.el).innerHTML = `<div class="grow"><label for="wa" style="margin-top:0">WhatsApp number</label>${phoneField('wa', draft.phone)}</div>`;
    $('#wa', ctx.el).focus();
  });
  $('[data-back]', ctx.el).addEventListener('click', () => goBack(draft.count > 1 ? '#/book/people' : '#/book/purpose'));
  $('[data-send]', ctx.el).addEventListener('click', async (e) => {
    const wa = $('#wa', ctx.el);
    if (wa) {
      if (!isTenDigits(tenDigits(wa.value))) { toast('Please type your 10-digit WhatsApp number.'); wa.focus(); return; }
      draft.phone = tenDigits(wa.value);
    }
    try {
      const { appointment } = await busy(e.currentTarget, () => api('/api/appointments', { method: 'POST', body: {
        sessionId: draft.session.id, phone: normal(draft.phone), referenceId: draft.referenceId, refPhone: tenDigits(draft.refPhone),
        peopleCount: draft.count, people: draft.people.map((p) => ({ name: p.name, phone: normal(p.phone) })), purposes: draft.purposes, description: draft.description,
      } }), { quiet: true });
      draft = null;
      // The finished booking replaces the steps in the history, so Back doesn't reopen them.
      sessionDone = appointment;
      replaceHash('#/book/done');
    } catch (err) {
      if (err.data?.conflicts?.length) {
        draft.conflicts = Object.fromEntries(err.data.conflicts.map((c) => [c.phone, c.message]));
        if (draft.count > 1) replaceHash('#/book/people'); else bookReviewView(ctx, err.message);
      } else if (err.status === 409 || err.status === 400) bookReviewView(ctx, err.message);
      else toast(err.message);
    }
  });
}

let sessionDone = null;
function bookDoneView(ctx) {
  const a = sessionDone;
  if (!a) { replaceHash('#/visit'); return; }
  header('Request sent 🙏', '');
  ctx.el.innerHTML = `<div class="card center">
    <div class="big-icon ok">${icons.checkCircle}</div>
    <h2>Thank you, ${esc(firstName(user.name))}!</h2>
    <div class="chips-row">
      <span class="pill">${icons.calendar} ${esc(formatShortDate(a.date))}</span>
      <span class="pill">${PERIOD_ICONS[a.period] ?? icons.clock} ${esc(a.periodLabel)}</span>
      <span class="pill">${icons.users} ${esc(String(a.peopleCount))}</span>
    </div>
    <p class="sub" style="margin-top:14px">${icons.whatsapp.replace('<svg', '<svg width="16" height="16" style="vertical-align:-3px;color:#0b7d3d"')} We will confirm on WhatsApp soon.</p>
    <a class="btn block" href="#/visit">${icons.ticket} See my pass</a></div>`;
}

function changePhoto(after) {
  let blob = null;
  const { el, close } = openSheet(`<h2 style="margin:0 0 4px">📷 New photo</h2><div data-picker></div>
    <div class="actions"><button class="btn light" data-close>Cancel</button><button class="btn" data-save disabled>${icons.check} Save photo</button></div>`);
  const save = $('[data-save]', el);
  photoPicker($('[data-picker]', el), { current: user.photo, onChange: (b) => { blob = b; save.disabled = !b; } });
  save.addEventListener('click', async () => {
    const { user: u } = await busy(save, () => uploadPhoto(blob));
    setUser(u);
    close();
    toast('Photo saved ✓');
    after?.();
  });
}

// ---- My visit -----------------------------------------------------------------------

let clockOffset = 0; // server time minus phone time
let visitEnds = 0;
async function visitView(ctx) {
  header('My pass', '');
  const render = async () => {
    const { appointments, serverTime } = await api('/api/me');
    if (!ctx.isCurrent()) return;
    clockOffset = new Date(serverTime) - Date.now();
    const recent = new Date(Date.now() + clockOffset - 2 * 86400000).toISOString().slice(0, 10);
    // The visit to show: upcoming, ready, or checked in lately (until feedback is given).
    const current = appointments.find((a) => a.upcoming || a.pass.state === 'ready'
      || (a.pass.state === 'checked_in' && a.date >= recent && (!a.feedbackRating || a.date >= new Date(Date.now() + clockOffset).toISOString().slice(0, 10))));
    const past = appointments.filter((a) => a !== current);
    const when = (a) => `<div class="chips-row">
      <span class="pill">${icons.calendar} ${esc(formatShortDate(a.date))}</span>
      <span class="pill">${PERIOD_ICONS[a.period] ?? icons.clock} ${esc(a.periodLabel)}</span>
      <span class="pill">${icons.users} ${esc(String(a.peopleCount))}</span></div>`;
    // The pass: one colour per state, big and simple.
    let ticket = '';
    visitEnds = current?.visitEndsAt ? new Date(current.visitEndsAt) : 0;
    if (current) {
      const p = current.pass;
      if (p.state === 'ready') {
        const { pass } = await api(`/api/me/appointments/${current.id}/pass`);
        if (!ctx.isCurrent()) return;
        ticket = pass.state === 'ready' ? `<div class="ticket">
          <div class="band ${pass.today ? 'go' : 'soon'}">${icons.checkCircle} ${pass.today ? 'Ready · Show at the gate' : `Confirmed · ${esc(formatShortDate(pass.validOn))}`}</div>
          <div class="body">
            <div class="qr ${pass.today ? 'glow' : ''}">${pass.svg}</div>
            <div class="code-label">ENTRY CODE</div>
            <div class="code">${esc(pass.code)}</div>
            <div class="who">${esc(current.name)}</div>
            ${when(current)}
            <p class="small muted" style="margin:12px 0 0">✓ Any time that day &nbsp;·&nbsp; ✓ One scan only</p>
          </div></div>` : '';
      } else if (p.state === 'checked_in' && minutesLeft(current, clockOffset) > 0) {
        ticket = `<div class="ticket"><div class="band done">${icons.checkCircle} Checked in</div><div class="body">
          <div class="stamp go">${icons.check}</div><h2>Welcome 🙏</h2>
          <div class="time-left"><span data-left>${minutesLeft(current, clockOffset)}</span> min left</div>
          <p class="small muted" style="margin:10px 0 0">Your visit time is 30 minutes</p></div></div>`;
      } else if (p.state === 'checked_in') {
        ticket = `<div class="ticket used"><div class="band off">${icons.checkCircle} Visit complete</div><div class="body">
          <div class="who" style="margin-top:0">${esc(current.name)}</div>${when(current)}
          ${current.feedbackRating ? `<div class="thanks"><div>${stars(current.feedbackRating, 30)}</div><p class="sub" style="margin:6px 0 0">Thank you for your feedback 🙏</p></div>`
            : `<div class="rate" data-rate>
              <h2 style="margin-top:14px">How was your visit?</h2>
              <div class="star-pick" role="radiogroup" aria-label="Rating">${[1, 2, 3, 4, 5].map((n) => `<button type="button" data-star="${n}" role="radio" aria-checked="false" aria-label="${n} star${n > 1 ? 's' : ''}">★</button>`).join('')}</div>
              <textarea data-comment maxlength="500" placeholder="Anything to share? (optional)" hidden></textarea>
              <button class="btn block" data-send-rating hidden>${icons.send} Send</button></div>`}
        </div></div>`;
      } else if (['pending', 'hold'].includes(current.status)) {
        ticket = `<div class="ticket"><div class="band wait">${icons.clock} Waiting for confirmation</div><div class="body">
          <div class="stamp wait">${icons.clock}</div><div class="who" style="margin-top:0">${esc(current.name)}</div>${when(current)}
          <p class="sub" style="margin-top:12px">${icons.whatsapp.replace('<svg', '<svg width="16" height="16" style="vertical-align:-3px;color:#0b7d3d"')} We will tell you on WhatsApp.</p></div></div>`;
      }
    }
    ctx.el.innerHTML = current ? `
      ${ticket}
      <div class="card">
        <div class="facts">
          ${fact(icons.user, 'Referred by', esc(current.reference))}
          ${current.people.length ? fact(icons.users, 'With you', current.people.map((x) => esc(x.name)).join(', ')) : ''}
          ${fact(icons.whatsapp, 'WhatsApp', esc(formatPhone(current.phone)))}
          ${current.adminNote ? fact(icons.info, 'Note from the ashram', `<strong>${esc(current.adminNote)}</strong>`) : ''}
        </div>
        ${!current.checkedInAt ? `<div class="actions"><button class="btn danger small" data-cancel="${current.id}">${icons.x} Cancel visit</button></div>` : ''}
      </div>` : `
      <div class="ticket"><div class="band off">${icons.ticket} No pass yet</div><div class="body">
        <div class="stamp off">${icons.calendar}</div><h2>Book your visit</h2><p class="sub">Pick a day to meet Gurudev 🙏</p>
        <a class="btn block" href="#/book">${icons.calendar} Book a visit</a></div></div>`;
    if (past.length) {
      ctx.el.insertAdjacentHTML('beforeend', `<div class="section-title">Earlier</div><div class="card flush">${past.map((a) => `
        <div class="person"><div class="grow"><div class="name">${esc(formatShortDate(a.date))} · ${esc(a.periodLabel)}</div><div class="meta">${esc(plural(a.peopleCount, 'person', 'people'))}</div></div>${statusChip(a.status, a.checkedInAt)}</div>`).join('')}</div>`);
    }
    // Stars: tap one, then send (a note is optional).
    const rate = $('[data-rate]', ctx.el);
    if (rate) {
      let rating = 0;
      $$('[data-star]', rate).forEach((b) => b.addEventListener('click', () => {
        rating = Number(b.dataset.star);
        $$('[data-star]', rate).forEach((x) => { x.classList.toggle('on', Number(x.dataset.star) <= rating); x.setAttribute('aria-checked', String(x === b)); });
        $('[data-comment]', rate).hidden = false;
        $('[data-send-rating]', rate).hidden = false;
      }));
      $('[data-send-rating]', rate).addEventListener('click', async (e) => {
        await busy(e.currentTarget, () => api(`/api/me/appointments/${current.id}/feedback`, { method: 'POST', body: { rating, comment: $('[data-comment]', rate).value } }));
        toast('Thank you 🙏');
        render();
      });
    }
    $('[data-cancel]', ctx.el)?.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      if (!await confirmSheet({ title: 'Cancel your visit?', message: 'Your place will go to someone else.', confirm: 'Yes, cancel', danger: true })) return;
      await busy(btn, () => api(`/api/me/appointments/${btn.dataset.cancel}/cancel`, { method: 'POST' }));
      toast('Visit cancelled');
      render();
    });
  };
  await render();
  onUpdate(ctx, render);
  // The countdown ticks on its own; the screen refreshes when the visit ends.
  const tick = setInterval(() => {
    const el = $('[data-left]', ctx.el);
    if (!el) return;
    const left = Math.max(0, Math.ceil((visitEnds - (Date.now() + clockOffset)) / 60000));
    if (left <= 0) render(); else el.textContent = left;
  }, 15000);
  const timer = setInterval(() => { if (!$('[data-rate] textarea:not([hidden])', ctx.el)) render(); }, 60000);
  ctx.onCleanup(() => { clearInterval(timer); clearInterval(tick); });
}

// ---- Updates ---------------------------------------------------------------------------

// Each update gets a colour and an icon, so its meaning is clear at a glance.
function noteStyle(title) {
  const t = title.toLowerCase();
  if (/declined|cancel|removed|not approved|sorry/.test(t)) return ['red', icons.xCircle];
  if (/confirmed|approved|pass|checked in|welcome/.test(t)) return ['green', /pass/.test(t) ? icons.ticket : icons.checkCircle];
  if (/how was|rate/.test(t)) return ['amber', '<span style="font-size:20px;line-height:1">⭐</span>'];
  if (/today|tomorrow|reminder/.test(t)) return ['amber', icons.sun];
  return ['blue', icons.bell];
}

async function updatesView(ctx) {
  header('Updates', 'Also sent on WhatsApp');
  const render = async () => {
    const { notifications, unread } = await api('/api/me');
    if (!ctx.isCurrent()) return;
    ctx.el.innerHTML = notifications.length ? `<div class="feed">${notifications.map((n) => {
      const [tone, icon] = noteStyle(n.title);
      // Updates about a visit open "My pass" when tapped.
      const tag = n.appointment_id ? 'a' : 'div';
      return `<${tag} class="note ${tone} ${n.read_at ? '' : 'unread'}"${n.appointment_id ? ' href="#/visit"' : ''}><span class="ic">${icon}</span>
        <div class="grow"><div class="t">${esc(n.title)}</div><div class="b">${esc(n.body)}</div><div class="w">${esc(formatWhen(n.created_at))}</div></div>${n.appointment_id ? `<span class="go">${icons.next}</span>` : ''}</${tag}>`;
    }).join('')}</div>` : `<div class="ticket"><div class="band off">${icons.bell} No updates yet</div><div class="body"><p class="sub" style="margin:0">News about your visit will show here 🙏</p></div></div>`;
    if (unread) { await api('/api/me/notifications/read', { method: 'POST' }); refreshBadge(); }
  };
  await render();
  onUpdate(ctx, render);
}

// ---- Profile -----------------------------------------------------------------------------

async function profileView(ctx) {
  header('Me', '');
  const c = config.contact;
  ctx.el.innerHTML = `
    <div class="card center">
      ${photoTag(user.photo, user.name, 'xl')}
      <h2 style="margin-top:10px">${esc(user.name)}</h2>
      <p class="sub">${esc(formatPhone(user.phone))}</p>
      <button class="btn light small" data-photo>${icons.camera} Change photo</button>
    </div>
    <form class="card" data-name novalidate>
      <label for="name" style="margin-top:0">Your name</label>
      <input id="name" name="name" maxlength="80" value="${esc(user.name)}">
      <div class="actions"><button class="btn small" type="submit">Save name</button></div>
    </form>
    ${pushSupported() && Notification.permission !== 'granted' ? `<div class="card row"><div class="grow"><strong>🔔 Get alerts</strong><div class="small muted">Even when the app is closed</div></div><button class="btn small blue" data-push>Turn on</button></div>` : ''}
    ${c.phone || c.whatsapp ? `<div class="card"><h3>🙋 Need help?</h3><div class="row"><div class="grow small muted">${c.address ? esc(c.address) : 'Call or WhatsApp us'}</div>${contactButtons(c.whatsapp ?? c.phone)}</div></div>` : ''}
    <button class="btn danger block" data-logout>${icons.logout} Log out</button>`;
  $('[data-photo]', ctx.el).addEventListener('click', () => changePhoto(() => profileView(ctx)));
  $('[data-name]', ctx.el).addEventListener('submit', async (e) => {
    e.preventDefault();
    const { user: u } = await busy($('button', e.target), () => api('/api/auth/me', { method: 'PATCH', body: { name: e.target.name.value } }));
    setUser(u);
    toast('Name saved ✓');
  });
  $('[data-push]', ctx.el)?.addEventListener('click', async (e) => {
    try { await enablePush(config.vapidPublicKey); e.target.closest('.card').remove(); toast('Alerts are on 🔔'); } catch (err) { toast(err.message); }
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
    { path: /^#\/book$/, view: bookWhenView, tab: 'book' },
    { path: /^#\/book\/reference$/, view: (ctx) => bookReferenceView(ctx), tab: 'book', back: '#/book' },
    { path: /^#\/book\/purpose$/, view: (ctx) => bookPurposeView(ctx), tab: 'book', back: '#/book/reference' },
    { path: /^#\/book\/people$/, view: (ctx) => bookPeopleView(ctx), tab: 'book', back: '#/book/purpose' },
    { path: /^#\/book\/review$/, view: (ctx) => bookReviewView(ctx), tab: 'book', back: () => (draft?.count > 1 ? '#/book/people' : '#/book/purpose') },
    { path: /^#\/book\/done$/, view: bookDoneView, tab: 'book' },
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
