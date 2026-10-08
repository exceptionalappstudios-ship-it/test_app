// Loaded first inside each app frame of the preview. Routes the app's API
// calls and live updates to the in-browser backend hosted by the preview
// page, and fills in for things the preview frame doesn't have (camera,
// files under /vendor).
const { frame } = window.__DEMO__;
const backend = window.parent.__preview;

const blobToDataUrl = (blob) => new Promise((resolve) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.readAsDataURL(blob); });
const b64ToBuffer = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer;

const realFetch = window.fetch.bind(window);
window.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url.startsWith('/vendor/face-model/')) {
    const file = url.split('/').pop();
    const data = backend.faceModel[file];
    if (!data) return new Response('Not found', { status: 404 });
    return file.endsWith('.json') ? new Response(data, { headers: { 'Content-Type': 'application/json' } }) : new Response(b64ToBuffer(data));
  }
  if (!url.startsWith('/api/')) return realFetch(input, init);
  let body;
  if (init.body instanceof Blob) body = await blobToDataUrl(init.body);
  else if (init.body) body = JSON.parse(init.body);
  const res = await backend.handle(frame, (init.method || 'GET').toUpperCase(), url, body);
  backend.changed(frame);
  return new Response(JSON.stringify(res.body), { status: res.status, headers: { 'Content-Type': 'application/json' } });
};

// Face detection: the preview page carries the face-api code and model.
window.__faceApiLoader = () => new Promise((resolve, reject) => {
  if (window.__faceapi) return resolve(window.__faceapi);
  const s = document.createElement('script');
  s.textContent = backend.faceApiSource;
  document.head.append(s);
  window.__faceapi ? resolve(window.__faceapi) : reject(new Error('Face detection did not load'));
});

// Live updates.
window.EventSource = class {
  constructor(url) {
    this.handlers = {};
    const staff = url.includes('/staff/');
    this.off = backend.subscribe((e) => {
      const mine = staff ? e.type === 'staff' : e.type === 'user' && e.userId === backend.currentUser(frame)?.id;
      if (!mine) return;
      for (const fn of this.handlers[e.event] ?? []) setTimeout(() => fn({ data: JSON.stringify(e.data) }), 60);
    });
    setTimeout(() => this.onopen?.(), 0);
  }
  addEventListener(event, fn) { (this.handlers[event] ??= []).push(fn); }
  close() { this.off(); }
};
// When the preview clock moves, screens refresh.
backend.subscribe((e) => {
  if (e.type !== 'clock') return;
  window.dispatchEvent(new CustomEvent('app:update'));
  window.dispatchEvent(new CustomEvent('admin:changed'));
});

// In the preview each app is an embedded document whose links would resolve
// against the outer page's address; keep in-app (#/...) links inside the app.
document.addEventListener('click', (e) => {
  const a = e.target.closest?.('a[href]');
  if (!a || e.defaultPrevented) return;
  const href = a.getAttribute('href');
  if (href.startsWith('#')) { e.preventDefault(); location.hash = href; }
  else if (href.startsWith('/')) { e.preventDefault(); backend.navigate?.(frame, href); }
}, true);

// No camera in the preview: the scanner screen lists today's passes instead.
if (frame !== 'visitor') {
  const STATE = { ok: 'Valid now', used: 'Already checked in', early: 'Session not open yet', wrong_day: 'Not today', inactive: 'Not approved' };
  new MutationObserver(() => {
    const form = document.querySelector('[data-manual]');
    if (!form || form.dataset.helper) return;
    form.dataset.helper = '1';
    const box = document.createElement('div');
    box.className = 'card';
    box.innerHTML = '<h3 style="margin-bottom:2px">Preview: scan a pass</h3><p class="small muted" style="margin-top:0">There is no camera here. Tap a visitor\'s pass to scan it.</p><div class="stack" data-passes></div>';
    form.before(box);
    const list = box.querySelector('[data-passes]');
    let last = '';
    const render = () => {
      const passes = backend.scannablePasses();
      const key = JSON.stringify(passes);
      if (key === last) return;
      last = key;
      list.innerHTML = passes.length ? '' : '<p class="small muted">No passes for today yet.</p>';
      for (const p of passes.slice(0, 8)) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = `btn ${p.used ? 'light' : 'blue'} block`;
        b.style.cssText = 'justify-content:space-between;text-align:left;gap:12px;min-height:56px';
        b.innerHTML = `<span style="min-width:0"><span style="display:block">${p.name}</span><span style="display:block;font-weight:500;font-size:.82rem;opacity:.85">${p.people} ${p.people === 1 ? 'person' : 'people'} · ${p.label}</span></span><span style="flex:0 0 auto;font-weight:600;font-size:.8rem;opacity:.9">${STATE[p.state]}</span>`;
        b.addEventListener('click', () => { form.code.value = p.code; form.requestSubmit(); });
        list.append(b);
      }
    };
    render();
    const off = backend.subscribe(render);
    new MutationObserver(() => { if (!box.isConnected) off(); }).observe(document.body, { childList: true, subtree: true });
  }).observe(document.documentElement, { childList: true, subtree: true });
}
