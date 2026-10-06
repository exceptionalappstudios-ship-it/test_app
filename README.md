# Meet Gurudev – Appointments

A mobile-friendly web app (installable on phones) for booking meetings with Gurudev.

**Visitors** (`/`)
1. Create an account (name, mobile/WhatsApp, email, password).
2. Pick a date and time from the open slots and share the purpose of the meeting.
3. The request is held as *pending* until the ashram team approves it.
4. Get updates **in the app, by WhatsApp and by email**: request received, confirmed / declined / cancelled,
   reminders the day before and an hour before.
5. **10 minutes before the meeting, an entry QR code appears** in the app (with a notification).
   Show it at the entrance.
6. **Contact the team**: message thread in the app, plus call / WhatsApp / email buttons.

**Admins** (`/admin.html`)
- **Live dashboard**: today's booked / checked-in / yet-to-arrive counts, and a date-wise chart and table of
  bookings vs check-ins. Updates instantly as people book, get approved and check in.
- **Scan**: uses the phone camera to read a visitor's QR code, shows who they are, and admits them with one tap.
  It warns about wrong-day, early or late passes (you can still admit anyway), and refuses cancelled or already-used passes.
  A code can also be typed in by hand.
- **Requests**: approve (with an optional note) or decline; cancel approved appointments.
- **Messages**: reply to visitors' questions.
- **Manage**: create slots in bulk (date range, days of week, meeting length, breaks), block or delete slots,
  add or remove admins, change password.

## Running it

Requires Node.js 22.13 or newer.

```bash
npm install
cp .env.example .env      # then edit .env
npm start
```

Open http://localhost:3000 for visitors and http://localhost:3000/admin.html for admins. The first admin
account is created from `ADMIN_EMAIL` / `ADMIN_PASSWORD` in `.env`; that admin can add more admins in **Manage**.

Without email/WhatsApp settings the app still works: messages that would have been sent are printed in the
terminal instead.

## Email

Fill in the `SMTP_*` settings from any email provider (Gmail with an app password, Zoho, SendGrid, Amazon SES…).
Emails are sent for every update and for "forgot password" links.

## WhatsApp

Uses the official **Meta WhatsApp Cloud API**:

1. In [Meta for Developers](https://developers.facebook.com/), create an app with the WhatsApp product and add
   your business phone number. Copy the **Phone number ID** and create a **permanent access token**.
2. WhatsApp only allows businesses to message people first using an **approved template**. In WhatsApp Manager,
   create a *Utility* template named `appointment_update` (language English) with this body:

   ```
   {{1}}
   {{2}}
   ```

   `{{1}}` is the title (e.g. "Appointment confirmed 🙏") and `{{2}}` the message.
3. Set `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` (and `WHATSAPP_TEMPLATE` if you named it differently).

Phone numbers are stored in international format; numbers typed without a country code get `DEFAULT_COUNTRY_CODE` (91).

## Going live

- Serve it over **HTTPS** and set `APP_URL` to the https address. The camera scanner and phone notifications
  only work over HTTPS (or on `localhost`).
- On iPhone, visitors get phone notifications after adding the app to the Home Screen (Share → *Add to Home Screen*).
  WhatsApp and email work everywhere.
- Data is stored in a single SQLite file (`data/appointments.db`). Back it up regularly.

## Settings

All settings live in `.env`. See `.env.example` for the full list with explanations.

## Development

```bash
npm run dev   # restart on file changes
npm test      # API tests: accounts, booking, approvals, WhatsApp/email, reminders, QR pass, check-in, dashboard, messages
```

```
src/
  index.js          entrypoint: reads settings, creates the first admin, runs the reminder job each minute
  app.js            Express app wiring
  routes/auth.js    sign up, log in, password reset
  routes/visitor.js slots, booking, entry pass (QR), notifications, messages
  routes/admin.js   dashboard stats, requests, check-in, slots, messages, admins
  notify.js         in-app + live (SSE) + Web Push + email + WhatsApp fan-out
  channels.js       SMTP email and WhatsApp Cloud API senders
  jobs.js           reminders and "entry pass ready" notifications
  db.js             SQLite schema (built-in node:sqlite)
public/
  index.html, js/visitor.js   visitor app
  admin.html, js/admin.js     admin app (js/chart.js dashboard chart)
test/               node:test suite
```
