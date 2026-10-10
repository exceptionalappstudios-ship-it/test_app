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

// Wraps text into lines that fit `width` (canvas font must be set first).
function wrap(g, str, width) {
  const words = String(str).split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (g.measureText(next).width > width && line) { lines.push(line); line = w; } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

// Draws the whole report (every section on the screen) as one tall picture.
export function drawReport(r) {
  const W = 1080;
  const PAD = 64;
  const IN = 104; // text inset inside cards
  const t = r.totals;
  const fb = r.feedback;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = 6000; // trimmed to the real height at the end
  const g = canvas.getContext('2d');
  g.fillStyle = C.bg;
  g.fillRect(0, 0, W, canvas.height);

  // Header
  const grad = g.createLinearGradient(0, 0, W, 300);
  grad.addColorStop(0, '#0a2357');
  grad.addColorStop(0.55, '#1446a0');
  grad.addColorStop(1, '#2f8de4');
  g.fillStyle = grad;
  g.fillRect(0, 0, W, 300);
  text(g, 'MEET GURUDEV · DAILY REPORT', PAD, 100, { size: 28, weight: 800, color: 'rgba(255,255,255,.8)' });
  text(g, formatDate(r.date), PAD, 175, { size: 58, weight: 800, color: '#fff' });
  text(g, `${t.peopleCame} of ${t.peopleExpected} people came`, PAD, 238, { size: 34, weight: 600, color: 'rgba(255,255,255,.9)' });

  // Number tiles (2 rows of 2, big and easy to read)
  const tiles = [['People came', String(t.peopleCame), C.green], ['Expected', String(t.peopleExpected), C.blueDark],
    ['Passes scanned', `${t.groupsCame}/${t.bookings}`, C.blueDark], ['Did not come', String(t.noShowPeople), C.amber]];
  const tw = (W - PAD * 2 - 24) / 2;
  tiles.forEach(([label, value, color], i) => {
    const x = PAD + (i % 2) * (tw + 24);
    const y = 340 + Math.floor(i / 2) * 194;
    roundRect(g, x, y, tw, 170, 24, '#fff');
    text(g, value, x + 32, y + 96, { size: 68, weight: 800, color });
    text(g, label, x + 32, y + 140, { size: 28, weight: 700, color: C.muted });
  });
  let y = 340 + 2 * 194 + 16;

  // A white card whose height is known only after drawing its content.
  const card = (title, drawBody) => {
    const top = y;
    const start = top + 60;
    // Draw the body on a scratch layer first to learn its height.
    const bodyEnd = drawBody(start + 30, true);
    roundRect(g, PAD, top, W - PAD * 2, bodyEnd - top + 34, 28, '#fff');
    text(g, title, IN, top + 62, { size: 34, weight: 800 });
    drawBody(start + 30, false);
    y = bodyEnd + 34 + 26;
  };

  card('Sessions', (y0, dry) => {
    r.sessions.forEach((s, i) => {
      const yy = y0 + 20 + i * 66;
      if (dry) return;
      text(g, s.label, IN, yy, { size: 30, weight: 700 });
      roundRect(g, 330, yy - 22, 500, 26, 13, C.track);
      const w = s.expected ? Math.max(26, (500 * s.came) / s.expected) : 0;
      if (w) roundRect(g, 330, yy - 22, Math.min(500, w), 26, 13, C.green);
      text(g, `${s.came} / ${s.expected}`, W - IN, yy, { size: 30, weight: 800, align: 'right' });
    });
    return y0 + 20 + (r.sessions.length - 1) * 66 + 30;
  });

  card('Arrivals by hour', (y0, dry) => {
    if (!r.hours.length) {
      if (!dry) text(g, 'No check-ins yet', IN, y0 + 30, { size: 30, color: C.muted });
      return y0 + 40;
    }
    const base = y0 + 190;
    if (!dry) {
      const max = Math.max(...r.hours.map((h) => h.people));
      const slot = Math.min(110, (W - IN * 2) / r.hours.length);
      r.hours.forEach((h, i) => {
        const bh = Math.max(8, (h.people / max) * 150);
        const x = IN + i * slot + slot * 0.2;
        const bw = slot * 0.6;
        path(g, x, base - bh, bw, bh, [Math.min(8, bh / 2), Math.min(8, bh / 2), 0, 0]);
        g.fillStyle = C.blue;
        g.fill();
        text(g, String(h.people), x + bw / 2, base - bh - 10, { size: 24, weight: 800, align: 'center' });
        text(g, hourLabel(h.hour), x + bw / 2, base + 34, { size: 20, weight: 600, color: C.muted, align: 'center' });
      });
    }
    return base + 40;
  });

  card('Feedback', (y0, dry) => {
    if (!fb.count) {
      if (!dry) text(g, 'No feedback yet', IN, y0 + 30, { size: 30, color: C.muted });
      return y0 + 40;
    }
    if (!dry) {
      text(g, String(fb.average), IN, y0 + 60, { size: 80, weight: 800 });
      for (let i = 0; i < 5; i++) text(g, '★', IN + 4 + i * 40, y0 + 112, { size: 36, weight: 800, color: i < Math.round(fb.average) ? '#f5a623' : '#d6dce6' });
      text(g, plural(fb.count, 'rating'), IN, y0 + 152, { size: 26, color: C.muted });
      const max = Math.max(1, ...fb.stars);
      [5, 4, 3, 2, 1].forEach((n, i) => {
        const yy = y0 + i * 34;
        text(g, `${n}★`, 400, yy + 4, { size: 24, weight: 700, color: C.ink2 });
        roundRect(g, 460, yy - 14, 420, 18, 9, C.track);
        if (fb.stars[n - 1]) roundRect(g, 460, yy - 14, Math.max(18, (420 * fb.stars[n - 1]) / max), 18, 9, '#f5a623');
        text(g, String(fb.stars[n - 1]), W - IN, yy + 4, { size: 24, weight: 800, align: 'right' });
      });
    }
    let yy = y0 + 200;
    g.font = `italic 500 28px ${FONT}`;
    for (const c of fb.comments) {
      const lines = wrap(g, `“${c.comment}”`, W - IN * 2 - 40);
      const h = lines.length * 38 + 54;
      if (!dry) {
        roundRect(g, IN - 10, yy - 6, W - IN * 2 + 20, h, 16, '#f5f8fd');
        g.font = `italic 500 28px ${FONT}`;
        lines.forEach((l, i) => text(g, l, IN + 10, yy + 34 + i * 38, { size: 28, weight: 500, color: C.ink2 }));
        text(g, `${c.name} · ${'★'.repeat(c.rating)}`, IN + 10, yy + 34 + lines.length * 38, { size: 22, weight: 600, color: C.muted });
        g.font = `italic 500 28px ${FONT}`;
      }
      yy += h + 14;
    }
    return yy;
  });

  if (r.staff.length) {
    card('Let in by', (y0, dry) => {
      r.staff.forEach((s, i) => {
        if (dry) return;
        const yy = y0 + 20 + i * 54;
        text(g, s.name, IN, yy, { size: 30, weight: 600 });
        text(g, `${plural(s.people, 'person', 'people')} · ${plural(s.groups, 'pass', 'passes')}`, W - IN, yy, { size: 30, weight: 800, align: 'right' });
      });
      return y0 + 20 + (r.staff.length - 1) * 54 + 20;
    });
  }

  if (r.references?.length) {
    card('By reference', (y0, dry) => {
      r.references.forEach((s, i) => {
        if (dry) return;
        const yy = y0 + 20 + i * 54;
        text(g, s.name, IN, yy, { size: 30, weight: 600 });
        text(g, `${plural(s.people, 'person', 'people')}`, W - IN, yy, { size: 30, weight: 800, align: 'right' });
      });
      return y0 + 20 + (r.references.length - 1) * 54 + 20;
    });
  }

  card('Other', (y0, dry) => {
    const items = [['⚡ Express', t.express], ['⏳ Waiting', t.pending], ['✕ Declined', t.declined], ['Cancelled', t.cancelled]];
    if (!dry) {
      const cw = (W - IN * 2 - 3 * 16) / 4;
      items.forEach(([label, n], i) => {
        const x = IN + i * (cw + 16);
        roundRect(g, x, y0 - 10, cw, 100, 18, '#f5f8fd');
        text(g, String(n), x + cw / 2, y0 + 42, { size: 40, weight: 800, align: 'center' });
        text(g, label, x + cw / 2, y0 + 76, { size: 22, weight: 600, color: C.muted, align: 'center' });
      });
    }
    return y0 + 90;
  });

  text(g, `Made ${new Date(r.generatedAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}`, W / 2, y + 10, { size: 22, color: C.muted, align: 'center' });

  // Trim to the content.
  const out = document.createElement('canvas');
  out.width = W;
  out.height = y + 50;
  out.getContext('2d').drawImage(canvas, 0, 0);
  return out;
}

// A one-page PDF holding the report picture (JPEG). Built by hand, so it
// works on every phone without a print dialog or extra libraries.
function pdfFromJpeg(jpeg, w, h) {
  const pw = 595; // A4 width in points; the page is as tall as the report
  const ph = Math.round((h * pw) / w);
  const enc = new TextEncoder();
  const parts = [];
  const offsets = [];
  let length = 0;
  const push = (chunk) => { const b = typeof chunk === 'string' ? enc.encode(chunk) : chunk; parts.push(b); length += b.length; };
  const obj = (n, body) => { offsets[n] = length; push(`${n} 0 obj\n${body}\nendobj\n`); };
  push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  obj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`);
  offsets[4] = length;
  push(`4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`);
  push(jpeg);
  push('\nendstream\nendobj\n');
  const draw = `q ${pw} 0 0 ${ph} 0 0 cm /Im0 Do Q`;
  obj(5, `<< /Length ${draw.length} >>\nstream\n${draw}\nendstream`);
  const xref = length;
  push(`xref\n0 6\n0000000000 65535 f \n${[1, 2, 3, 4, 5].map((n) => `${String(offsets[n]).padStart(10, '0')} 00000 n \n`).join('')}`);
  push(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(parts, { type: 'application/pdf' });
}

// Shares a file through the phone's share sheet (WhatsApp, etc.), or
// downloads it where sharing files isn't possible.
async function shareOrDownload(blob, name, title) {
  const file = new File([blob], name, { type: blob.type });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title });
      return 'shared';
    } catch (err) {
      if (err.name === 'AbortError') return 'cancelled';
    }
  }
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return 'downloaded';
}

export async function shareReport(r) {
  const canvas = drawReport(r);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  return shareOrDownload(blob, `meet-gurudev-report-${r.date}.png`, `Daily report ${r.date}`);
}

export async function saveReportPdf(r) {
  const canvas = drawReport(r);
  const jpegBlob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
  const jpeg = new Uint8Array(await jpegBlob.arrayBuffer());
  return shareOrDownload(pdfFromJpeg(jpeg, canvas.width, canvas.height), `meet-gurudev-report-${r.date}.pdf`, `Daily report ${r.date}`);
}
