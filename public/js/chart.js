import { esc, formatShortDate, dayParts } from './common.js';

// Stacked columns per day: people checked in (bottom) + people expected who
// haven't arrived (top) = people confirmed. Plain SVG with a tap/hover tooltip.
const NS = 'http://www.w3.org/2000/svg';
const SERIES = [
  { key: 'checkedIn', label: 'Checked in', color: '#1baf7a' },
  { key: 'waiting', label: 'Not arrived yet', color: '#2a78d6' },
];

const niceMax = (v) => {
  if (v <= 4) return 4;
  const step = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((m) => m * step).find((x) => x >= v);
};
const roundedTop = (x, y, w, h, r) => { r = Math.min(r, h, w / 2); return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`; };

export const legendHtml = () => `<div class="legend">${SERIES.map((s) => `<span><i style="background:${s.color}"></i>${esc(s.label)}</span>`).join('')}</div>`;

export function renderChart(container, days, focus) {
  container.innerHTML = '';
  container.style.position = 'relative';
  const data = days.map((d) => ({ ...d, waiting: d.people - d.checkedIn }));
  const width = Math.max(container.clientWidth, 280);
  const height = 210;
  const m = { top: 18, right: 6, bottom: 34, left: 30 };
  const iw = width - m.left - m.right;
  const ih = height - m.top - m.bottom;
  const max = niceMax(Math.max(1, ...data.map((d) => d.people)));
  const band = iw / data.length;
  const bw = Math.min(24, Math.max(5, band * 0.6));
  const y = (v) => m.top + ih - (v / max) * ih;

  let html = '';
  for (let i = 0; i <= 4; i++) {
    const v = (max / 4) * i;
    const yy = Math.round(y(v)) + 0.5;
    html += `<line x1="${m.left}" x2="${width - m.right}" y1="${yy}" y2="${yy}" stroke="#e6ecf5"/>`;
    if (Number.isInteger(v)) html += `<text x="${m.left - 6}" y="${yy + 4}" text-anchor="end" font-size="11" fill="#7b8aa3">${v}</text>`;
  }
  const every = Math.ceil(40 / band);
  data.forEach((d, i) => {
    const cx = m.left + band * i + band / 2;
    const isFocus = d.date === focus;
    if (i % every === 0 || isFocus) {
      const p = dayParts(d.date);
      html += `<text x="${cx}" y="${height - 18}" text-anchor="middle" font-size="11" font-weight="${isFocus ? 800 : 500}" fill="${isFocus ? '#0f1f3d' : '#7b8aa3'}">${esc(p.day)}</text>`;
      html += `<text x="${cx}" y="${height - 5}" text-anchor="middle" font-size="10" fill="#7b8aa3">${esc(p.mon)}</text>`;
    }
    const x = m.left + band * i + (band - bw) / 2;
    let base = 0;
    const visible = SERIES.filter((s) => d[s.key] > 0);
    visible.forEach((s, si) => {
      const top = y(base + d[s.key]);
      const bottom = y(base) - (base > 0 ? 2 : 0);
      const h = Math.max(0, bottom - top);
      html += si === visible.length - 1 ? `<path d="${roundedTop(x, top, bw, h, 4)}" fill="${s.color}"/>` : `<rect x="${x}" y="${top}" width="${bw}" height="${h}" fill="${s.color}"/>`;
      base += d[s.key];
    });
    if (d.people > 0 && band >= 20) html += `<text x="${x + bw / 2}" y="${y(d.people) - 5}" text-anchor="middle" font-size="11" font-weight="700" fill="#4a5b78">${d.people}</text>`;
  });
  html += `<line x1="${m.left}" x2="${width - m.right}" y1="${m.top + ih + 0.5}" y2="${m.top + ih + 0.5}" stroke="#dfe6f1"/>`;
  data.forEach((d, i) => {
    html += `<rect data-i="${i}" x="${m.left + band * i}" y="${m.top}" width="${band}" height="${ih}" fill="transparent" tabindex="0" aria-label="${esc(formatShortDate(d.date))}: ${d.people} expected, ${d.checkedIn} checked in"/>`;
  });
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('height', height);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'People confirmed and checked in per day');
  svg.innerHTML = html;
  container.append(svg);

  const tip = document.createElement('div');
  tip.style.cssText = 'position:absolute;pointer-events:none;background:#fff;border:1px solid #dfe6f1;border-radius:12px;padding:8px 12px;box-shadow:0 8px 24px rgba(10,35,87,.15);font-size:.84rem;display:none;min-width:150px;z-index:2';
  container.append(tip);
  const show = (i) => {
    const d = data[i];
    tip.replaceChildren();
    const head = document.createElement('div');
    head.style.cssText = 'color:#4a5b78;margin-bottom:4px';
    head.textContent = formatShortDate(d.date);
    tip.append(head);
    for (const [label, value, color] of [['Expected', d.people, null], ['Checked in', d.checkedIn, SERIES[0].color], ['Not arrived', d.waiting, SERIES[1].color]]) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:8px;align-items:center';
      const key = document.createElement('span');
      key.style.cssText = `width:12px;height:2px;background:${color ?? 'transparent'}`;
      const b = document.createElement('b');
      b.textContent = value;
      b.style.minWidth = '22px';
      const l = document.createElement('span');
      l.textContent = label;
      l.style.color = '#7b8aa3';
      row.append(key, b, l);
      tip.append(row);
    }
    tip.style.display = 'block';
    const cx = m.left + band * i + band / 2;
    tip.style.left = `${Math.min(Math.max(cx - tip.offsetWidth / 2, 0), width - tip.offsetWidth)}px`;
    tip.style.top = `${Math.max(0, y(d.people) - tip.offsetHeight - 10)}px`;
  };
  const hide = () => { tip.style.display = 'none'; };
  svg.addEventListener('pointermove', (e) => { const i = e.target.dataset?.i; i != null ? show(Number(i)) : hide(); });
  svg.addEventListener('pointerleave', hide);
  svg.addEventListener('focusin', (e) => e.target.dataset?.i != null && show(Number(e.target.dataset.i)));
  svg.addEventListener('focusout', hide);
}
