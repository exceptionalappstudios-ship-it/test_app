import QRCode from 'qrcode';

// WhatsApp delivery through the Meta WhatsApp Cloud API.
//
// Every message goes into the outbound_messages table first and is sent by a
// background worker with a few in parallel, so a burst (1,000 passes at 8 AM)
// never blocks a request, failures are retried, and nothing is lost on a
// restart. When WhatsApp isn't configured, messages are logged instead.
//
// Business-initiated WhatsApp messages must use templates approved by Meta:
//   otp    - Authentication template with a "copy code" button ({{1}} = code)
//   update - Utility template, body "{{1}}\n\n{{2}}" (title, message)
//   pass   - Utility template with an IMAGE header, body "{{1}}\n\n{{2}}"
export function createWhatsApp(db, config) {
  const wa = config.whatsapp;
  const fetchFn = config.fetch ?? fetch;
  const concurrency = config.whatsappConcurrency ?? 8;
  const graph = (path) => `https://graph.facebook.com/v21.0/${wa.phoneNumberId}/${path}`;

  const insert = db.prepare(`
    INSERT INTO outbound_messages (kind, recipient, payload, preview, status) VALUES (?, ?, ?, ?, ?)
  `);
  const claim = db.prepare(`
    UPDATE outbound_messages SET status = 'sending', attempts = attempts + 1
    WHERE id IN (SELECT id FROM outbound_messages WHERE status = 'queued' AND next_attempt_at <= datetime('now') ORDER BY id LIMIT ?)
    RETURNING *
  `);
  // Login codes are removed from the queue once sent.
  const markSent = db.prepare(`
    UPDATE outbound_messages SET status = 'sent', sent_at = datetime('now'), error = NULL,
      payload = CASE WHEN kind = 'otp' THEN '{}' ELSE payload END WHERE id = ?
  `);
  const markRetry = db.prepare(`
    UPDATE outbound_messages SET status = CASE WHEN attempts >= 5 THEN 'failed' ELSE 'queued' END,
      next_attempt_at = datetime('now', '+' || (30 * attempts * attempts) || ' seconds'), error = ? WHERE id = ?
  `);
  // Anything left mid-send by a restart goes back in the queue.
  db.prepare("UPDATE outbound_messages SET status = 'queued' WHERE status = 'sending'").run();

  // Template variables may not contain newlines, tabs or 4+ consecutive spaces.
  const clean = (s) => String(s).replace(/\s*\n+\s*/g, ' · ').replace(/\s{2,}/g, ' ').trim().slice(0, 1000);
  const param = (s) => ({ type: 'text', text: clean(s) });

  async function post(path, body, headers = { 'Content-Type': 'application/json' }) {
    const res = await fetchFn(graph(path), {
      method: 'POST',
      headers: { Authorization: `Bearer ${wa.token}`, ...headers },
      body: headers['Content-Type'] === 'application/json' ? JSON.stringify(body) : body,
    });
    if (!res.ok) throw new Error(`WhatsApp API ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return res.json();
  }

  async function uploadQr(code) {
    const png = await QRCode.toBuffer(code, { type: 'png', width: 640, margin: 3, errorCorrectionLevel: 'M' });
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', 'image/png');
    form.append('file', new Blob([png], { type: 'image/png' }), 'entry-pass.png');
    const res = await fetchFn(graph('media'), { method: 'POST', headers: { Authorization: `Bearer ${wa.token}` }, body: form });
    if (!res.ok) throw new Error(`WhatsApp media upload ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return (await res.json()).id;
  }

  function templateBody(row) {
    const p = JSON.parse(row.payload);
    const to = row.recipient.replace(/^\+/, '');
    const base = { messaging_product: 'whatsapp', to, type: 'template' };
    if (row.kind === 'otp') {
      return { ...base, template: { name: wa.otpTemplate, language: { code: wa.language }, components: [
        { type: 'body', parameters: [param(p.code)] },
        { type: 'button', sub_type: 'url', index: '0', parameters: [param(p.code)] },
      ] } };
    }
    if (row.kind === 'pass') {
      return async () => ({ ...base, template: { name: wa.passTemplate, language: { code: wa.language }, components: [
        { type: 'header', parameters: [{ type: 'image', image: { id: await uploadQr(p.code) } }] },
        { type: 'body', parameters: [param(p.title), param(p.body)] },
      ] } });
    }
    return { ...base, template: { name: wa.template, language: { code: wa.language }, components: [
      { type: 'body', parameters: [param(p.title), param(p.body)] },
    ] } };
  }

  async function deliver(row) {
    try {
      let body = templateBody(row);
      if (typeof body === 'function') body = await body();
      await post('messages', body);
      markSent.run(row.id);
    } catch (err) {
      markRetry.run(err.message.slice(0, 500), row.id);
      console.warn(`WhatsApp message ${row.id} to ${row.recipient} failed:`, err.message);
    }
  }

  let running = null;
  async function drain() {
    for (;;) {
      const rows = claim.all(concurrency * 4);
      if (!rows.length) return;
      for (let i = 0; i < rows.length; i += concurrency) {
        await Promise.all(rows.slice(i, i + concurrency).map(deliver));
      }
    }
  }
  // Starts the worker if it isn't already running; resolves when the queue is empty.
  function kick() {
    if (!wa?.token) return Promise.resolve();
    running ??= drain().finally(() => { running = null; });
    return running;
  }

  function enqueue(kind, recipient, payload, preview) {
    const configured = Boolean(wa?.token);
    insert.run(kind, recipient, JSON.stringify(configured || kind !== 'otp' ? payload : {}), preview, configured ? 'queued' : 'logged');
    if (!configured && config.logOutbound) console.log(`[whatsapp → ${recipient}] ${preview}`);
    if (configured) setImmediate(kick);
  }

  return {
    configured: Boolean(wa?.token),
    // The code never appears in the readable log; it's printed to the console
    // only when WhatsApp isn't configured, for trying the app locally.
    sendOtp: (phone, code) => {
      enqueue('otp', phone, { code }, 'Login code');
      if (!wa?.token && config.logOutbound) console.log(`[whatsapp → ${phone}] Login code: ${code}`);
    },
    sendUpdate: (phone, title, body, kind = 'update') => enqueue(kind, phone, { title, body }, `${title}: ${clean(body)}`),
    sendPass: (phone, code, title, body) => enqueue('pass', phone, { code, title, body }, `[QR pass] ${title}: ${clean(body)}`),
    kick,
  };
}
