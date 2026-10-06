import { esc, formatShortDate, dayParts } from './common.js';

// Stacked column chart: per date, checked-in (bottom) + booked but not yet
// checked in (top) = total booked. Built as plain SVG with a hover/tap tooltip.
const NS = 'http://www.w3.org/2000/svg';
const SERIES = [
  { key: 'checkedIn', label: 'Checked in', color: 'var(--series-1)' },
  { key: 'awaiting', label: 'Booked, not checked in', color: 'var(--series-2)' },
];

function niceMax(v) {
  if (v <= 4) return 4;
  const step = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * step >= v) return m * step;
  return v;
}

function roundedTopRect(x, y, w, h, r) {
  r = Math.min(r, h, w / 2);
  return `M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z`;
}

export function renderChart(container, days, today) {
  container.innerHTML = '';
  const data = days.map((d) => ({ ...d, awaiting: d.booked - d.checkedIn }));
  const width = Math.max(container.clientWidth, 280);
  const height = 220;
  const m = { top: 16, right: 8, bottom: 34, left: 28 };
  const iw = width - m.left - m.right;
  const ih = height - m.top - m.bottom;
  const max = niceMax(Math.max(1, ...data.map((d) => d.booked)));
  const band = iw / data.length;
  const bw = Math.min(24, Math.max(4, band * 0.62));
  const y = (v) => m.top + ih - (v / max) * ih;

  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('height', height);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Appointments booked and checked in per date');

  let html = '';
  // Gridlines and y ticks.
  const ticks = 4;
  for (let i = 0; i <= ticks; i++) {
    const v = (max / ticks) * i;
    const yy = Math.round(y(v)) + 0.5;
    html += `<line x1="${m.left}" x2="${width - m.right}" y1="${yy}" y2="${yy}" stroke="var(--grid)" stroke-width="1"/>`;
    html += `<text x="${m.left - 6}" y="${yy + 4}" text-anchor="end" font-size="11" fill="var(--muted)" style="font-variant-numeric:tabular-nums">${Number.isInteger(v) ? v : ''}</text>`;
  }
  // X labels: thin out so they never collide.
  const every = Math.ceil(42 / band);
  data.forEach((d, i) => {
    const cx = m.left + band * i + band / 2;
    const isToday = d.date === today;
    if (i % every === 0 || isToday) {
      const p = dayParts(d.date);
      html += `<text x="${cx}" y="${height - 18}" text-anchor="middle" font-size="11" fill="${isToday ? 'var(--text)' : 'var(--muted)'}" font-weight="${isToday ? 700 : 400}">${isToday ? 'Today' : esc(p.day)}</text>`;
      html += `<text x="${cx}" y="${height - 5}" text-anchor="middle" font-size="10" fill="var(--muted)">${isToday ? esc(p.day + ' ' + p.month) : esc(p.month)}</text>`;
    }
  });
  // Columns: 2px surface gap between stacked segments, rounded data-end only.
  data.forEach((d, i) => {
    const x = m.left + band * i + (band - bw) / 2;
    let base = 0;
    const visible = SERIES.filter((s) => d[s.key] > 0);
    visible.forEach((s, si) => {
      const v = d[s.key];
      const top = y(base + v);
      const bottom = y(base) - (base > 0 ? 2 : 0);
      const h = Math.max(0, bottom - top);
      const isTop = si === visible.length - 1;
      html += isTop
        ? `<path d="${roundedTopRect(x, top, bw, h, 4)}" fill="${s.color}"/>`
        : `<rect x="${x}" y="${top}" width="${bw}" height="${h}" fill="${s.color}"/>`;
      base += v;
    });
    // Direct label: total on the cap, only where the band is wide enough.
    if (d.booked > 0 && band >= 22) {
      html += `<text x="${x + bw / 2}" y="${y(d.booked) - 5}" text-anchor="middle" font-size="11" font-weight="600" fill="var(--text-2)">${d.booked}</text>`;
    }
  });
  html += `<line x1="${m.left}" x2="${width - m.right}" y1="${m.top + ih + 0.5}" y2="${m.top + ih + 0.5}" stroke="var(--border)" stroke-width="1"/>`;
  // Hit targets: the full band, bigger than the mark.
  data.forEach((d, i) => {
    html += `<rect class="hit" data-i="${i}" x="${m.left + band * i}" y="${m.top}" width="${band}" height="${ih}" fill="transparent" tabindex="0" aria-label="${esc(formatShortDate(d.date))}: ${d.booked} booked, ${d.checkedIn} checked in"/>`;
  });
  svg.innerHTML = html;
  container.append(svg);

  const tip = document.createElement('div');
  tip.className = 'tooltip hidden';
  container.append(tip);
  let hovered = null;
  const highlight = (i) => {
    hovered?.remove();
    hovered = null;
    if (i == null) return;
    hovered = document.createElementNS(NS, 'rect');
    Object.entries({ x: m.left + band * i, y: m.top, width: band, height: ih, fill: 'var(--text)', opacity: 0.05, 'pointer-events': 'none' })
      .forEach(([k, v]) => hovered.setAttribute(k, v));
    svg.insertBefore(hovered, svg.firstChild);
  };
  const show = (i) => {
    const d = data[i];
    tip.replaceChildren();
    const head = document.createElement('div');
    head.className = 't-head';
    head.textContent = formatShortDate(d.date) + (d.date === today ? ' · Today' : '');
    tip.append(head);
    const rows = [
      ['Booked', d.booked, null],
      ['Checked in', d.checkedIn, 'var(--series-1)'],
      ['Not checked in', d.awaiting, 'var(--series-2)'],
      ['Pending requests', d.pending, null],
      ['Open slots', d.open, null],
    ];
    for (const [label, value, color] of rows) {
      const row = document.createElement('div');
      row.className = 't-row';
      const key = document.createElement('span');
      key.className = 't-key';
      key.style.background = color ?? 'transparent';
      const b = document.createElement('b');
      b.textContent = value;
      const l = document.createElement('span');
      l.className = 'muted';
      l.textContent = label;
      row.append(key, b, l);
      tip.append(row);
    }
    tip.classList.remove('hidden');
    const cx = m.left + band * i + band / 2;
    const left = Math.min(Math.max(cx - tip.offsetWidth / 2, 0), width - tip.offsetWidth);
    tip.style.left = `${left}px`;
    tip.style.top = `${Math.max(0, y(d.booked) - tip.offsetHeight - 10)}px`;
    highlight(i);
  };
  const hide = () => { tip.classList.add('hidden'); highlight(null); };
  svg.addEventListener('pointermove', (e) => { const i = e.target.dataset?.i; i != null ? show(Number(i)) : hide(); });
  svg.addEventListener('pointerleave', hide);
  svg.addEventListener('focusin', (e) => e.target.dataset?.i != null && show(Number(e.target.dataset.i)));
  svg.addEventListener('focusout', hide);
}

export function legendHtml() {
  return `<div class="legend">${SERIES.map((s) => `<span><i style="background:${s.color}"></i>${esc(s.label)}</span>`).join('')}</div>`;
}
