// Photo capture: the phone resizes the picture, finds the face (face-api,
// loaded only on this screen), crops a square around it and compresses it to
// a small JPEG (~30 KB) before upload. If face detection can't load (very old
// phone or no network), a centre crop is used instead.
import { $, esc, api } from './common.js';
import { icons } from './icons.js';

const OUT_SIZE = 400;
let detectorPromise = null;

function loadDetector() {
  detectorPromise ??= (async () => {
    const faceapi = window.__faceApiLoader ? await window.__faceApiLoader() : await import('/vendor/face-api.js');
    // Use the phone's graphics chip, or plain JavaScript if it has none
    // (the WebAssembly version needs extra files we don't ship).
    if (!(await faceapi.tf.setBackend('webgl').catch(() => false))) await faceapi.tf.setBackend('cpu');
    await faceapi.tf.ready();
    await faceapi.nets.tinyFaceDetector.loadFromUri('/vendor/face-model');
    return faceapi;
  })().catch((err) => { console.warn('Face detection unavailable:', err); detectorPromise = null; return null; });
  return detectorPromise;
}
// Start downloading early (while the person reads the screen).
export const preloadFaceDetector = () => { loadDetector(); };

const withTimeout = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r(null), ms))]);

async function toCanvas(file, max = 1280) {
  let img;
  try {
    img = await createImageBitmap(file);
  } catch {
    img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('This file is not a photo. Please choose a photo.'));
      el.src = URL.createObjectURL(file);
    });
  }
  const w = img.width;
  const h = img.height;
  const scale = Math.min(1, max / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  img.close?.();
  return canvas;
}

// A square around the face with room for hair and shoulders.
function faceSquare(box, W, H) {
  const side = Math.min(Math.max(box.width, box.height) * 2.1, W, H);
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height * 0.45;
  const x = Math.min(Math.max(cx - side / 2, 0), W - side);
  const y = Math.min(Math.max(cy - side / 2, 0), H - side);
  return { x, y, side };
}
const centerSquare = (W, H) => { const side = Math.min(W, H); return { x: (W - side) / 2, y: Math.max(0, (H - side) / 3), side }; };

function crop(canvas, { x, y, side }) {
  const out = document.createElement('canvas');
  out.width = OUT_SIZE;
  out.height = OUT_SIZE;
  const g = out.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.drawImage(canvas, x, y, side, side, 0, 0, OUT_SIZE, OUT_SIZE);
  return new Promise((resolve) => out.toBlob(resolve, 'image/jpeg', 0.82));
}

export async function processPhoto(file) {
  const canvas = await toCanvas(file);
  const faceapi = await withTimeout(loadDetector(), 20000);
  let faces = [];
  if (faceapi) {
    try {
      faces = await faceapi.detectAllFaces(canvas, new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.45 }));
    } catch (err) {
      console.warn('Face detection failed:', err);
    }
  }
  const largest = faces.map((f) => f.box).sort((a, b) => b.width * b.height - a.width * a.height)[0];
  const faceBlob = largest ? await crop(canvas, faceSquare(largest, canvas.width, canvas.height)) : null;
  const plainBlob = faceBlob ? null : await crop(canvas, centerSquare(canvas.width, canvas.height));
  return { blob: faceBlob ?? plainBlob, faceFound: Boolean(largest), checked: Boolean(faceapi), faces: faces.length };
}

