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
        <label class="btn blue file-btn" style="margin:0">${icons.camera} Take a selfie<input type="file" accept="image/*" capture="user" data-file></label>
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
  el.addEventListener('change', (e) => {
    if (e.target.matches('[data-file]')) { handle(e.target.files[0]); e.target.value = ''; }
  });
}

export const uploadPhoto = (blob) => api('/api/auth/me/photo', { method: 'POST', raw: blob });
