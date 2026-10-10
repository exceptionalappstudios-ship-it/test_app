// WhatsApp-number login with a one-time code, and the "add your name and
// photo" step that every new account goes through.
import { $, api, esc, formatPhone, busy, phoneField, isTenDigits } from './common.js';
import { icons } from './icons.js';
import { photoPicker, uploadPhoto } from './photo.js';

export function renderLogin(el, { signupAs = 'visitor', onDone, footer = '' }) {
  let phone = '';
  let timer = null;

  function phoneStep(error = '') {
    clearInterval(timer);
    el.innerHTML = `
      <form class="card narrow" novalidate>
        <h2>${icons.whatsapp.replace('<svg', '<svg width="22" height="22" style="vertical-align:-4px;color:#0b7d3d"')} Your WhatsApp number</h2>
        <p class="sub">We will send you a code.</p>
        <label for="phone" class="sr-only">WhatsApp number</label>
        ${phoneField('phone', phone)}
        ${error ? `<div class="notice bad" style="margin-top:12px">${icons.alert}<span>${esc(error)}</span></div>` : ''}
        <div class="actions"><button class="btn block" type="submit">Get code ${icons.next}</button></div>
      </form>${footer}`;
    const form = $('form', el);
    $('#phone', el).focus();
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const value = form.querySelector('#phone').value.trim();
      if (!isTenDigits(value)) return phoneStep('Please type your 10-digit number.');
      try {
        const res = await busy($('button', form), () => api('/api/auth/otp/request', { method: 'POST', body: { phone: value } }));
        phone = res.phone;
        codeStep(res);
      } catch (err) {
        phoneStep(err.message);
      }
    });
  }

  function codeStep({ testCode, isNew }, error = '') {
    el.innerHTML = `
      <form class="card narrow" novalidate>
        <h2>🔑 Type the code</h2>
        <p class="sub">Sent on WhatsApp to <strong>${esc(formatPhone(phone))}</strong></p>
        ${testCode ? `<div class="notice info">${icons.info}<span>Test mode · Your code: <strong style="letter-spacing:.15em">${esc(testCode)}</strong></span></div>` : ''}
        <label for="code" class="sr-only">6-digit code</label>
        <input id="code" name="code" class="otp-input" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]*" required>
        ${error ? `<div class="notice bad" style="margin-top:12px">${icons.alert}<span>${esc(error)}</span></div>` : ''}
        <div class="actions"><button class="btn block" type="submit">${icons.check} ${isNew ? 'Continue' : 'Log in'}</button></div>
        <div class="row" style="justify-content:space-between;margin-top:8px">
          <button type="button" class="btn ghost small" data-change>${icons.back} Change</button>
          <button type="button" class="btn ghost small" data-resend disabled>Send again</button>
        </div>
      </form>`;
    const form = $('form', el);
    const code = $('#code', el);
    code.focus();
    const resend = $('[data-resend]', el);
    let wait = 30;
    clearInterval(timer);
    const tick = () => { resend.textContent = wait > 0 ? `Resend in ${wait}s` : 'Resend code'; resend.disabled = wait > 0; wait--; };
    tick();
    timer = setInterval(() => { tick(); if (wait < -1) clearInterval(timer); }, 1000);
    $('[data-change]', el).addEventListener('click', () => phoneStep());
    resend.addEventListener('click', async () => {
      try { codeStep(await api('/api/auth/otp/request', { method: 'POST', body: { phone } })); } catch (err) { codeStep({ isNew }, err.message); }
    });
    code.addEventListener('input', () => {
      code.value = code.value.replace(/\D/g, '').slice(0, 6);
      if (code.value.length === 6) form.requestSubmit();
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (code.value.length !== 6) return;
      try {
        const { user } = await busy($('button[type=submit]', form), () => api('/api/auth/otp/verify', { method: 'POST', body: { phone, code: code.value, signupAs } }));
        clearInterval(timer);
        onDone(user);
      } catch (err) {
        codeStep({ testCode, isNew }, err.message);
      }
    });
  }

  phoneStep();
}

// Name + face photo. Everyone fills this in once. Security staff also choose
// the reference who will approve them (`references`), and their photo must
// show a face (`requireFace`).
export function renderProfileSetup(el, user, { onDone, references = null, requireFace = false, intro = 'Only once 🙏' }) {
  let blob = null;
  el.innerHTML = `
    <form class="card narrow" novalidate>
      <h2>About you</h2>
      <p class="sub">${esc(intro)}</p>
      <label for="name">Your full name</label>
      <input id="name" name="name" autocomplete="name" maxlength="80" required value="${esc(user.name ?? '')}" placeholder="As on your ID card">
      ${references ? `
      <label for="referenceId">Your reference</label>
      <select id="referenceId">
        <option value="">Choose your reference</option>
        ${references.map((r) => `<option value="${esc(r.id)}" ${r.id === user.referenceId ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}
      </select>
      <div class="hint">Only they can approve you.</div>` : ''}
      <div class="label">📷 Your photo</div>
      <div data-photo></div>
      <div data-error></div>
      <div class="actions"><button class="btn block" type="submit">${icons.check} Save</button></div>
    </form>`;
  const form = $('form', el);
  const save = $('button[type=submit]', form);
  const hasPhoto = Boolean(user.photo);
  photoPicker($('[data-photo]', el), { current: user.photo, requireFace, onChange: (b) => { blob = b; } });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('[data-error]', el);
    const name = form.name.value.trim();
    const referenceId = references ? $('#referenceId', el).value : undefined;
    const problem = name.length < 2 ? 'Please type your full name.'
      : references && !referenceId ? 'Please pick your reference.'
      : !blob && !hasPhoto ? (requireFace ? 'Please take a photo. Your face must be seen.' : 'Please add your photo.') : '';
    err.innerHTML = problem ? `<div class="notice bad" style="margin-top:12px">${icons.alert}<span>${esc(problem)}</span></div>` : '';
    if (problem) return;
    try {
      let updated = (await busy(save, () => api('/api/auth/me', { method: 'PATCH', body: { name, referenceId } }))).user;
      if (blob) updated = (await busy(save, () => uploadPhoto(blob))).user;
      onDone(updated);
    } catch { /* busy() showed the error */ }
  });
}
