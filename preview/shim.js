// Loaded first inside each app frame of the preview. Routes the app's API
// calls and live updates to the in-browser backend that the preview page
// hosts, and fills in for browser features the preview frame doesn't allow.
const { frame } = window.__DEMO__;
const backend = window.parent.__preview;

const realFetch = window.fetch.bind(window);
window.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  if (!url.startsWith('/api/')) return realFetch(input, init);
  const body = init.body ? JSON.parse(init.body) : undefined;
  const res = await backend.handle(frame, (init.method || 'GET').toUpperCase(), url, body);
  backend.changed(frame);
  return new Response(JSON.stringify(res.body), { status: res.status, headers: { 'Content-Type': 'application/json' } });
};

// Live updates: the visitor stream carries this frame's user's events, the
// admin stream carries "something changed" events.
window.EventSource = class {
  constructor(url) {
    this.handlers = {};
    const isAdmin = url.includes('/admin/');
    this.off = backend.subscribe((e) => {
      if (isAdmin ? e.type !== 'admin' : !(e.type === 'user' && e.userId === backend.currentUser(frame)?.id)) return;
      for (const fn of this.handlers[e.event] ?? []) setTimeout(() => fn({ data: JSON.stringify(e.data) }), 50);
    });
    setTimeout(() => this.onopen?.(), 0);
  }
  addEventListener(event, fn) { (this.handlers[event] ??= []).push(fn); }
  close() { this.off(); }
};

// The preview frame can't show dialogs; treat confirmations as accepted.
window.confirm = () => true;

// The camera isn't available in the preview, so the Scan screen offers the
// passes a visitor could show right now. Tapping one behaves like scanning it.
if (frame === 'admin') {
  const addHelper = () => {
    const form = document.getElementById('manual');
    if (!form || form.dataset.helper) return;
    form.dataset.helper = '1';
    const box = document.createElement('div');
    box.className = 'card';
    box.innerHTML = '<h3 style="margin-bottom:4px">Preview: simulate a scan</h3><p class="small muted" style="margin-top:0">The camera is turned off in this preview. Tap a visitor\'s pass to scan it.</p><div class="stack" data-passes></div>';
    form.after(box);
    const list = box.querySelector('[data-passes]');
    const render = () => {
      const passes = backend.readyPasses();
      list.innerHTML = passes.length ? '' : '<p class="small muted">No passes for today yet. Book a slot as the visitor and approve it here.</p>';
      for (const p of passes) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn secondary block';
        b.textContent = `Scan ${p.name}'s pass · ${p.time}`;
        b.addEventListener('click', () => { form.code.value = p.code; form.requestSubmit(); });
        list.append(b);
      }
    };
    render();
    const off = backend.subscribe(render);
    new MutationObserver(() => { if (!box.isConnected) off(); }).observe(document.body, { childList: true, subtree: true });
  };
  new MutationObserver(addHelper).observe(document.documentElement, { childList: true, subtree: true });
  const msg = () => { const m = document.getElementById('msg'); if (m && /^Camera (not|permission)/.test(m.textContent)) m.textContent = 'Camera is off in the preview. Use "simulate a scan" below.'; };
  new MutationObserver(msg).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
}

// In the preview, each app is an embedded document whose links would resolve
// against the outer page's address; keep in-app (#/...) links inside the app.
document.addEventListener('click', (e) => {
  const a = e.target.closest?.('a[href^="#"]');
  if (!a || e.defaultPrevented || e.metaKey || e.ctrlKey) return;
  e.preventDefault();
  location.hash = a.getAttribute('href');
}, true);
