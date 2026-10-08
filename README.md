# Meet Gurudev – Appointments

A simple, fast, mobile-first web app (installable on phones) for visits to meet Gurudev, with three kinds of users:

**Visitors** (`/`)
- Log in with their **WhatsApp number and a one-time code**. First time: add name and a **face photo**. The phone finds
  the face, crops around it and compresses it (~30 KB) so security can recognise them.
- Book a **day** and **Morning / Afternoon / Evening** (no times shown), then answer: reference (required), how many people
  (1–10), the WhatsApp number for the pass, purpose (blessings / guidance, invitation, project proposal, donation, life event,
  other) and a few words about the visit.
- Add the **name and number of each extra person**. Everyone can have only **one upcoming appointment**. If someone already
  has one, the app says when, and asks to cancel it or remove the person.
- Updates **on WhatsApp and in the app**: request received, confirmed, reminder the day before, greeting on the day, and
  the **QR entry pass** when the session opens (8 AM / 1 PM / 4 PM). The pass works **only that day** and **only once**.

**Security staff** (`/security.html`)
- Separate sign-up (name, number, face photo). An **admin must approve** them before the scanner opens; access can be removed at any time.
- One screen: **scan**. A valid pass shows the booker's **photo, name and number of people** with a big green **Allow entry**
  button. A used pass shows a red **ALREADY CHECKED IN** alert with when and by whom.

**Admins** (`/admin.html`)
- **Dashboard**: people checked in vs expected, Morning / Afternoon / Evening progress, a 14-day chart, recent check-ins with
  the security person who let them in. Updates live.
- **Requests**: Approve, **Hold** (separate list to decide later) or Decline.
- **Visitors**: any day's list with search, filters (not arrived / checked in / …), counts, and one-tap **call** and **WhatsApp**.
  Admins can also check someone in.
- **Security**: approve, search, call/WhatsApp, remove access.
- **More**: open days and set places per session, **send a WhatsApp message to everyone visiting on a day** (change of time,
  venue…), add admins, WhatsApp delivery log, and the scanner.

Everyone uses the same login. After logging in, each person sees the app for their role.

## Try it on your computer

Requires Node.js 22.13 or newer.

```bash
npm install
cp .env.example .env      # set ADMIN_PHONE to your WhatsApp number
npm start
```

Open http://localhost:3000. Without WhatsApp set up, login codes are printed in the terminal (and, with
`SHOW_OTP_ON_SCREEN=1`, shown on screen). Log in at `/admin.html` with `ADMIN_PHONE`, open **More → Open days and
sessions**, then book as a visitor from another browser or a private window.

## Setting up WhatsApp

The app uses Meta's official **WhatsApp Cloud API**. Meta charges a small fee per message (login codes are
"authentication" messages; updates and passes are "utility" messages).

1. In [Meta for Developers](https://developers.facebook.com/), create an app with WhatsApp, add your business number,
   and copy the **Phone number ID** and a **permanent access token** into `WHATSAPP_PHONE_NUMBER_ID` and `WHATSAPP_TOKEN`.
2. In WhatsApp Manager, create these three templates (language English) and wait for approval:

   | Name | Category | Content |
   | --- | --- | --- |
   | `login_code` | Authentication | Standard code message with a **Copy code** button |
   | `appointment_update` | Utility | Body: `{{1}}` new line `{{2}}` |
   | `entry_pass` | Utility | **Image** header; body: `{{1}}` new line `{{2}}` |

   `{{1}}` is the title (e.g. "Appointment confirmed ✅") and `{{2}}` the message. The QR code is sent as the header image.
3. Remove `SHOW_OTP_ON_SCREEN` and restart.

Messages go through a queue that retries failures and survives restarts. **More → WhatsApp delivery** shows what was sent.

## Going live

- Host it with **HTTPS** and set `APP_URL`. The camera scanner and phone notifications need HTTPS.
- Data is stored in `data/` (`appointments.db` and `photos/`). **Back up this folder.**
- Speed: tested with 1,000 visitors connected and **1,000 check-ins at the same moment**. All succeeded within 1.7 s,
  with double check-ins refused. Pages use no web fonts or frameworks, responses are compressed, and photos are ~30 KB.
- Personal data (phone numbers, face photos) is only visible to the person themselves, approved security staff and admins.

## Interactive preview

`npm run build:preview` builds `preview/dist/preview.html`: one page running the visitor, admin and security apps side by
side on sample data (with a preview clock to skip ahead to reminders and passes). Rebuild after changing the app.

## Development

```bash
npm run dev   # restart on changes
npm test      # API tests: login codes, roles, booking rules, reminders, QR pass, scanning, dashboard, broadcast
```

```
src/
  index.js            settings, first admin, scheduled messages every 30 s
  app.js              Express app (compression, static files, routes)
  routes/auth.js      WhatsApp code login, profile, photos
  routes/visitor.js   availability, booking rules, my visit, pass
  routes/staff.js     scanner (security + admins)
  routes/admin.js     dashboard, requests, visitors, security staff, sessions, broadcast, admins
  appointments.js     pass and scan rules
  jobs.js             day-before reminder, greeting, QR pass at session start
  whatsapp.js         WhatsApp Cloud API with a durable send queue
  notify.js           in-app, live updates, push
  db.js               SQLite schema (built-in node:sqlite)
public/
  index.html  js/visitor.js     visitor app
  security.html  js/security.js security app (js/scanner.js)
  admin.html  js/admin.js       admin app (js/chart.js)
  js/login.js, js/photo.js      WhatsApp login, face photo
preview/            interactive preview build
test/               node:test suite
```
