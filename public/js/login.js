// WhatsApp-number login with a one-time code, and the "add your name and
// photo" step that every new account goes through.
import { $, api, esc, formatPhone, busy } from './common.js';
import { icons } from './icons.js';
import { photoPicker, uploadPhoto } from './photo.js';

export function renderLogin(el, { signupAs = 'visitor', onDone, footer = '' }) {
  let phone = '';
  let timer = null;

  function phoneStep(error = '') {
    clearInterval(timer);
    el.innerHTML = `
      <form class="card narrow" novalidate>
        <h2>Log in with WhatsApp</h2>
        <p class="sub">Enter your WhatsApp number. We will send you a 6-digit code on WhatsApp.</p>
        <label for="phone">WhatsApp number</label>
        <div class="phone-field"><span>+91</span><input id="phone" name="phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="98765 43210" required maxlength="20" value="${esc(phone.replace(/^\+91/, ''))}"></div>
        <div class="hint">Number from another country? Type + and your country code first.</div>
        ${error ? `<div class="notice bad" style="margin-top:12px">${icons.alert}<span>${esc(error)}</span></div>` : ''}
        <div class="actions"><button class="btn block" type="submit">${icons.whatsapp} Send code on WhatsApp</button></div>
      </form>${footer}`;
    const form = $('form', el);
    $('#phone', el).focus();
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const value = form.phone.value.trim();
      if (value.replace(/\D/g, '').length < 10) return phoneStep('Please enter your full WhatsApp number.');
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
        <h2>Enter the code</h2>
        <p class="sub">We sent a 6-digit code on WhatsApp to <strong>${esc(formatPhone(phone))}</strong>.</p>
        ${testCode ? `<div class="notice info">${icons.info}<span>Testing mode (WhatsApp is not set up yet): your code is <strong>${esc(testCode)}</strong></span></div>` : ''}
        <label for="code">6-digit code</label>
        <input id="code" name="code" class="otp-input" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]*" required>
        ${error ? `<div class="notice bad" style="margin-top:12px">${icons.alert}<span>${esc(error)}</span></div>` : ''}
        <div class="actions"><button class="btn block" type="submit">${icons.check} ${isNew ? 'Continue' : 'Log in'}</button></div>
        <div class="row" style="justify-content:space-between;margin-top:8px">
          <button type="button" class="btn ghost small" data-change>${icons.back} Change number</button>
          <button type="button" class="btn ghost small" data-resend disabled>Send again</button>
        </div>
      </form>`;
    const form = $('form', el);
    const code = $('#code', el);
    code.focus();
    const resend = $('[data-resend]', el);
    let wait = 30;
    clearInterval(timer);
    const tick = () => { resend.textContent = wait > 0 ? `Send again in ${wait}s` : 'Send code again'; resend.disabled = wait > 0; wait--; };
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

// Name + face photo. Everyone fills this in once.
export function renderProfileSetup(el, user, { onDone, intro = 'Please tell us your name and add your photo. This is needed only once.' }) {
  let blob = null;
  el.innerHTML = `
    <form class="card narrow" novalidate>
      <h2>Your details</h2>
      <p class="sub">${esc(intro)}</p>
      <label for="name">Full name</label>
      <input id="name" name="name" autocomplete="name" maxlength="80" required value="${esc(user.name ?? '')}" placeholder="As on your ID card">
      <div class="label">Your photo</div>
      <div data-photo></div>
      <div data-error></div>
      <div class="actions"><button class="btn block" type="submit">${icons.check} Save and continue</button></div>
    </form>`;
  const form = $('form', el);
  const save = $('button[type=submit]', form);
  photoPicker($('[data-photo]', el), { current: user.photo, onChange: (b) => { blob = b; } });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('[data-error]', el);
    const name = form.name.value.trim();
    const problem = name.length < 2 ? 'Please enter your full name.' : !blob && !user.photo ? 'Please add your photo.' : '';
    err.innerHTML = problem ? `<div class="notice bad" style="margin-top:12px">${icons.alert}<span>${esc(problem)}</span></div>` : '';
    if (problem) return;
    try {
      let updated = (await busy(save, () => api('/api/auth/me', { method: 'PATCH', body: { name } }))).user;
      if (blob) updated = (await busy(save, () => uploadPhoto(blob))).user;
      onDone(updated);
    } catch { /* busy() showed the error */ }
  });
}
