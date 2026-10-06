# Meet Gurudev – Appointment Booking

A small web app (installable on phones as an app) where visitors book time to meet Gurudev:

1. **See available slots** – visitors browse open time slots grouped by day.
2. **Answer a few questions** – name, phone number, email and purpose of the meeting.
3. **Approval** – the request is held as *pending* (no one else can take that slot) until an admin approves or declines it.
4. **Notifications** – visitors get in-app notifications for every update, plus optional push notifications on their phone/computer:
   - request received
   - appointment confirmed (with an optional note, e.g. "please bring a photo ID") / declined / cancelled
   - reminder the day before and 1 hour before the meeting

## Pages

| Page | Who | What |
| --- | --- | --- |
| `/` | Visitors | Pick a slot → fill in details → request sent |
| `/my.html` | Visitors | Their appointments, status, notifications feed, turn on push, cancel |
| `/admin.html` | Ashram team | Approve / decline requests, cancel appointments, create / block / delete slots |

Visitors don't need to create an account: when they book, their browser receives a private
token, which is how "My appointments" and notifications find them on that device.

## Running it

Requires Node.js 22.13 or newer.

```bash
npm install
ADMIN_PASSWORD='choose-a-strong-password' npm start
```

Open http://localhost:3000 for visitors and http://localhost:3000/admin.html for the admin
dashboard. Start by going to **Manage slots** and creating slots (e.g. Mon–Sat, 10:00–12:00,
15-minute meetings with a 5-minute break).

### Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `ADMIN_PASSWORD` | random, printed at startup | Password for the admin dashboard |
| `APP_TIMEZONE` | `Asia/Kolkata` | Timezone all slot times are in |
| `PORT` | `3000` | HTTP port |
| `DATABASE_FILE` | `data/appointments.db` | SQLite database file |
| `VAPID_SUBJECT` | `mailto:admin@example.com` | Contact for push services – set to your email (`mailto:you@domain`) |

Push notification keys are generated automatically on first start and stored in the database.

### Push notifications

Browsers only allow push over **HTTPS** (or `localhost`), so deploy behind HTTPS. On iPhone,
push works once the visitor adds the site to their home screen (Share → *Add to Home Screen*,
iOS 16.4+). Without push, visitors still see every update in the app, live, while it's open.

## Development

```bash
npm run dev   # restart on file changes
npm test      # API tests (booking, approval, notifications, reminders)
```

### Project layout

```
src/
  index.js    server entrypoint + reminder job (runs every minute)
  app.js      HTTP API: slots, bookings, visitor area, admin
  notify.js   in-app notifications, live updates (SSE) and Web Push
  db.js       SQLite schema (built-in node:sqlite)
  time.js     timezone helpers
public/       visitor + admin pages, service worker, PWA manifest
test/         API tests (node:test)
```
