// The daily report: shown in the admin app, printable as a PDF, and drawn as
// a picture (PNG) that can be shared on WhatsApp. No libraries: the picture
// is drawn on a canvas with the phone's own fonts.
import { esc, formatDate, plural, stars } from './common.js';

const hourLabel = (h) => `${((h + 11) % 12) + 1} ${h < 12 ? 'AM' : 'PM'}`;
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);

export function reportHtml(r) {
  const t = r.totals;
  const maxHour = Math.max(1, ...r.hours.map((h) => h.people));
  const fb = r.feedback;
  const maxStar = Math.max(1, ...fb.stars);
  return `
    <div class="report">
      <div class="report-head">
        <div class="small" style="opacity:.85;font-weight:700;letter-spacing:.08em">MEET GURUDEV · DAILY REPORT</div>
        <div class="report-date">${esc(formatDate(r.date))}</div>
      </div>
      <div class="report-tiles">
        <div class="rt main"><div class="v">${t.peopleCame}</div><div class="l">People came</div></div>
        <div class="rt"><div class="v">${t.peopleExpected}</div><div class="l">Expected</div></div>
        <div class="rt"><div class="v">${t.groupsCame}<span class="of">/${t.bookings}</span></div><div class="l">Passes scanned</div></div>
        <div class="rt warn"><div class="v">${t.noShowPeople}</div><div class="l">Did not come</div></div>
      </div>
      <div class="card">
        <h3>Sessions</h3>
        ${r.sessions.map((s) => `<div class="session-row"><strong>${esc(s.label)}</strong>
          <div class="meter"><span style="width:${pct(s.came, s.expected)}%"></span></div><span class="n">${s.came} / ${s.expected}</span></div>`).join('')}
        <div class="small muted" style="margin-top:6px">People came / people expected</div>
      </div>
      <div class="card">
        <h3>Arrivals by hour</h3>
        ${r.hours.length ? `<div class="hbars">${r.hours.map((h) => `<div class="hb" title="${h.people} people at ${hourLabel(h.hour)}">
          <span class="hv">${h.people}</span><span class="bar" style="height:${Math.max(6, Math.round((h.people / maxHour) * 100))}%"></span><span class="hl">${hourLabel(h.hour)}</span></div>`).join('')}</div>`
          : '<div class="empty" style="padding:12px">No check-ins yet.</div>'}
      </div>
      <div class="card">
        <h3>Feedback</h3>
        ${fb.count ? `<div class="row" style="gap:16px;align-items:center">
            <div class="center"><div class="big-rating">${fb.average}</div><div>${stars(Math.round(fb.average), 18)}</div><div class="small muted">${plural(fb.count, 'rating')}</div></div>
            <div class="grow">${[5, 4, 3, 2, 1].map((n) => `<div class="star-row"><span>${n}★</span><div class="meter amber"><span style="width:${pct(fb.stars[n - 1], maxStar)}%"></span></div><span class="n">${fb.stars[n - 1]}</span></div>`).join('')}</div>
          </div>
          ${fb.comments.map((c) => `<div class="quote">“${esc(c.comment)}”<div class="small muted">${esc(c.name)} · ${'★'.repeat(c.rating)}</div></div>`).join('')}`
          : '<div class="empty" style="padding:12px">No feedback yet.</div>'}
      </div>
      ${r.staff.length ? `<div class="card"><h3>Let in by</h3>${r.staff.map((s) => `<div class="kv"><span>${esc(s.name)}</span><strong>${plural(s.people, 'person', 'people')}</strong></div>`).join('')}</div>` : ''}
      <div class="card"><h3>Other</h3><div class="chips">
        <span class="tag">⚡ Express ${t.express}</span><span class="tag">⏳ Waiting ${t.pending}</span>
        <span class="tag">✕ Declined ${t.declined}</span><span class="tag">Cancelled ${t.cancelled}</span></div></div>
      <div class="small muted center report-foot">Made ${esc(new Date(r.generatedAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }))}</div>
    </div>`;
}

// ---- The shareable picture ---------------------------------------------------------

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", sans-serif';
const C = { ink: '#0f1f3d', ink2: '#4a5b78', muted: '#7b8aa3', line: '#dfe6f1', bg: '#eef3fa', blue: '#2f7de1', blueDark: '#1446a0', green: '#12a150', amber: '#f0a020', red: '#d22f3c', track: '#e8eef7' };

// Rounded rectangle path that also works on older phones (no ctx.roundRect).
// `r` is one radius or [top-left, top-right, bottom-right, bottom-left].
function path(g, x, y, w, h, r) {
  const [tl, tr, br, bl] = Array.isArray(r) ? r : [r, r, r, r];
  g.beginPath();
  g.moveTo(x + tl, y);
  g.arcTo(x + w, y, x + w, y + h, tr);
  g.arcTo(x + w, y + h, x, y + h, br);
  g.arcTo(x, y + h, x, y, bl);
  g.arcTo(x, y, x + w, y, tl);
  g.closePath();
}
function roundRect(g, x, y, w, h, r, fill) {
  path(g, x, y, w, h, Math.min(r, h / 2, w / 2));
  g.fillStyle = fill;
  g.fill();
}
function text(g, s, x, y, { size = 28, weight = 600, color = C.ink, align = 'left' } = {}) {
  g.font = `${weight} ${size}px ${FONT}`;
  g.fillStyle = color;
  g.textAlign = align;
  g.fillText(s, x, y);
}

