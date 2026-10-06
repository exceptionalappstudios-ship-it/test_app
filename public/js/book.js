import { api, esc, formatDate, formatSlot, getVisitorToken, setVisitorToken, visitorHeaders, enablePush, refreshNavBadge } from './common.js';

const $ = (id) => document.getElementById(id);
let selected = null;
let slotsById = new Map();

function showStep(n) {
  $('slotsView').classList.toggle('hidden', n !== 1);
  $('detailsView').classList.toggle('hidden', n !== 2);
  $('doneView').classList.toggle('hidden', n !== 3);
  [1, 2, 3].forEach((i) => $(`step${i}`).classList.toggle('on', i === n));
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function loadSlots() {
  try {
    const [{ slots }, { timeZone }] = await Promise.all([api('/api/slots'), api('/api/config')]);
    $('tzNote').textContent = `All times are in ${timeZone.replace('_', ' ')} time.`;
    slotsById = new Map(slots.map((s) => [s.id, s]));
    if (!slots.length) {
      $('slots').innerHTML = '<p class="empty">No slots are available right now. Please check back soon.</p>';
      return;
    }
    const byDate = Map.groupBy ? Map.groupBy(slots, (s) => s.date)
      : slots.reduce((m, s) => m.set(s.date, [...(m.get(s.date) ?? []), s]), new Map());
    $('slots').innerHTML = [...byDate].map(([date, list]) => `
      <div class="day">
        <h3>${esc(formatDate(date))}</h3>
        <div class="chips">
          ${list.map((s) => `<button type="button" class="chip" data-id="${s.id}">${esc(s.start_time)}–${esc(s.end_time)}</button>`).join('')}
        </div>
      </div>`).join('');
  } catch (err) {
    $('slots').innerHTML = `<p class="error">${esc(err.message)}</p>`;
  }
}

$('slots').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  document.querySelectorAll('.chip.selected').forEach((c) => c.classList.remove('selected'));
  chip.classList.add('selected');
  selected = slotsById.get(Number(chip.dataset.id));
  $('toDetails').disabled = false;
});

$('toDetails').addEventListener('click', () => {
  $('selectedSlot').textContent = formatSlot(selected);
  showStep(2);
  $('name').focus();
});

$('changeSlot').addEventListener('click', () => showStep(1));

$('bookingForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  $('formError').classList.add('hidden');
  if (!form.checkValidity()) {
    form.reportValidity();
    return;
  }
  $('submitBtn').disabled = true;
  try {
    const data = Object.fromEntries(new FormData(form));
    const { visitorToken, appointment } = await api('/api/appointments', {
      method: 'POST', body: { ...data, slotId: selected.id }, headers: visitorHeaders(),
    });
    if (visitorToken !== getVisitorToken()) setVisitorToken(visitorToken);
    $('doneSlot').textContent = formatSlot(appointment.slot);
    form.reset();
    showStep(3);
    refreshNavBadge();
  } catch (err) {
    $('formError').textContent = err.message;
    $('formError').classList.remove('hidden');
    if (err.status === 409) {
      selected = null;
      $('toDetails').disabled = true;
      await loadSlots();
    }
  } finally {
    $('submitBtn').disabled = false;
  }
});

$('enablePush').addEventListener('click', async () => {
  const msg = $('pushMsg');
  try {
    await enablePush();
    msg.className = 'success';
    msg.textContent = "Notifications are on. We'll let you know as soon as your request is reviewed.";
    $('enablePush').disabled = true;
  } catch (err) {
    msg.className = 'error';
    msg.textContent = err.message;
  }
});

loadSlots();
refreshNavBadge();
