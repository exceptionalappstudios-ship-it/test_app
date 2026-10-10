# Meet Gurudev – Appointments

A simple, fast, mobile-first web app (installable on phones) for visits to meet Gurudev, with three kinds of users:

**Visitors** (`/`)
- Log in with their **WhatsApp number and a one-time code**. First time: add name and a **face photo**. The phone finds
  the face, crops around it and compresses it (~30 KB) so security can recognise them.
- Book a **day** and **Morning / Evening** (no times shown), then answer: who referred them (**chosen from the reference
  list**, plus that person's **phone number, which must match**, or they cannot book), how many people (1–5), the WhatsApp number for the
  pass, purpose (blessings / guidance, invitation, project proposal, donation, life event, other) and a few words about the visit.
- Add the **name and number of each extra person**. Everyone can have only **one upcoming appointment**. If someone already
  has one, the app says when, and asks to cancel it or remove the person.
- Updates **on WhatsApp and in the app**: request received, **confirmed (with the entry pass)**, reminder the day before and
  greeting on the day. WhatsApp gets a **6-character entry code** (letters and
  numbers, no look-alikes such as 0/O or 1/I) and a **"View pass" link** to a tiny pass page (about 5 KB) that opens fast
  even on a weak signal. The pass works **any time on the visit day**, and **only once**.
- About screenshots: no website can fully block screenshots or screen recording. The pass page shows a live clock and a
  moving band, hides itself when the phone switches apps, and blocks long-press saving. Because each pass can be scanned
  only once and security checks the photo, a copied pass does not help anyone get in twice.

**Security staff** (`/security.html`)
- Separate sign-up: name, number, a **face photo (a face must be found, or they can't continue)** and their **reference**
  from the list. **Only that reference** sees the request and can approve it; any admin can remove access later.
- One screen: **scan** (camera, or type the 6-character code). A valid pass shows the booker's **photo, name and number of
  people**, one-tap buttons for **how many actually came** (e.g. 3 of 5), and a big green **Allow entry** button. A used pass
  shows a red **ALREADY CHECKED IN** alert with when and by whom. Today's list lets them correct the number in one tap.

**Admins** (`/admin.html`)
- The admins are the people on the **reference list** (`src/references.js`). They log in with their **phone number and the
  admin password** (`ADMIN_PASSWORD` on the host replaces the built-in one). The list can only be changed in that file.
- **Dashboard**: people checked in vs expected, Morning / Evening progress, a 14-day chart, recent check-ins with
  the security person who let them in. Updates live.
- **Requests**: Approve, **Hold** (separate list to decide later) or Decline. The reference shows with one-tap call and
  WhatsApp so admins can check it.
- **Express pass**: let someone in today. **Reference** on top (picked from the list), then **name and WhatsApp number**;
  group size, photo, purpose and note are optional below. The QR pass is sent on WhatsApp at once and works for the rest of the day, scanned once.
- **Visitors**: any day's list with search, filters (not arrived / checked in / …), counts, and one-tap **call** and **WhatsApp**.
  Admins can also check someone in.
- **Security**: approve, search, call/WhatsApp, remove access.
- **Bookings & slots**: one switch to stop or start all new bookings (with a message for visitors), open a date range
  (5 days by default from the chosen start date), close or open a
  whole day, and for each Morning / Evening set the number of slots (people) or switch it off.
- **More**: the admin list, WhatsApp delivery log, and the scanner.

Phone numbers are always **10 digits** (the boxes accept only digits and stop at 10; pasted numbers starting with
+91 or 0 are cleaned up). Visitors and security log in with a WhatsApp code; admins with a password. After logging in, each person sees the app for their role. Inner screens have a back arrow,
and the phone's Back button steps back through the booking and closes pop-ups.

## Try it on your computer

Requires Node.js 22.13 or newer.

```bash
npm install
cp .env.example .env      # admins and references: src/references.js
npm start
```

Open http://localhost:3000. Without WhatsApp set up, login codes are printed in the terminal (and, with
`SHOW_OTP_ON_SCREEN=1`, shown on screen). Log in at `/admin.html` with an admin number and the admin password, open **More → Bookings & slots**, then book as a visitor from another browser or a private window.

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
   | `entry_pass` | Utility | Body: `{{1}}` new line `{{2}}`; **URL button** "View pass" → `https://YOUR-DOMAIN/p/{{1}}` |

   `{{1}}` is the title (e.g. "Appointment confirmed ✅") and `{{2}}` the message (it includes the 6-character entry code).
   The pass button's `{{1}}` is the secret part of the pass link, filled in automatically.
3. Remove `SHOW_OTP_ON_SCREEN` and restart.

Messages go through a queue that retries failures and survives restarts. **More → WhatsApp delivery** shows what was sent.

## Going live

### Deploy on Railway

The repo includes `railway.json` (start command, health check at `/healthz`, restart on failure).

1. On [railway.com](https://railway.com), sign in with GitHub → **New Project → Deploy from GitHub repo** → pick this repo.
2. Service **Settings → Source**: choose the branch to deploy.
3. Right-click the service → **Attach volume**, mount path `/data`. Bookings and photos live here. Without it, they are lost on every deploy.
4. **Variables**: the `WHATSAPP_*` values and the optional `CONTACT_*` values.
   `APP_URL` and the data folder are picked up from Railway automatically.
5. **Settings → Networking → Generate Domain** (or add your own domain).
6. Keep **one replica**: the database is a single file on the volume.

Until WhatsApp is set up, login codes are **shown on screen** (admins use the password, never a code). This lets anyone
log in with any visitor or security number, so connect WhatsApp before real use, or set `SHOW_OTP_ON_SCREEN=0`.

- Host it with **HTTPS** and set `APP_URL`. The camera scanner and phone notifications need HTTPS.
- Data is stored in `data/` (`appointments.db` and `photos/`). **Back up this folder.**
- Speed: tested with 1,000 visitors connected and **1,000 check-ins at the same moment**. All succeeded within 1.7 s,
  with double check-ins refused. Pages use no web fonts or frameworks, responses are compressed, and photos are ~30 KB.
- Personal data (phone numbers, face photos) is only visible to the person themselves, approved security staff and admins.

## Security

What protects the app (each is covered by the tests in `test/app.test.js`):

- **Logins**: WhatsApp codes are random, hashed, single-use, expire in 10 minutes, and allow 5 tries; requests are limited per
  number, per connection, per day and overall (each code is a paid message). Admin passwords are checked with scrypt off the
  main thread; only wrong tries count, limited per number (8 per 15 minutes, 30 a day) and per connection. Wrong numbers and
  wrong passwords get the same answer. Sessions are random tokens stored hashed, in an HttpOnly, SameSite cookie (Secure on
  HTTPS); admin sessions last 3 days, security 30, visitors 60.
- **Who sees what**: every admin route needs an admin, every scanner route an approved security person or admin (checked on
  each request, so removing access works at once). Security find passes **only by their code**, see only name, photo, group
  names and visit (no phone numbers, reference or notes), and are limited on wrong codes. Photos are visible only to their
  owner and staff, under random names. Visitors can only see and cancel their own visits.
- **Other websites**: strict Content-Security-Policy (only this site's scripts), no framing (clickjacking), nosniff, HSTS,
  same-origin referrer, camera only for this site, and state-changing requests from other sites are refused.
- **Abuse**: bookings (6 a day), photo uploads (15 an hour; a replaced photo is deleted), reference guesses (10 a person and
  30 a connection per hour), push sign-ups (real push services only, 5 devices) and live connections (5 per person) are
  limited. Someone else's request can't lock a number out; a number is blocked only by a confirmed visit, and admins can't
  confirm two visits for the same person. Names lose hidden and direction-changing characters. All database queries use
  parameters; error messages never show internals.

**Before real visitors use it** (kept for the demo on purpose):
1. Connect WhatsApp, so login codes are no longer shown on screen. Until then anyone can log in as any visitor or security
   number.
2. Set `ADMIN_PASSWORD` on the host to a long, private password (or give each admin their own), and remove the Demo
   reference/admin (1234567890) from `src/references.js`.

## Interactive preview

`npm run build:preview` builds `preview/dist/preview.html`: one page running the visitor, admin and security apps side by
side on sample data (with a preview clock to skip ahead to reminders and passes). Rebuild after changing the app.

## Development

```bash
npm run dev   # restart on changes
npm test      # API tests: login codes, roles, booking rules, reminders, pass link, scanning, people count, dashboard, express
```

```
src/
  index.js            settings, admins from the reference list, scheduled messages every 30 s
  app.js              Express app (compression, static files, routes)
  routes/auth.js      WhatsApp code login, admin password login, profile, photos
  references.js       reference list (also the admins) and the admin password hash
  routes/visitor.js   availability, booking rules, my visit, pass
  routes/staff.js     scanner (security + admins)
  routes/admin.js     dashboard, requests, visitors, security staff, sessions, express pass, admins
  passPage.js         the small pass page opened from the WhatsApp link
  appointments.js     pass and scan rules
  jobs.js             day-before reminder and greeting on the day
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