export function drawReport(r) {
  const W = 1080;
  const t = r.totals;
  const fb = r.feedback;
  const H = 1500 + (fb.comments.length ? 70 : 0);
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const g = canvas.getContext('2d');
  g.fillStyle = C.bg;
  g.fillRect(0, 0, W, H);

  // Header
  const grad = g.createLinearGradient(0, 0, W, 300);
  grad.addColorStop(0, '#0a2357');
  grad.addColorStop(0.55, '#1446a0');
  grad.addColorStop(1, '#2f8de4');
  g.fillStyle = grad;
  g.fillRect(0, 0, W, 300);
  text(g, 'MEET GURUDEV · DAILY REPORT', 64, 100, { size: 28, weight: 800, color: 'rgba(255,255,255,.8)' });
  text(g, formatDate(r.date), 64, 175, { size: 58, weight: 800, color: '#fff' });
  text(g, `${t.peopleCame} of ${t.peopleExpected} people came`, 64, 238, { size: 34, weight: 600, color: 'rgba(255,255,255,.9)' });

  // Number tiles
  const tiles = [['People came', String(t.peopleCame), C.green], ['Expected', String(t.peopleExpected), C.blueDark],
    ['Passes scanned', `${t.groupsCame}/${t.bookings}`, C.blueDark], ['Did not come', String(t.noShowPeople), C.amber]];
  const tw = (W - 64 * 2 - 24 * 3) / 4;
  tiles.forEach(([label, value, color], i) => {
    const x = 64 + i * (tw + 24);
    roundRect(g, x, 340, tw, 170, 24, '#fff');
    text(g, value, x + 26, 440, { size: 64, weight: 800, color });
    text(g, label, x + 26, 482, { size: 24, weight: 700, color: C.muted });
  });

  // Sessions
  roundRect(g, 64, 550, W - 128, 230, 28, '#fff');
  text(g, 'Sessions', 104, 610, { size: 34, weight: 800 });
  r.sessions.forEach((s, i) => {
    const y = 670 + i * 70;
    text(g, s.label, 104, y, { size: 30, weight: 700 });
    roundRect(g, 330, y - 22, 500, 26, 13, C.track);
    const w = s.expected ? Math.max(26, (500 * s.came) / s.expected) : 0;
    if (w) roundRect(g, 330, y - 22, Math.min(500, w), 26, 13, C.green);
    text(g, `${s.came} / ${s.expected}`, W - 104, y, { size: 30, weight: 800, align: 'right' });
  });

  // Arrivals by hour
  roundRect(g, 64, 820, W - 128, 320, 28, '#fff');
  text(g, 'Arrivals by hour', 104, 880, { size: 34, weight: 800 });
  if (r.hours.length) {
    const max = Math.max(...r.hours.map((h) => h.people));
    const slot = Math.min(110, (W - 208) / r.hours.length);
    r.hours.forEach((h, i) => {
      const bh = Math.max(8, (h.people / max) * 150);
      const x = 104 + i * slot + slot * 0.2;
      const bw = slot * 0.6;
      path(g, x, 1070 - bh, bw, bh, [Math.min(8, bh / 2), Math.min(8, bh / 2), 0, 0]);
      g.fillStyle = C.blue;
      g.fill();
      text(g, String(h.people), x + bw / 2, 1060 - bh, { size: 24, weight: 800, align: 'center' });
      text(g, hourLabel(h.hour), x + bw / 2, 1108, { size: 20, weight: 600, color: C.muted, align: 'center' });
    });
  } else {
    text(g, 'No check-ins yet', 104, 990, { size: 30, color: C.muted });
  }

  // Feedback
  const fy = 1180;
  roundRect(g, 64, fy, W - 128, 200 + (fb.comments.length ? 70 : 0), 28, '#fff');
  text(g, 'Feedback', 104, fy + 60, { size: 34, weight: 800 });
  if (fb.count) {
    text(g, String(fb.average), 104, fy + 150, { size: 72, weight: 800 });
    g.font = `800 44px ${FONT}`;
    const sx = 104 + g.measureText(String(fb.average)).width + 24;
    for (let i = 0; i < 5; i++) text(g, '★', sx + i * 48, fy + 140, { size: 44, weight: 800, color: i < Math.round(fb.average) ? '#f5a623' : '#d6dce6' });
    text(g, plural(fb.count, 'rating'), sx, fy + 180, { size: 26, color: C.muted });
    if (fb.comments[0]) {
      const c = fb.comments[0].comment;
      text(g, `“${c.length > 60 ? `${c.slice(0, 58)}…` : c}”`, 104, fy + 240, { size: 28, weight: 500, color: C.ink2 });
    }
  } else {
    text(g, 'No feedback yet', 104, fy + 130, { size: 30, color: C.muted });
  }

  text(g, `Made ${new Date(r.generatedAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}`, W / 2, H - 40, { size: 22, color: C.muted, align: 'center' });
  return canvas;
}

// Shares the picture through the phone's share sheet (WhatsApp, etc.), or
// downloads it where sharing files isn't possible.
export async function shareReport(r) {
  const canvas = drawReport(r);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  const file = new File([blob], `meet-gurudev-report-${r.date}.png`, { type: 'image/png' });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: `Daily report ${r.date}` });
      return 'shared';
    } catch (err) {
      if (err.name === 'AbortError') return 'cancelled';
    }
  }
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: file.name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return 'downloaded';
}
