import nodemailer from 'nodemailer';

// Email (SMTP) and WhatsApp (Meta WhatsApp Cloud API) delivery. When a channel
// isn't configured, messages are logged to the console instead, so the app
// works out of the box in development. Every attempt is recorded in
// outbound_messages.
export function createChannels(db, config) {
  const fetchFn = config.fetch ?? fetch;
  const log = db.prepare(
    'INSERT INTO outbound_messages (channel, recipient, subject, body, status, error) VALUES (?, ?, ?, ?, ?, ?)'
  );

  const transport = config.smtp?.host ? nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.port === 465,
    auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
  }) : null;

  async function sendEmail(to, subject, text, html) {
    if (!transport) {
      log.run('email', to, subject, text, 'logged', null);
      if (config.logOutbound) console.log(`[email → ${to}] ${subject}\n${text}\n`);
      return;
    }
    try {
      await transport.sendMail({ from: config.smtp.from, to, subject, text, html });
      log.run('email', to, subject, text, 'sent', null);
    } catch (err) {
      log.run('email', to, subject, text, 'failed', err.message);
      console.warn(`Email to ${to} failed:`, err.message);
    }
  }

  // Business-initiated WhatsApp messages must use a pre-approved template.
  // The template is expected to have two body variables: {{1}} title, {{2}} message.
  async function sendWhatsApp(phone, title, body) {
    const wa = config.whatsapp;
    // Template variables may not contain newlines, tabs or 4+ consecutive spaces.
    const clean = (s) => s.replace(/\s*\n+\s*/g, ' · ').replace(/\s{2,}/g, ' ').slice(0, 1000);
    const summary = `${title}: ${clean(body)}`;
    if (!wa?.token || !wa?.phoneNumberId) {
      log.run('whatsapp', phone, title, summary, 'logged', null);
      if (config.logOutbound) console.log(`[whatsapp → ${phone}] ${summary}\n`);
      return;
    }
    try {
      const res = await fetchFn(`https://graph.facebook.com/v21.0/${wa.phoneNumberId}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${wa.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: phone.replace(/^\+/, ''),
          type: 'template',
          template: {
            name: wa.template,
            language: { code: wa.language },
            components: [{ type: 'body', parameters: [{ type: 'text', text: clean(title) }, { type: 'text', text: clean(body) }] }],
          },
        }),
      });
      if (!res.ok) throw new Error(`WhatsApp API ${res.status}: ${(await res.text()).slice(0, 300)}`);
      log.run('whatsapp', phone, title, summary, 'sent', null);
    } catch (err) {
      log.run('whatsapp', phone, title, summary, 'failed', err.message);
      console.warn(`WhatsApp to ${phone} failed:`, err.message);
    }
  }

  return { sendEmail, sendWhatsApp };
}
