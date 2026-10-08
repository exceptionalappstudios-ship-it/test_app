import { nowInTimezone, minutesUntil, addDays, formatVisit, formatClock, formatDay, PERIOD_LABELS } from './time.js';

// Scheduled WhatsApp + in-app messages for confirmed visits:
//   - the day before (at REMINDER_TIME): "your visit is tomorrow, your QR pass comes tomorrow"
//   - on the day (at GREETING_TIME): a greeting
//   - when the session opens: the QR entry pass
export function createJobs({ db, notifier, config, now = () => new Date() }) {
  const { timeZone, periods } = config;

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
          `Reminder: your meeting with Gurudev is tomorrow, ${formatVisit(a)}, for ${a.people_count} ${a.people_count === 1 ? 'person' : 'people'}. Your QR entry pass will be sent on WhatsApp tomorrow at ${formatClock(periods[a.period].start)}.`,
          { phone: a.phone });
        sent++;
      }
    }

    if (clock.time >= config.greetingTime) {
      const rows = db.prepare(`SELECT * FROM appointments WHERE status = 'approved' AND date = ? AND greeted = 0 AND checked_in_at IS NULL`).all(today);
      const mark = db.prepare('UPDATE appointments SET greeted = 1, reminded_day_before = 1 WHERE id = ?');
      for (const a of rows) {
        mark.run(a.id);
        const opens = periods[a.period].start;
        const passNote = minutesUntil(today, opens, timeZone, now()) > 0
          ? `Your QR entry pass will be sent at ${formatClock(opens)}.`
          : 'Your QR entry pass is being sent now.';
        notifier.notify(a.user_id, a.id, 'Jai Gurudev 🙏 Today is your visit',
          `Good day, ${a.name}! Today is your meeting with Gurudev (${PERIOD_LABELS[a.period]}). ${passNote}`, { phone: a.phone });
        sent++;
      }
    }

    // Passes go out when each session opens.
    const due = db.prepare(`SELECT * FROM appointments WHERE status = 'approved' AND date = ? AND pass_sent_at IS NULL AND checked_in_at IS NULL`).all(today);
    const markPass = db.prepare("UPDATE appointments SET pass_sent_at = datetime('now'), greeted = 1, reminded_day_before = 1 WHERE id = ?");
    for (const a of due) {
      if (minutesUntil(today, periods[a.period].start, timeZone, now()) > 0) continue;
      markPass.run(a.id);
      notifier.sendPass(a, 'Your entry pass 🎟️',
        `${a.name}, this is your QR pass for today (${formatDay(today)}, ${PERIOD_LABELS[a.period]}) for ${a.people_count} ${a.people_count === 1 ? 'person' : 'people'}. Show it at the entrance. It is valid only today and can be scanned only once.`);
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