// Renders the photo picker into `el`. Calls onChange(blob) once a photo is ready.
export function photoPicker(el, { current, onChange, prompt = 'Add a clear photo of your face. Security will use it to recognise you at the entrance.' }) {
  preloadFaceDetector();
  el.innerHTML = `
    <div class="photo-pick">
      <div class="preview">${current ? `<img src="${esc(current)}" alt="Your photo">` : icons.user}</div>
      <p class="sub" data-msg>${esc(prompt)}</p>
      <div data-status></div>
      <div class="actions" style="margin-top:10px">
        <button type="button" class="btn blue" style="margin:0" data-selfie>${icons.camera} Take a selfie</button>
        <input type="file" accept="image/*" capture="user" data-file data-selfie-file hidden>
        <label class="btn light file-btn" style="margin:0">${icons.image} Choose photo<input type="file" accept="image/*" data-file></label>
      </div>
    </div>`;
  const preview = $('.preview', el);
  const status = $('[data-status]', el);

  async function handle(file) {
    if (!file) return;
    status.innerHTML = '<div class="notice info"><div class="spinner" style="width:20px;height:20px;margin:0;border-width:2px"></div><span>Finding your face…</span></div>';
    try {
      const result = await processPhoto(file);
      const url = URL.createObjectURL(result.blob);
      preview.innerHTML = `<img src="${url}" alt="Your photo">`;
      if (result.faceFound) {
        status.innerHTML = `<div class="notice ok">${icons.checkCircle}<span>${result.faces > 1 ? 'We used the biggest face in the photo. ' : ''}Face found. This photo looks good.</span></div>`;
        onChange(result.blob);
      } else if (!result.checked) {
        status.innerHTML = '';
        onChange(result.blob);
      } else {
        status.innerHTML = `<div class="notice warn">${icons.alert}<span>We could not find a face. Please take a clear photo of your face, looking at the camera, in good light.</span></div>
          <button type="button" class="btn ghost small" data-anyway>Use this photo anyway</button>`;
        onChange(null);
        $('[data-anyway]', status).addEventListener('click', () => { status.innerHTML = ''; onChange(result.blob); });
      }
    } catch (err) {
      status.innerHTML = `<div class="notice bad">${icons.alert}<span>${esc(err.message)}</span></div>`;
      onChange(null);
    }
  }
  // The selfie uses the camera inside the page, because laptops and some in-app
  // browsers (e.g. links opened from WhatsApp) ignore the file input's camera hint.
  const actions = $('.actions', el);
  let stream = null;
  const stopCamera = () => { stream?.getTracks().forEach((t) => t.stop()); stream = null; };
  window.addEventListener('hashchange', stopCamera);
  window.addEventListener('pagehide', stopCamera);

  function closeCamera(html) {
    stopCamera();
    preview.classList.remove('live');
    preview.innerHTML = html;
    actions.hidden = false;
    $('[data-cam]', el)?.remove();
  }

  async function openCamera() {
    if (!navigator.mediaDevices?.getUserMedia) { $('[data-selfie-file]', el).click(); return; }
    const before = preview.innerHTML;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 1280 } }, audio: false });
    } catch (err) {
      const blocked = err?.name === 'NotAllowedError' || err?.name === 'SecurityError';
      status.innerHTML = `<div class="notice warn">${icons.alert}<span>${blocked
        ? 'Camera permission is blocked. Allow the camera for this site in your browser settings, or tap “Choose photo”.'
        : 'Could not open the camera. Tap “Choose photo” to use a photo instead.'}</span></div>`;
      return;
    }
    status.innerHTML = '';
    preview.classList.add('live');
    preview.innerHTML = '<video autoplay playsinline muted></video>';
    const video = $('video', preview);
    video.srcObject = stream;
    await video.play().catch(() => {});
    actions.hidden = true;
    actions.insertAdjacentHTML('afterend', `<div class="actions" data-cam style="margin-top:10px">
      <button type="button" class="btn blue" style="margin:0" data-snap>${icons.camera} Capture</button>
      <button type="button" class="btn light" style="margin:0" data-cancel>Cancel</button></div>`);
    $('[data-cancel]', el).addEventListener('click', () => closeCamera(before));
    $('[data-snap]', el).addEventListener('click', () => {
      const w = video.videoWidth;
      const h = video.videoHeight;
      if (!w || !h) return;
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const g = canvas.getContext('2d');
      g.translate(w, 0); // save it the way the person saw it (mirror image)
      g.scale(-1, 1);
      g.drawImage(video, 0, 0, w, h);
      canvas.toBlob((blob) => { closeCamera(before); handle(blob); }, 'image/jpeg', 0.92);
    });
  }
  $('[data-selfie]', el).addEventListener('click', openCamera);

  el.addEventListener('change', (e) => {
    if (e.target.matches('[data-file]')) { handle(e.target.files[0]); e.target.value = ''; }
  });
}

export const uploadPhoto = (blob) => api('/api/auth/me/photo', { method: 'POST', raw: blob });
