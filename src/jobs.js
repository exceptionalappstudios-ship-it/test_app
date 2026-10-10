import { nowInTimezone, addDays, formatVisit, formatDay, PERIOD_LABELS } from './time.js';
import { ensurePass, passMessage, passAppMessage } from './appointments.js';

// Scheduled WhatsApp + in-app messages for confirmed visits:
//   - the day before (at REMINDER_TIME): "your visit is tomorrow"
//   - on the day (at GREETING_TIME): a greeting
// The QR entry pass itself goes out with the confirmation; any confirmed visit
// that somehow has no pass yet gets it on the morning of the visit.
export function createJobs({ db, notifier, config, now = () => new Date() }) {
  const { timeZone } = config;

  function run() {
    const clock = nowInTimezone(timeZone, now());
    const today = clock.date;
    const tomorrow = addDays(today, 1);
    let sent = 0;

    if (clock.time >= config.reminderTime) {
      const rows = db.prepare(`SELECT * FROM appointments WHERE status = 'approved' AND date = ? AND reminded_day_before = 0`).all(tomorrow);
      const mark = db.prepare('UPDATE appointments SET reminded_day_before = 1 WHERE id = ?');
      for (const a of rows) {
        mark.run(a.id);
        notifier.notify(a.user_id, a.id, 'Your visit is tomorrow 🙏',
          `${formatVisit(a)} · ${a.people_count} ${a.people_count === 1 ? 'person' : 'people'}. Keep your pass ready (entry code ${a.checkin_code}). Come any time tomorrow.`,
          { phone: a.phone });
        sent++;
      }
    }

    if (clock.time >= config.greetingTime) {
      const rows = db.prepare(`SELECT * FROM appointments WHERE status = 'approved' AND date = ? AND greeted = 0 AND checked_in_at IS NULL`).all(today);
      const mark = db.prepare('UPDATE appointments SET greeted = 1, reminded_day_before = 1 WHERE id = ?');
      for (const a of rows) {
        mark.run(a.id);
        const passNote = a.pass_sent_at ? `Show your pass at the gate (entry code ${a.checkin_code}).` : 'Your pass is coming now.';
        notifier.notify(a.user_id, a.id, 'Jai Gurudev 🙏 Today is your visit',
          `${a.name}, see you today (${PERIOD_LABELS[a.period]}). ${passNote}`, { phone: a.phone });
        sent++;
      }
    }

    // Passes for confirmed visits that don't have one yet.
    const due = db.prepare(`SELECT * FROM appointments WHERE status = 'approved' AND date = ? AND pass_sent_at IS NULL AND checked_in_at IS NULL`).all(today);
    const markPass = db.prepare("UPDATE appointments SET pass_sent_at = datetime('now'), greeted = 1, reminded_day_before = 1 WHERE id = ?");
    for (const row of due) {
      const a = ensurePass(db, row);
      markPass.run(a.id);
      notifier.sendPass(a, 'Your pass 🎟️', passMessage(a, `today (${formatDay(today)}, ${PERIOD_LABELS[a.period]})`), passAppMessage(a, `Today (${PERIOD_LABELS[a.period]})`));
      sent++;
    }
    return sent;
  }

  let timer = null;
  return {
    run,
    // Runs shortly after an approval, so a same-day approval gets its pass right away.
    runSoon() { clearTimeout(timer); timer = setTimeout(() => { try { run(); } catch (err) { console.error('Scheduled messages failed:', err); } }, 1000); timer.unref?.(); },
  };
}
