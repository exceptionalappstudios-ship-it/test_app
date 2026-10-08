// QR scanner used by security staff (and admins): camera + manual code,
// with a full-screen green / red result.
import { $, api, esc, formatDate, formatTime, plural, photoTag, openSheet, busy } from './common.js';
import { icons } from './icons.js';

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

function visitorCard(a) {
  return `<div class="visitor-id">
    ${photoTag(a.photo, a.name, 'xl')}
    <div class="who">${esc(a.name)}</div>
    ${a.express ? '<div style="margin-top:6px"><span class="status express">⚡ Express pass</span></div>' : ''}
    <div class="count">${icons.users.replace('<svg', '<svg width="22" height="22"')} ${esc(plural(a.peopleCount, 'person', 'people'))}</div>
    ${a.people.length ? `<p class="small muted" style="margin:10px 0 0">With: ${a.people.map((p) => esc(p.name)).join(', ')}</p>` : ''}
    <p class="small muted" style="margin:6px 0 0">${esc(formatDate(a.date))} · ${esc(a.periodLabel)}</p>
  </div>`;
}

// Looks up a pass and shows the result; resolves when the sheet is closed.
export function showScanResult(body, { isAdmin = false } = {}) {
  return new Promise((resolve) => {
    const sheet = openSheet('<div class="spinner"></div>', { onClose: resolve });
    const el = sheet.el;
    const verdict = (kind, icon, title, message) => `<div class="verdict ${kind}">${icon}<div class="t">${esc(title)}</div>${message ? `<div class="m">${esc(message)}</div>` : ''}</div>`;
    const vibrate = (p) => navigator.vibrate?.(p);

    (async () => {
      let r;
      try {
        r = await api('/api/staff/scan', { method: 'POST', body });
      } catch (err) {
        vibrate([80, 60, 80]);
        el.innerHTML = `<div class="grab"></div>${verdict('bad', icons.xCircle, 'Not a valid pass', err.message)}<button class="btn light block" data-close>Scan next</button>`;
        return;
      }
      const a = r.appointment;
      if (r.result === 'ok') {
        vibrate(60);
        el.innerHTML = `<div class="grab"></div>${verdict('ok', icons.checkCircle, a.express ? 'Valid express pass' : 'Valid pass', a.photo && !a.photo.startsWith('data:image/svg') ? 'Check the face matches the photo' : 'No photo on this pass. Please check an ID card.')}${visitorCard(a)}
          <div class="actions"><button class="btn block" data-admit style="min-height:60px;font-size:1.15rem">${icons.check} Allow entry (${esc(plural(a.peopleCount, 'person', 'people'))})</button></div>
          <button class="btn ghost block" data-close>Cancel</button>`;
      } else if (r.result === 'used') {
        vibrate([200, 100, 200]);
        el.innerHTML = `<div class="grab"></div>${verdict('bad', icons.alert, 'ALREADY CHECKED IN', `This QR code was already used${a.checkedInAt ? ` at ${formatTime(a.checkedInAt)}` : ''}${a.checkedInBy ? ` by ${a.checkedInBy}` : ''}. Do not allow entry again.`)}
          ${visitorCard(a)}<div class="actions"><button class="btn light block" data-close>Scan next</button></div>`;
      } else {
        vibrate([80, 60, 80]);
        el.innerHTML = `<div class="grab"></div>${verdict(r.result === 'early' ? 'warn' : 'bad', r.result === 'early' ? icons.clock : icons.xCircle,
          { early: 'Too early', wrong_day: 'Not valid today', inactive: 'Not allowed' }[r.result] ?? 'Not allowed', r.message)}${visitorCard(a)}
          <div class="actions">
            ${isAdmin && r.adminOverride ? `<button class="btn amber block" data-admit data-override>Admin: allow entry anyway</button>` : ''}
            <button class="btn light block" data-close>Scan next</button></div>`;
      }
      $('[data-admit]', el)?.addEventListener('click', async (e) => {
        try {
          const { appointment } = await busy(e.currentTarget, () => api('/api/staff/admit', { method: 'POST', body: { ...body, override: e.currentTarget.hasAttribute('data-override') } }));
          vibrate(120);
          el.innerHTML = `<div class="grab"></div>${verdict('ok', icons.checkCircle, 'Entry allowed', `${appointment.name} · ${plural(appointment.peopleCount, 'person', 'people')}`)}
            <button class="btn block" data-close>Scan next</button>`;
          setTimeout(() => sheet.close(), 2500);
        } catch (err) {
          if (err.data?.result === 'used') el.innerHTML = `<div class="grab"></div>${verdict('bad', icons.alert, 'ALREADY CHECKED IN', err.message)}<button class="btn light block" data-close>Scan next</button>`;
        }
      });
    })();
  });
}

// Renders the camera scanner into `el`. Returns a stop() function.
export async function startScanner(el, { isAdmin = false, onDone } = {}) {
  el.innerHTML = `
    <div class="scanner"><video playsinline muted></video><div class="frame"></div><div class="msg" data-msg>Starting camera…</div>
      <div class="off-msg">${icons.camera}<span data-off></span></div></div>
    <form class="card" data-manual style="margin-top:14px">
      <label for="code" style="margin-top:0">Camera not working? Type the code</label>
      <div class="row"><input id="code" name="code" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Code from the pass"><button class="btn small" style="min-height:50px">Check</button></div>
    </form>`;
  const video = $('video', el);
  const msg = $('[data-msg]', el);
  // Without a camera, show the message on its own instead of over the frame.
  const noCamera = (text) => { $('.scanner', el).classList.add('off'); $('[data-off]', el).textContent = text; };
  let stream = null;
  let paused = false;
  let stopped = false;
  let raf = null;
  // The person usually still holds their phone up after being let in; ignore
  // the code that was just handled for a few seconds so it doesn't flash red.
  let recent = { code: null, until: 0 };

  const check = async (code, fromCamera = false) => {
    if (fromCamera && code === recent.code && Date.now() < recent.until) return;
    paused = true;
    await showScanResult({ code }, { isAdmin });
    recent = { code, until: Date.now() + 6000 };
    onDone?.();
    paused = false;
  };
  $('[data-manual]', el).addEventListener('submit', (e) => {
    e.preventDefault();
    const code = e.target.code.value.trim();
    if (code) { e.target.reset(); check(code); }
  });

  const stop = () => { stopped = true; cancelAnimationFrame(raf); stream?.getTracks().forEach((t) => t.stop()); };
  if (!navigator.mediaDevices?.getUserMedia) {
    noCamera('Camera is not available on this phone. Type the code below.');
    return stop;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1280 } }, audio: false });
  } catch {
    noCamera('Please allow camera access to scan, or type the code below.');
    return stop;
  }
  if (stopped) { stop(); return stop; }
  video.srcObject = stream;
  await video.play().catch(() => {});
  msg.textContent = 'Point the camera at the QR code';

  let detect;
  if ('BarcodeDetector' in window && (await BarcodeDetector.getSupportedFormats?.().catch(() => []))?.includes('qr_code')) {
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
    if (stopped) return;
    if (!paused && t - last > 180 && video.readyState >= 2) {
      last = t;
      try { const code = await detect(); if (code && !paused && !stopped) check(code, true); } catch { /* keep scanning */ }
    }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return stop;
}
