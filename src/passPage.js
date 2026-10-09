// The page behind the pass link sent on WhatsApp. One small self-contained
// page (about 5 KB, no external files) so it opens quickly on a weak signal.
//
// Websites cannot fully block screenshots or screen recording. To make a
// copied pass easy to spot and short-lived, the page shows a live clock and
// a moving band, hides the code when the app is in the background, blocks
// long-press saving, and every pass can be scanned only once.

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function renderPassPage({ state, name, visit, people, code, qrSvg, validText = 'Valid today', opensText, checkedInTime, express }) {
  const states = {
    ready: () => `
      <div class="badge ok">${esc(validText)} · scan once</div>
      <div class="qr" aria-label="QR code">${qrSvg}</div>
      <div class="code-label">Entry code</div>
      <div class="code">${esc(code)}</div>
      <div class="live"><span class="dot"></span><span id="clock">Live</span></div>
      <div class="band" aria-hidden="true"></div>
      <p class="note">Show this at the entrance any time on the day of your visit. Security can also type the code. A screenshot will not work: the pass can be scanned only once and security checks your photo.</p>`,
    not_yet: () => `
      <div class="badge wait">Confirmed</div>
      <p class="big">Your QR pass will appear here on<br><strong>${esc(opensText)}</strong></p>
      <p class="note">Keep this link. Open it again at that time.</p>`,
    checked_in: () => `<div class="badge ok">Checked in</div><p class="big">Welcome! You were checked in${checkedInTime ? ` at ${esc(checkedInTime)}` : ''}.</p>`,
    expired: () => '<div class="badge bad">Expired</div><p class="big">This pass was for an earlier day.</p>',
    inactive: () => '<div class="badge bad">Not valid</div><p class="big">This appointment is not confirmed or was cancelled.</p>',
    missing: () => '<div class="badge bad">Not found</div><p class="big">This pass link is not valid. Please check the WhatsApp message.</p>',
  };
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><meta name="referrer" content="no-referrer">
${state === 'not_yet' ? '<meta http-equiv="refresh" content="60">' : ''}
<title>Entry pass · Meet Gurudev</title>
<style>
*{box-sizing:border-box}html,body{margin:0}
body{font:16px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#0f1f3d;background:linear-gradient(140deg,#0a2357,#1446a0 55%,#2f8de4);min-height:100vh;display:flex;align-items:flex-start;justify-content:center;padding:18px 14px;-webkit-user-select:none;user-select:none;-webkit-touch-callout:none}
.card{background:#fff;border-radius:24px;max-width:380px;width:100%;padding:22px 20px;text-align:center;box-shadow:0 12px 40px rgba(0,0,0,.25);position:relative;overflow:hidden}
h1{font-size:1rem;margin:0;color:#4a5b78;font-weight:700;letter-spacing:.02em}
.name{font-size:1.45rem;font-weight:800;margin:6px 0 2px}
.meta{color:#4a5b78;margin:0 0 14px}
.badge{display:inline-block;font-weight:800;font-size:.85rem;padding:5px 14px;border-radius:999px;margin-bottom:12px}
.ok{background:#e3f7eb;color:#0b7d3d}.wait{background:#e8f1fd;color:#1446a0}.bad{background:#fde7e9;color:#c2232f}
.express{background:#fff1d6;color:#9a5b00;margin-left:6px}
.qr{width:min(72vw,260px);margin:0 auto;padding:10px;border:2px solid #dfe6f1;border-radius:18px;pointer-events:none}
.qr svg{display:block;width:100%;height:auto}
.code-label{margin-top:14px;font-size:.78rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#7b8aa3}
.code{font:800 2.2rem/1.1 ui-monospace,Menlo,Consolas,monospace;letter-spacing:.18em;margin-top:2px}
.live{display:inline-flex;align-items:center;gap:8px;margin-top:12px;font-weight:700;font-variant-numeric:tabular-nums;color:#0b7d3d}
.dot{width:10px;height:10px;border-radius:50%;background:#1fbf63;animation:pulse 1s infinite alternate}
.band{height:6px;margin:14px -20px 0;background:linear-gradient(90deg,#1fbf63,#2f7de1,#1fbf63);background-size:200% 100%;animation:move 2s linear infinite}
@keyframes pulse{to{opacity:.25}}@keyframes move{to{background-position:-200% 0}}
.big{font-size:1.1rem;margin:6px 0}
.note{font-size:.85rem;color:#7b8aa3;margin:14px 0 0}
.hidden-cover{position:absolute;inset:0;background:#fff;display:none;align-items:center;justify-content:center;font-weight:700;color:#4a5b78}
body.away .hidden-cover{display:flex}
@media print{.qr,.code{display:none}}
</style></head><body oncontextmenu="return false">
<main class="card">
  <h1>MEET GURUDEV · ENTRY PASS</h1>
  ${name ? `<div class="name">${esc(name)}</div><p class="meta">${esc(visit)} · ${esc(people)} ${people === 1 ? 'person' : 'people'}${express ? '<span class="badge express">Express</span>' : ''}</p>` : ''}
  ${(states[state] ?? states.missing)()}
  <div class="hidden-cover">Pass hidden. Come back to this page to show it.</div>
</main>
${state === 'ready' ? `<script>
(function(){var c=document.getElementById('clock');function t(){var d=new Date();c.textContent='Live · '+d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'});}t();setInterval(t,1000);
document.addEventListener('visibilitychange',function(){document.body.classList.toggle('away',document.hidden);});
window.addEventListener('blur',function(){document.body.classList.add('away');});window.addEventListener('focus',function(){document.body.classList.remove('away');});
document.addEventListener('dragstart',function(e){e.preventDefault();});})();
</script>` : ''}
</body></html>`;
}
