// The page behind the pass link sent on WhatsApp. One small self-contained
// page (about 5 KB, no external files) so it opens quickly on a weak signal.
//
// Websites cannot fully block screenshots or screen recording. To make a
// copied pass easy to spot and short-lived, the page shows a live clock and
// a moving band, hides the code when the app is in the background, blocks
// long-press saving, and every pass can be scanned only once.

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function renderPassPage({ state, name, visit, people, code, qrSvg, validText = 'Valid today', opensText, checkedInTime, minutesLeft = 0, express }) {
  // One colour per state, an icon and a few words.
  const tick = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
  const cross = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';
  const states = {
    ready: () => ({ band: 'go', head: `${tick} ${esc(validText)}`, body: `
      <div class="qr" aria-label="QR code">${qrSvg}</div>
      <div class="code-label">ENTRY CODE</div>
      <div class="code">${esc(code)}</div>
      <div class="live"><span class="dot"></span><span id="clock">Live</span></div>
      <p class="note">Show at the gate &nbsp;·&nbsp; One scan only</p>` }),
    not_yet: () => ({ band: 'soon', head: `${tick} Confirmed`, body: `<p class="big">Your pass opens on<br><strong>${esc(opensText)}</strong></p>` }),
    checked_in: () => (minutesLeft > 0
      ? { band: 'go', head: `${tick} Checked in`, body: `<div class="stamp">🙏</div><p class="big">Welcome!</p><p class="left">⏱ ${esc(minutesLeft)} min left</p>${checkedInTime ? `<p class="soft">In at ${esc(checkedInTime)}</p>` : ''}` }
      : { band: 'off', head: `${tick} Visit complete`, body: '<div class="stamp">🙏</div><p class="big">Thank you for coming</p><p class="soft">Rate your visit in the app ⭐</p>' }),
    expired: () => ({ band: 'off', head: 'Pass ended', body: '<p class="big">This pass was for an earlier day.</p>' }),
    inactive: () => ({ band: 'bad', head: `${cross} Not valid`, body: '<p class="big">This visit is not confirmed.</p>' }),
    missing: () => ({ band: 'bad', head: `${cross} Pass not found`, body: '<p class="big">Please open the link from WhatsApp again.</p>' }),
  };
  const view = (states[state] ?? states.missing)();
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><meta name="referrer" content="no-referrer">
${state === 'not_yet' || (state === 'checked_in' && minutesLeft > 0) ? '<meta http-equiv="refresh" content="60">' : ''}
<title>Entry pass · Meet Gurudev</title>
<style>
*{box-sizing:border-box}html,body{margin:0}
body{font:16px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#0f1f3d;background:linear-gradient(140deg,#0a2357,#1446a0 55%,#2f8de4);min-height:100vh;display:flex;align-items:flex-start;justify-content:center;padding:18px 14px;-webkit-user-select:none;user-select:none;-webkit-touch-callout:none}
.card{background:#fff;border-radius:24px;max-width:380px;width:100%;text-align:center;box-shadow:0 12px 40px rgba(0,0,0,.25);position:relative;overflow:hidden;animation:rise .35s cubic-bezier(.2,.7,.3,1) both}
.band{display:flex;align-items:center;justify-content:center;gap:8px;padding:13px;font-weight:800;font-size:1.1rem;color:#fff}
.band.go{background:linear-gradient(135deg,#1fbf63,#0e9447)}.band.soon{background:linear-gradient(135deg,#2f7de1,#1446a0)}
.band.off{background:linear-gradient(135deg,#8a94a6,#5b6578)}.band.bad{background:linear-gradient(135deg,#e5484d,#c2232f)}
.inner{padding:18px 20px 22px}
h1{font-size:.78rem;margin:0;color:#7b8aa3;font-weight:800;letter-spacing:.12em}
.name{font-size:1.4rem;font-weight:800;margin:6px 0 8px}
.chips{display:flex;flex-wrap:wrap;gap:6px;justify-content:center;margin-bottom:14px}
.chip{padding:5px 11px;border-radius:999px;background:#f5f8fd;border:1px solid #dfe6f1;font-weight:700;font-size:.88rem}
.express{background:#fff1d6;border-color:#f5d48e;color:#9a5b00}
.qr{position:relative;width:min(70vw,250px);margin:0 auto;padding:10px;border:2px solid #9be3b9;border-radius:18px;pointer-events:none}.qr::after{content:"";position:absolute;inset:-7px;border-radius:24px;border:3px solid rgba(31,191,99,.55);animation:ring 2.4s ease-out infinite}
.qr svg{display:block;width:100%;height:auto}
.code-label{margin-top:14px;font-size:.72rem;font-weight:800;letter-spacing:.12em;color:#7b8aa3}
.code{font:800 2.2rem/1.1 ui-monospace,Menlo,Consolas,monospace;letter-spacing:.18em;margin-top:2px}
.live{display:inline-flex;align-items:center;gap:8px;margin-top:12px;font-weight:700;font-variant-numeric:tabular-nums;color:#0b7d3d}
.dot{width:10px;height:10px;border-radius:50%;background:#1fbf63;animation:pulse 1s infinite alternate}
.big{font-size:1.15rem;margin:8px 0 2px;font-weight:600}.soft{font-size:.9rem;color:#7b8aa3;font-weight:500;margin:6px 0 0}
.left{display:inline-block;margin:10px 0 0;padding:6px 14px;border-radius:999px;background:#e3f7eb;color:#0b7d3d;font-weight:800}
.stamp{font-size:3rem;line-height:1;margin:6px 0;animation:pop .4s cubic-bezier(.3,1.4,.5,1) both}
.note{font-size:.88rem;color:#4a5b78;margin:12px 0 0;font-weight:600}
.hidden-cover{position:absolute;inset:0;background:#fff;display:none;align-items:center;justify-content:center;font-weight:700;color:#4a5b78;padding:20px}
body.away .hidden-cover{display:flex}
@keyframes pulse{to{opacity:.25}}@keyframes rise{from{opacity:0;transform:translateY(10px)}}
@keyframes pop{from{transform:scale(.6);opacity:0}}@keyframes ring{from{opacity:.9;transform:scale(.97)}to{opacity:0;transform:scale(1.05)}}
@media (prefers-reduced-motion:reduce){*{animation:none!important}}
@media print{.qr,.code{display:none}}
</style></head><body oncontextmenu="return false">
<main class="card">
  <div class="band ${view.band}">${view.head}</div>
  <div class="inner">
    <h1>MEET GURUDEV 🙏</h1>
    ${name ? `<div class="name">${esc(name)}</div><div class="chips"><span class="chip">${esc(visit)}</span><span class="chip">👥 ${esc(people)}</span>${express ? '<span class="chip express">⚡ Express</span>' : ''}</div>` : ''}
    ${view.body}
  </div>
  <div class="hidden-cover">Pass hidden 🔒 Come back to show it.</div>
</main>
${state === 'ready' ? `<script>
(function(){var c=document.getElementById('clock');function t(){var d=new Date();c.textContent='Live · '+d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'});}t();setInterval(t,1000);
document.addEventListener('visibilitychange',function(){document.body.classList.toggle('away',document.hidden);});
window.addEventListener('blur',function(){document.body.classList.add('away');});window.addEventListener('focus',function(){document.body.classList.remove('away');});
document.addEventListener('dragstart',function(e){e.preventDefault();});})();
</script>` : ''}
</body></html>`;
}
